// H1: a local program (an agent's curl, another process) cannot approve its own requests, read the MCP
// token or change settings, not even when it writes the app's Origin: only the app window has the app
// key (app-key.ts). The server's own tool runs (an outside AI's approved tool, a lead's tool) still can,
// and the MCP endpoint itself stays open.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { injectRequest, isUserOnlyRoute, USER_ONLY_ROUTES } from "./app-tools.js";
import { createServer } from "./server.js";
import { appKey } from "./app-key.js";

const APP = (origin = "tauri://localhost") => ({ origin, "x-sinawi-app": appKey() });

test("user-only routes match their own paths and nothing else", () => {
  assert.ok(isUserOnlyRoute("post", "/api/app-approvals/abc/approve"));
  assert.ok(isUserOnlyRoute("PUT", "/api/settings"));
  assert.ok(isUserOnlyRoute("DELETE", "/api/sessions/x"));
  assert.ok(!isUserOnlyRoute("GET", "/api/settings"), "reading settings is not a decision");
  assert.ok(!isUserOnlyRoute("POST", "/api/sessions"), "starting a chat stays open to MCP and the CLI");
  assert.ok(!isUserOnlyRoute("POST", "/api/app-mcp"));
  assert.ok(!isUserOnlyRoute("DELETE", "/api/sessions/x/extra"), "a parameter is one path segment");
  assert.ok(USER_ONLY_ROUTES.includes("POST /api/permissions/:id/answer"));
  // Express routes ignore case and answer HEAD with GET, so the guard does too.
  assert.ok(isUserOnlyRoute("GET", "/API/App-MCP/Connection"));
  assert.ok(isUserOnlyRoute("POST", "/api/app-approvals/abc/APPROVE"));
  assert.ok(isUserOnlyRoute("HEAD", "/api/app-mcp/connection"));
});

test("without the app key a local request is refused on user-only routes, forged Origin or not; the app and in-process runs pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-user-only-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], appMcp: true });
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const network = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    injectRequest(created.app as never, method, path, body, headers, 10_000, false) as Promise<{ status: number; body: any }>;

  // curl-style: no Origin.
  assert.equal((await network("GET", "/api/app-mcp/connection")).status, 403, "the MCP token is not readable");
  assert.equal((await network("GET", "/api/app-mcp/Connection")).status, 403, "nor with the path in another case");
  assert.equal((await network("GET", "/API/app-mcp/connection")).status, 403);
  assert.equal((await network("HEAD", "/api/app-mcp/connection")).status, 403, "nor with HEAD");
  assert.equal((await network("POST", "/api/app-approvals/any/APPROVE", {})).status, 403);
  assert.equal((await network("PUT", "/api/SETTINGS", {})).status, 403);
  assert.equal((await network("POST", "/api/app-mcp/connection", {})).status, 403);
  assert.equal((await network("POST", "/api/app-approvals/any/approve", {})).status, 403, "no self-approval");
  assert.equal((await network("POST", "/api/permissions/any/answer", { allow: true })).status, 403);
  assert.equal((await network("PUT", "/api/settings", {})).status, 403);
  assert.equal((await network("PATCH", "/api/workspaces/default", { settings: { fullAccess: true, computerUse: true } })).status, 403, "no turning on full access");
  assert.equal((await network("POST", "/api/workspaces", { name: "새 공간", settings: { fullAccess: true } })).status, 403, "nor through a new space");
  assert.equal((await network("PATCH", "/api/workspaces/default", { name: "이름만" })).status, 200, "renaming stays open (rename_workspace)");
  assert.equal((await network("PATCH", "/api/workspaces/default", { settings: { computerUse: false } }, APP())).status, 200);
  assert.equal((await network("GET", "/api/settings")).status, 200, "reading stays open");
  assert.equal((await network("GET", "/api/sessions")).status, 200);
  // Another loopback page is still refused by the older guard.
  assert.equal((await network("POST", "/api/app-mcp/connection", {}, { origin: "http://127.0.0.1:61234" })).status, 403);

  // A forged Origin (the reviewer's curl -H 'Origin: http://127.0.0.1:3001'): still refused.
  for (const origin of ["tauri://localhost", "http://127.0.0.1:3001", "http://127.0.0.1:5188"]) {
    assert.equal((await network("POST", "/api/app-mcp/connection", {}, { origin })).status, 403, `token with forged ${origin}`);
    assert.equal((await network("PATCH", "/api/workspaces/default", { settings: { fullAccess: true } }, { origin })).status, 403, "no full access");
    assert.equal((await network("POST", "/api/app-approvals/any/approve", {}, { origin })).status, 403, "no self-approval");
  }
  // A wrong key, or the key without an app Origin (another browser page), is refused too.
  assert.equal((await network("POST", "/api/app-mcp/connection", {}, { origin: "tauri://localhost", "x-sinawi-app": "x".repeat(43) })).status, 403);
  assert.equal((await network("POST", "/api/app-mcp/connection", {}, { "x-sinawi-app": appKey() })).status, 403);
  assert.equal((await network("POST", "/api/app-mcp/connection", {}, APP("http://127.0.0.1:61234"))).status, 403);
  // Nobody but the installed app's binary collects the key.
  assert.equal((await network("GET", "/api/app-key")).status, 403);
  assert.equal((await network("GET", "/api/app-key", undefined, { origin: "tauri://localhost" })).status, 403);

  // The app window.
  const fromApp = await network("POST", "/api/app-mcp/connection", {}, APP());
  assert.equal(fromApp.status, 200);
  const token = fromApp.body.token as string;
  assert.ok(token);
  assert.equal((await network("POST", "/api/app-approvals/missing/approve", {}, APP())).status, 404, "passes the guard");

  // The server's own run of a tool (what an approved MCP call does).
  assert.equal((await injectRequest(created.app as never, "GET", "/api/app-mcp/connection")).status, 200);

  // The MCP endpoint itself, the way the stdio bridge calls it (no Origin, the token).
  const mcp = await network("POST", "/api/app-mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } }, { authorization: `Bearer ${token}` });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.body.result.isError, undefined, JSON.stringify(mcp.body));
  // A tool behind a user-only route still runs once approved: it becomes an approval card, not a 403.
  const asked = await network("POST", "/api/app-mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_session", arguments: { session_id: "nope" } } }, { authorization: `Bearer ${token}` });
  assert.doesNotMatch(JSON.stringify(asked.body), /앱 화면에서만/u);
});

test("/ws only opens for the app's window (its key), not for a local program, forged Origin or not", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-ws-origin-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const port = (created.httpServer.address() as { port: number }).port;
  const open = (headers: Record<string, string>, protocols: string[] = []) => new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers });
    socket.on("open", () => { socket.close(); resolve("open"); });
    socket.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    socket.on("error", () => resolve("error"));
  });
  assert.equal(await open({}), "403");
  assert.equal(await open({ origin: "http://127.0.0.1:61234" }), "403");
  const origin = `http://127.0.0.1:${process.env.SINAWI_PORT ?? 3001}`;
  assert.equal(await open({ origin }), "403", "a forged Origin alone does not open the live feed");
  assert.equal(await open({ origin }, ["sinawi-app.wrong-key-wrong-key-wrong-key-wrong-key"]), "403");
  assert.equal(await open({}, [`sinawi-app.${appKey()}`]), "403", "the key without an app Origin");
  assert.equal(await open({ origin }, [`sinawi-app.${appKey()}`]), "open");
});
