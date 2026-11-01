import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverMcpTools, setCodexMcpEnabled, updateMcpTool } from "./tools.js";

test("Codex MCP editing changes only enabled in the named table", () => {
  const input = ['model = "gpt-5"', "[mcp_servers.bbanana]", 'url = "https://banana.test/mcp"', "enabled = true # keep", "[mcp_servers.other]", "enabled = true", ""].join("\n");
  const disabled = setCodexMcpEnabled(input, "bbanana", false);
  assert.match(disabled, /\[mcp_servers\.bbanana\][\s\S]*enabled = false # keep/);
  assert.match(disabled, /\[mcp_servers\.other\]\nenabled = true/);
  assert.equal(setCodexMcpEnabled(disabled, "bbanana", false), disabled);
});

test("Codex MCP editing supports quoted names and inserts a missing enabled field", () => {
  const input = '[mcp_servers."banana.tools"]\ncommand = "banana"\n\n[mcp_servers.other]\nenabled = false\n';
  assert.equal(setCodexMcpEnabled(input, "banana.tools", true), '[mcp_servers."banana.tools"]\nenabled = true\ncommand = "banana"\n\n[mcp_servers.other]\nenabled = false\n');
  assert.throws(() => setCodexMcpEnabled(input, "missing", true), /찾을 수 없습니다/);
});

test("Codex MCP editing preserves CRLF, spaced headers, comments, and nested tables", () => {
  const input = [
    'title = "settings"',
    "  [ mcp_servers . \"banana.tools\" ] # tool",
    "# keep this comment",
    'command = "banana"',
    "[mcp_servers.\"banana.tools\".env]",
    'TOKEN = "safe"',
    "[mcp_servers.other]",
    "enabled = true",
    "",
  ].join("\r\n");
  const next = setCodexMcpEnabled(input, "banana.tools", false);
  assert.equal(next, input.replace("# keep this comment\r\n", "enabled = false\r\n# keep this comment\r\n"));
});

test("Codex MCP editing ignores fake headers and enabled assignments inside multiline strings", () => {
  const input = [
    'message = """',
    "[mcp_servers.bbanana]",
    "enabled = true",
    '"""',
    "[mcp_servers.bbanana]",
    'command = "banana"',
    'notes = """enabled = true',
    "still text",
    '"""',
    "[mcp_servers.other]",
    "enabled = true",
    "",
  ].join("\n");
  const next = setCodexMcpEnabled(input, "bbanana", false);
  assert.match(next, /message = """\n\[mcp_servers\.bbanana\]\nenabled = true\n"""/);
  assert.match(next, /\[mcp_servers\.bbanana\]\nenabled = false\ncommand/);
  assert.match(next, /notes = """enabled = true\nstill text\n"""/);
  assert.throws(() => setCodexMcpEnabled('[mcp_servers.bbanana]\nnotes = """unterminated\n', "bbanana", false), /TOML/);
});

test("MCP discovery parses native state, applies app state, and locks the workspace's blocked tools", async () => {
  const runner = async (file: string, args: string[]) => {
    assert.deepEqual(args, ["mcp", "list"]);
    if (file === "codex") return { stdout: "Name URL Status\nbbanana https://codex.test/mcp enabled\n" };
    if (file === "grok") return { stdout: "bbanana https://grok.test/mcp enabled\nsearch search-server disabled\n" };
    return { stdout: "docs: claude-docs - Connected\n" };
  };
  const personal = await discoverMcpTools("personal", { runner, disabledMcp: ["claude:docs"] });
  assert.equal(personal.find((tool) => tool.agent === "claude")?.appEnabled, false);
  assert.equal(personal.find((tool) => tool.name === "search")?.["url/command"], "search-server");
  // No workspace id is special: "company" without a policy locks nothing.
  assert.ok((await discoverMcpTools("company", { runner })).every((tool) => !tool.forcedOff));
  const policy = { mediaGeneration: true, computerUse: false, grokMcp: true, blockedTools: ["bbanana", "claude:docs"], authAlertTools: [] };
  const locked = await discoverMcpTools("team", { runner, policy });
  const banana = locked.filter((tool) => tool.name === "bbanana");
  assert.ok(banana.length >= 2);
  assert.ok(banana.every((tool) => tool.forcedOff && !tool.appEnabled && tool.status === "locked" && /작업 공간 설정/.test(tool.reason ?? "")));
  assert.equal(locked.find((tool) => tool.agent === "claude")?.forcedOff, true);
  assert.equal(locked.find((tool) => tool.name === "search")?.forcedOff, undefined);
});

test("MCP discovery ignores CLI diagnostics and reports Claude connection health separately", async () => {
  const ansi = "\u001b[32m";
  const runner = async (file: string) => {
    if (file === "codex") return { stdout: "Name  URL  Bearer Token Env Var  Status Auth\nNo MCP servers configured.\n" };
    if (file === "grok") return { stdout: "Checking MCP server health...\nName Type URL Enabled\nURL Server Status Enabled\n" };
    return { stdout: [
      "Checking MCP server health...",
      `${ansi}docs: claude-docs - ✓ Connected\u001b[0m`,
      "broken: https://broken.test/mcp - ✗ Failed to connect",
      "offline: offline-command - Disconnected",
      "No MCP servers configured",
    ].join("\n") };
  };
  const tools = await discoverMcpTools("personal", { runner });
  assert.deepEqual(tools.map(({ name }) => name), ["docs", "broken", "offline"]);
  assert.deepEqual(tools.map(({ nativeEnabled }) => nativeEnabled), [true, true, true]);
  assert.deepEqual(tools.map(({ status }) => status), ["connected", "disconnected", "disconnected"]);
  assert.ok(tools.every((tool) => tool.reason?.includes("앱")));
  const disabled = await discoverMcpTools("personal", { runner, disabledMcp: ["claude:docs"] });
  assert.equal(disabled[0].status, "app-disabled");
  assert.equal(disabled[0].nativeEnabled, true);
});

test("MCP discovery retains explicit authentication requirements without flagging ordinary disconnects or OAuth capability", async () => {
  const runner = async (file: string) => {
    if (file === "codex") return { stdout: [
      "Name URL Status Auth",
      "banana https://banana.test/mcp enabled Not logged in",
      "oauth-ready https://oauth.test/mcp enabled OAuth supported",
    ].join("\n") };
    if (file === "grok") return { stdout: [
      "research: https://research.test/mcp (enabled) OAuth: Not logged in",
      "search: https://search.test/mcp (enabled) OAuth supported",
    ].join("\n") };
    return { stdout: [
      "docs: https://docs.test/mcp - ✗ Needs authentication",
      "offline: offline-command - Disconnected",
    ].join("\n") };
  };

  const tools = await discoverMcpTools("personal", { runner });
  for (const name of ["banana", "research", "docs"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.appEnabled, true);
    assert.match(tool?.reason ?? "", /인증 필요/);
  }
  for (const name of ["oauth-ready", "search", "offline"]) {
    assert.doesNotMatch(tools.find((candidate) => candidate.name === name)?.reason ?? "", /인증 필요/);
  }
  assert.equal(tools.find((candidate) => candidate.name === "offline")?.status, "disconnected");
});

test("missing CLIs are handled without rejecting discovery", async () => {
  assert.deepEqual(await discoverMcpTools("personal", { runner: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), []);
});

test("MCP updates use fixed executable argument arrays and atomically edit Codex config", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-tools-home-"));
  const config = join(home, "config.toml");
  await writeFile(config, "[mcp_servers.bbanana]\nenabled = true\n");
  const calls: Array<[string, string[]]> = [];
  const runner = async (file: string, args: string[]) => { calls.push([file, args]); return { stdout: "" }; };
  try {
    await updateMcpTool({ agent: "grok", name: "safe-name", enabled: false }, { runner, codexConfigPath: config });
    assert.deepEqual(calls, [["grok", ["mcp", "disable", "safe-name"]]]);
    await updateMcpTool({ agent: "codex", name: "bbanana", enabled: false }, { runner, codexConfigPath: config });
    assert.match(await readFile(config, "utf8"), /enabled = false/);
    await assert.rejects(updateMcpTool({ agent: "grok", name: "bad;name", enabled: true }, { runner }), /도구 이름/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("MCP discovery keeps full names with colons/spaces and explains auth", async () => {
  const runner = async (file: string) => {
    if (file === "claude") return { stdout: [
      "claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication",
      "plugin:design:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication",
      "plugin:design:google calendar:  (HTTP) - - Not configured",
      "plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected",
    ].join("\n") };
    if (file === "codex") return { stdout: [
      "Name     Url                                Bearer Token Env Var  Status   Auth         ",
      "bbanana  https://www.bbanana.ai/mcp         -                     enabled  OAuth        ",
      "stitch   https://stitch.googleapis.com/mcp  -                     enabled  Not logged in",
    ].join("\n") };
    return { stdout: "  figma: https://mcp.figma.com/mcp\n  bbanana: https://www.bbanana.ai/mcp" };
  };
  const tools = await discoverMcpTools("personal", { runner });
  const slack = tools.find((t) => t.name === "plugin:design:slack");
  assert.equal(slack?.needsAuth, true);
  assert.equal(slack?.displayName, "Slack(design 플러그인)");
  assert.match(slack?.authCommand ?? "", /\/mcp 입력 → plugin:design:slack 선택 → Authenticate'.*&& claude$/);
  assert.equal(tools.find((t) => t.name === "claude.ai Notion")?.displayName, "Notion(claude.ai)");
  assert.ok(tools.some((t) => t.name === "plugin:design:google calendar"));
  assert.ok(!tools.some((t) => t.name === "plugin"));
  const stitch = tools.find((t) => t.agent === "codex" && t.name === "stitch");
  assert.equal(stitch?.needsAuth, true);
  assert.match(stitch?.authCommand ?? "", /codex mcp login 'stitch'$/);
  assert.equal(tools.find((t) => t.agent === "codex" && t.name === "bbanana")?.needsAuth, undefined);
  assert.deepEqual(tools.filter((t) => t.agent === "grok").map((t) => t.name), ["figma", "bbanana"]);
});
