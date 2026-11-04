import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectRequest } from "./app-tools.js";
import { appMcpTokenPath } from "./app-mcp.js";
import { mcpClientConfigPath } from "./mcp-clients.js";
import { createServer } from "./server.js";

// Every config path points into a temp folder: the real Claude Desktop and Cursor configs are never read.
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-mcp-clients-"));
  const claude = join(directory, "Claude", "claude_desktop_config.json");
  const cursor = join(directory, "cursor", "mcp.json");
  const saved = { claude: process.env.SINAWI_CLAUDE_DESKTOP_CONFIG, cursor: process.env.SINAWI_CURSOR_MCP_CONFIG };
  process.env.SINAWI_CLAUDE_DESKTOP_CONFIG = claude;
  process.env.SINAWI_CURSOR_MCP_CONFIG = cursor;
  const data = join(directory, "data");
  const created = createServer({ dataDir: data, modelHomeDir: directory, staticDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => {
    created.httpServer.close(); created.websocket.close();
    process.env.SINAWI_CLAUDE_DESKTOP_CONFIG = saved.claude; process.env.SINAWI_CURSOR_MCP_CONFIG = saved.cursor;
    if (saved.claude === undefined) delete process.env.SINAWI_CLAUDE_DESKTOP_CONFIG;
    if (saved.cursor === undefined) delete process.env.SINAWI_CURSOR_MCP_CONFIG;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers) as Promise<{ status: number; body: any }>;
  const fromApp = { origin: "http://127.0.0.1:5198" };
  return { directory, data, claude, cursor, call, fromApp };
}

test("the client config paths default to Claude Desktop's and Cursor's own files and can be moved for tests", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SINAWI_CLAUDE_DESKTOP_CONFIG; delete process.env.SINAWI_CURSOR_MCP_CONFIG;
    assert.match(mcpClientConfigPath("claude"), /Library\/Application Support\/Claude\/claude_desktop_config\.json$/u);
    assert.match(mcpClientConfigPath("cursor"), /\/\.cursor\/mcp\.json$/u);
    process.env.SINAWI_CLAUDE_DESKTOP_CONFIG = "/tmp/a.json";
    assert.equal(mcpClientConfigPath("claude"), "/tmp/a.json");
  } finally {
    process.env.SINAWI_CLAUDE_DESKTOP_CONFIG = saved.SINAWI_CLAUDE_DESKTOP_CONFIG ?? "";
    if (saved.SINAWI_CLAUDE_DESKTOP_CONFIG === undefined) delete process.env.SINAWI_CLAUDE_DESKTOP_CONFIG;
    if (saved.SINAWI_CURSOR_MCP_CONFIG !== undefined) process.env.SINAWI_CURSOR_MCP_CONFIG = saved.SINAWI_CURSOR_MCP_CONFIG;
  }
});

test("connect to Claude Desktop: preview, then merge the sinawi entry, keep everything else and back up the original", async (t) => {
  const { claude, data, call, fromApp } = await fixture(t);
  await mkdir(join(claude, ".."), { recursive: true });
  const original = { globalShortcut: "Alt+Space", mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "keep-me" } } } };
  await writeFile(claude, JSON.stringify(original));

  const preview = await call("GET", "/api/app-mcp/clients/claude");
  assert.equal(preview.status, 200, preview.body.error);
  assert.equal(preview.body.name, "Claude Desktop");
  assert.equal(preview.body.path, claude);
  assert.equal(preview.body.exists, true);
  assert.equal(preview.body.replaces, false);
  const entry = preview.body.entry;
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args[0], join(data, "hooks", "sinawi-mcp.mjs"), "the app's copy of the bridge");
  assert.equal(entry.env.SINAWI_MCP_TOKEN_FILE, appMcpTokenPath(data), "the token file, not the token");
  assert.equal(entry.env.SINAWI_MCP_TOKEN, undefined, "no secret is copied into another app's config");
  assert.deepEqual(JSON.parse(preview.body.merge), { mcpServers: { sinawi: entry } }, "the dialog shows exactly what is merged");
  assert.equal(JSON.parse(await readFile(claude, "utf8")).mcpServers.sinawi, undefined, "a preview writes nothing");

  const written = await call("POST", "/api/app-mcp/clients/claude", { merge: preview.body.merge }, fromApp);
  assert.equal(written.status, 200, written.body.error);
  assert.equal(written.body.backup, `${claude}.bak`);
  assert.deepEqual(JSON.parse(await readFile(`${claude}.bak`, "utf8")), original, "the original is backed up as is");
  const after = JSON.parse(await readFile(claude, "utf8"));
  assert.equal(after.globalShortcut, "Alt+Space", "other keys stay");
  assert.deepEqual(after.mcpServers.github, original.mcpServers.github, "other servers stay");
  assert.deepEqual(after.mcpServers.sinawi, entry);
  assert.equal((await stat(claude)).mode & 0o777, 0o600);

  const again = await call("GET", "/api/app-mcp/clients/claude");
  assert.equal(again.body.replaces, true);
  assert.equal(again.body.upToDate, true);
});

test("connect to Cursor creates ~/.cursor/mcp.json when it is missing", async (t) => {
  const { cursor, call, fromApp } = await fixture(t);
  const preview = await call("GET", "/api/app-mcp/clients/cursor");
  assert.equal(preview.body.exists, false);
  assert.equal(preview.body.name, "Cursor");
  const written = await call("POST", "/api/app-mcp/clients/cursor", { merge: preview.body.merge }, fromApp);
  assert.equal(written.status, 200, written.body.error);
  assert.equal(written.body.backup, null, "nothing to back up");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cursor, "utf8")).mcpServers), ["sinawi"]);
});

test("writing a client config needs the app's own window and the JSON the user confirmed; broken files are left alone", async (t) => {
  const { claude, call, fromApp } = await fixture(t);
  const preview = await call("GET", "/api/app-mcp/clients/claude");
  const body = { merge: preview.body.merge };
  assert.equal((await call("POST", "/api/app-mcp/clients/claude", body)).status, 403, "no Origin: a CLI or an agent's shell");
  assert.equal((await call("POST", "/api/app-mcp/clients/claude", body, { origin: "http://127.0.0.1:4000" })).status, 403, "another local page");
  assert.equal((await call("POST", "/api/app-mcp/clients/claude", { merge: "{}" }, fromApp)).status, 409, "not what was shown");
  assert.equal((await call("POST", "/api/app-mcp/clients/claude", {}, fromApp)).body.code, "stale");
  assert.equal((await call("GET", "/api/app-mcp/clients/vscode")).status, 404);
  await assert.rejects(readFile(claude, "utf8"), "nothing was written");

  await mkdir(join(claude, ".."), { recursive: true });
  await writeFile(claude, "{ not json");
  const broken = await call("GET", "/api/app-mcp/clients/claude");
  assert.equal(broken.status, 409);
  assert.equal(broken.body.code, "invalid_json");
  assert.equal((await call("POST", "/api/app-mcp/clients/claude", body, fromApp)).body.code, "invalid_json");
  assert.equal(await readFile(claude, "utf8"), "{ not json", "a file Sinawi cannot read is not overwritten");
  await writeFile(claude, JSON.stringify({ mcpServers: [] }));
  assert.equal((await call("GET", "/api/app-mcp/clients/claude")).body.code, "bad_servers");
});

test("no MCP tool can connect a client: the routes are excluded from both surfaces", async () => {
  const { APP_TOOLS, ROUTE_EXCLUSIONS } = await import("./app-tools.js");
  for (const route of ["GET /api/app-mcp/clients/:client", "POST /api/app-mcp/clients/:client"]) assert.ok(ROUTE_EXCLUSIONS[route], route);
  assert.ok(!APP_TOOLS.some((tool) => tool.routes.some((route) => route.includes("/api/app-mcp/clients"))));
});
