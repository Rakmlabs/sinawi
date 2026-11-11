import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_TOOLS, checkedArgs, handleToolMcp, injectRequest, MAX_TOOL_RESULT_CHARS, withoutLaunchDetails, type ToolContext } from "./app-tools.js";
import { appMcpTokenPath, ensureAppMcpToken, rotateAppMcpToken } from "./app-mcp.js";
import { ApprovalStore } from "./app-approvals.js";
import { createServer } from "./server.js";
import { notesPath, stewardDir } from "./steward.js";
import type { Session } from "./types.js";

async function tempDir(t: test.TestContext, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const tool = (name: string) => APP_TOOLS.find((item) => item.name === name)!;

/** Runs a tool against a fake dispatch and returns the body the route would get. */
async function sentBody(name: string, args: Record<string, unknown>) {
  let body: any;
  const ctx: ToolContext = { workspaceId: "default", dispatch: async (_method, _path, given) => { body = given; return { id: "x" }; } };
  await tool(name).run(args, ctx);
  return body;
}

test("AI-made chats and bot conversations always name a mode, so a full-access workspace does not hand them full access", async () => {
  assert.equal((await sentBody("create_session", { cwd: "/tmp", prompt: "hi" })).permissionMode, "auto");
  assert.equal((await sentBody("create_session", { cwd: "/tmp", prompt: "hi", permission_mode: "plan" })).permissionMode, "plan");
  await assert.rejects(sentBody("create_session", { cwd: "/tmp", permission_mode: "full" }), /plan 또는 auto/u);
  assert.equal((await sentBody("start_bot_conversation", { bot_a: "a", bot_b: "b", prompt: "p", turns: 1, cwd: "/tmp" })).permissionMode, "auto");
});

test("create_session over the external MCP in a full-access workspace stores auto, not the workspace's full", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-mcp-hardening-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, staticDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await new Promise((resolve) => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true }); });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers) as Promise<{ status: number; body: any }>;
  const workspace = (await call("GET", "/api/workspaces")).body.currentWorkspaceId as string;
  assert.equal((await call("PATCH", "/api/workspaces", { workspaceId: workspace, settings: { fullAccess: true } })).status, 200);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  const answer = await call("POST", "/api/app-mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_session", arguments: { cwd: directory, title: "AI 채팅" } } }, { authorization: `Bearer ${token}` });
  assert.notEqual(answer.body.result.isError, true, answer.body.result.content?.[0]?.text);
  const id = JSON.parse(answer.body.result.content[0].text).id as string;
  const session = ((await call("GET", "/api/sessions")).body as Session[]).find((item) => item.id === id)!;
  assert.equal(session.permissionMode, "auto");
});

test("list_tools does not give an AI the MCP servers' command lines or URLs (they can hold keys)", () => {
  const cleaned = withoutLaunchDetails({ mcp: [{ agent: "codex", name: "x", "url/command": "npx srv --api-key SECRET", command: "npx", url: "https://h/?token=SECRET", status: "enabled" }], skills: [{ name: "s" }] }) as any;
  assert.deepEqual(cleaned.mcp, [{ agent: "codex", name: "x", status: "enabled" }]);
  assert.deepEqual(cleaned.skills, [{ name: "s" }]);
  assert.ok(!JSON.stringify(cleaned).includes("SECRET"));
});

test("the external token: concurrent first uses agree on one token, the file is 0600 and a loose one is tightened", async (t) => {
  const directory = await tempDir(t, "sinawi-mcp-token-");
  const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureAppMcpToken(directory)));
  assert.equal(new Set(tokens).size, 1, "every caller sees the token that is on disk");
  assert.equal((await readFile(appMcpTokenPath(directory), "utf8")).trim(), tokens[0]);
  assert.equal((await stat(appMcpTokenPath(directory))).mode & 0o777, 0o600);

  await chmod(appMcpTokenPath(directory), 0o644);
  assert.equal(await ensureAppMcpToken(directory), tokens[0]);
  assert.equal((await stat(appMcpTokenPath(directory))).mode & 0o777, 0o600);

  await chmod(appMcpTokenPath(directory), 0o644);
  const rotated = await rotateAppMcpToken(directory);
  assert.notEqual(rotated, tokens[0]);
  assert.equal((await stat(appMcpTokenPath(directory))).mode & 0o777, 0o600, "a rotated token is not left readable by others");
});

test("an approval is on disk as decided before its tool runs, so a restart cannot run it a second time", async (t) => {
  const directory = await tempDir(t, "sinawi-approvals-");
  const store = new ApprovalStore(directory);
  const item = await store.create({ tool: "delete_session", args: { session_id: "s" }, summary: "삭제", source: "external", workspaceId: "default" });
  let onDisk: string | undefined;
  await store.decide(item.id, true, async () => {
    const saved = JSON.parse(await readFile(join(directory, "app-approvals.json"), "utf8")) as Array<{ id: string; status: string }>;
    onDisk = saved.find((entry) => entry.id === item.id)?.status;
    return "ok";
  });
  assert.equal(onDisk, "approved");
  const restarted = new ApprovalStore(directory);
  await assert.rejects(restarted.decide(item.id, true, async () => assert.fail("must not run again")), /이미 처리된/u);
});

test("two approvals of one request at once run the tool once", async (t) => {
  const directory = await tempDir(t, "sinawi-approvals-race-");
  const store = new ApprovalStore(directory);
  const item = await store.create({ tool: "delete_session", args: {}, summary: "삭제", source: "external", workspaceId: "default" });
  let runs = 0;
  const results = await Promise.allSettled([store.decide(item.id, true, async () => { runs += 1; }), store.decide(item.id, true, async () => { runs += 1; })]);
  assert.equal(runs, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("a lead's folder stays under <data>/stewards whatever ID stored data holds", async (t) => {
  const directory = await tempDir(t, "sinawi-steward-dir-");
  assert.equal(stewardDir(directory, "lead-1"), join(directory, "stewards", "lead-1"));
  for (const bad of ["..", "../x", "a/../../b", "a/b", "", ".hidden/..", "x\\y"]) assert.throws(() => stewardDir(directory, bad), /담당 ID/u, bad);
  await writeFile(join(directory, "probe"), "");
  assert.throws(() => notesPath(directory, "../../probe"));
});

test("the same request sent twice while it waits is one approval card", async (t) => {
  const directory = await tempDir(t, "sinawi-approvals-dedupe-");
  const store = new ApprovalStore(directory);
  const input = { tool: "delete_session", args: { session_id: "s" }, summary: "삭제", source: "external" as const, workspaceId: "default" };
  const first = await store.create(input);
  assert.equal((await store.create({ ...input, args: { session_id: "s" } })).id, first.id);
  assert.notEqual((await store.create({ ...input, args: { session_id: "other" } })).id, first.id);
  await store.decide(first.id, false, async () => undefined);
  assert.notEqual((await store.create(input)).id, first.id, "a decided request can be asked again");
});

test("a tool call with an unknown or missing argument fails with the names the tool takes, before anything runs", async () => {
  const collect = APP_TOOLS.find((tool) => tool.name === "collect_results")!;
  assert.deepEqual(checkedArgs(collect, { wait: true, timeout_s: "2400" }), { wait: true, timeout_sec: "2400" }, "a common misspelling is the real argument");
  assert.throws(() => checkedArgs(collect, { wait: true, forever: true }), /없는 인자입니다: forever.*timeout_sec/u);
  let ran = false;
  const answer = await handleToolMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_session", arguments: {} } }, "external", "sinawi", async () => { ran = true; }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(ran, false, "no approval card for a request that cannot run");
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /필요한 인자가 빠졌습니다: session_id/u);
});

test("a huge tool result is cut with a note instead of flooding the caller", async () => {
  const answer = await handleToolMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } }, "external", "sinawi", async () => "가".repeat(MAX_TOOL_RESULT_CHARS + 500)) as { result: { content: Array<{ text: string }> } };
  assert.match(answer.result.content[0].text, /\[잘림: 전체 80500자/u);
  const hello = await handleToolMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, "external", "sinawi", async () => undefined) as { result: { protocolVersion: string; instructions?: string } };
  assert.equal(hello.result.protocolVersion, "2025-06-18", "an unknown protocol version is answered with one the server speaks");
  assert.match(hello.result.instructions ?? "", /pending_approval/u);
});
