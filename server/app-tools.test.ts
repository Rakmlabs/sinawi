import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_TOOLS, injectRequest, LEAD_TOOL_NAMES, nameLookup, namedLabel, ROUTE_EXCLUSIONS, toolsFor } from "./app-tools.js";
import { appMcpTokenPath } from "./app-mcp.js";
import { approvalRequester } from "./app-approvals.js";
import { withJosa } from "./korean.js";
import { issueComputerToken, revokeComputerToken } from "./computer-tokens.js";
import { createServer, withWorkspaceTeam } from "./server.js";
import { saveSessions } from "./store.js";
import type { Session } from "./types.js";

type Created = ReturnType<typeof createServer>;

async function fixture(t: test.TestContext, sessions: Session[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-app-tools-"));
  if (sessions.length) await saveSessions(sessions, directory);
  const created = createServer({ dataDir: directory, modelHomeDir: directory, staticDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await new Promise((resolve) => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true }); });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers) as Promise<{ status: number; body: any }>;
  return { directory, ...created, call };
}

/** Every route the real server registers, as "METHOD /path". */
function registeredRoutes(app: Created["app"]): string[] {
  const stack = (app as unknown as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }).router.stack;
  return [...new Set(stack.flatMap((layer) => layer.route ? Object.keys(layer.route.methods).filter((method) => method !== "_all").map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []))];
}

const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const toolCall = (id: number, name: string, args: object = {}) => rpc(id, "tools/call", { name, arguments: args });
const parsed = (response: { body: any }) => JSON.parse(response.body.result.content[0].text);

/** Notifications are saved in the background: waits a moment for one to land. */
async function noteWithKey(call: (method: string, path: string) => Promise<{ body: any }>, key: string) {
  for (let tries = 0; tries < 50; tries += 1) {
    const found = ((await call("GET", "/api/notifications")).body as Array<{ key?: string; body: string }>).find((item) => item.key === key);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no notification ${key}`);
}

test("every server route has a tool or an explicit exclusion with a reason, and nothing points at a missing route", async (t) => {
  const { app } = await fixture(t);
  const routes = registeredRoutes(app);
  assert.ok(routes.length > 90, `expected the whole API, got ${routes.length}`);
  const covered = new Set(APP_TOOLS.flatMap((tool) => tool.routes));
  const missing = routes.filter((route) => !covered.has(route) && !(route in ROUTE_EXCLUSIONS));
  assert.deepEqual(missing, [], "routes without a tool or an exclusion");
  const known = new Set(routes);
  assert.deepEqual([...covered].filter((route) => !known.has(route)), [], "tools pointing at routes the server does not have");
  assert.deepEqual(Object.keys(ROUTE_EXCLUSIONS).filter((route) => !known.has(route)), [], "stale exclusions");
  assert.deepEqual(Object.keys(ROUTE_EXCLUSIONS).filter((route) => covered.has(route)), [], "a route is both a tool and excluded");
  for (const [route, reason] of Object.entries(ROUTE_EXCLUSIONS)) assert.ok(reason.trim().length > 5, `${route} needs a reason`);
});

test("tools are described for an AI to choose from, with object schemas and unique names", () => {
  for (const surface of ["lead", "external"] as const) {
    const names = toolsFor(surface).map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, `${surface} tool names are unique`);
  }
  for (const tool of APP_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{2,63}$/u, tool.name);
    assert.ok(tool.description.length >= 15, `${tool.name} has a real description`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of (tool.inputSchema.required as string[] | undefined) ?? []) assert.ok(key in properties, `${tool.name}.${key} is required but not described`);
    if (tool.risk === "approval") assert.ok(tool.summary, `${tool.name} says on the card what it will do`);
    if (tool.routes.length === 0) assert.ok(LEAD_TOOL_NAMES.includes(tool.name), `${tool.name} needs a route or to be a lead tool`);
  }
  // Destructive and settings tools wait for the user.
  for (const name of ["delete_session", "delete_lead", "delete_workspace", "delete_group", "approve_merge", "reject_merge", "update_routing_settings", "set_user_preferences", "update_workspace_settings", "stop_session", "schedule_delete", "run_in_terminal", "move_session_to_workspace", "move_group_to_workspace"]) {
    assert.equal(APP_TOOLS.find((tool) => tool.name === name)?.risk, "approval", name);
  }
  for (const name of ["list_sessions", "get_session_summary", "create_session", "send_message", "create_lead", "create_group"]) {
    assert.notEqual(APP_TOOLS.find((tool) => tool.name === name)?.risk, "approval", name);
  }
});

test("the external MCP endpoint refuses a missing or wrong token and answers with the right one", async (t) => {
  const { call, directory } = await fixture(t);
  assert.equal((await call("POST", "/api/app-mcp", rpc(1, "tools/list"))).status, 401, "no token");
  assert.equal((await call("POST", "/api/app-mcp", rpc(1, "tools/list"), { authorization: "Bearer wrong" })).status, 401, "wrong token");
  assert.equal((await call("POST", "/api/app-mcp", rpc(1, "tools/list"), { "x-sinawi-mcp-token": "x".repeat(64) })).status, 401, "wrong token of the right length");
  const token = (await readFile(appMcpTokenPath(directory), "utf8")).trim();
  assert.equal(((await stat(appMcpTokenPath(directory))).mode & 0o777), 0o600, "token file is private");
  const listed = await call("POST", "/api/app-mcp", rpc(1, "tools/list"), { authorization: `Bearer ${token}` });
  assert.equal(listed.status, 200);
  const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes("list_sessions") && names.includes("delete_session") && names.includes("create_lead_schedule"));
  for (const lead of LEAD_TOOL_NAMES) assert.ok(!names.includes(lead), `${lead} needs a lead's turn and is not offered outside`);
  const remove = listed.body.result.tools.find((tool: { name: string }) => tool.name === "delete_session");
  assert.equal(remove.annotations.destructiveHint, true);
  assert.match(remove.description, /pending_approval/u);

  // A lead run's token is not the external token.
  const runToken = issueComputerToken({ sessionId: "s", workspaceId: "default", agent: "codex", owner: "s:orchestrator" });
  t.after(() => revokeComputerToken(runToken));
  assert.equal((await call("POST", "/api/app-mcp", rpc(1, "tools/list"), { authorization: `Bearer ${runToken}` })).status, 401);

  // Rotating the token from the settings page locks out the old one.
  const connection = await call("GET", "/api/app-mcp/connection");
  assert.equal(connection.body.token, token);
  assert.equal(connection.body.config.mcpServers.sinawi.env.SINAWI_MCP_TOKEN, token);
  const rotated = await call("POST", "/api/app-mcp/token");
  assert.notEqual(rotated.body.token, token);
  assert.equal((await call("POST", "/api/app-mcp", rpc(2, "tools/list"), { authorization: `Bearer ${token}` })).status, 401, "old token");
  assert.equal((await call("POST", "/api/app-mcp", rpc(2, "tools/list"), { authorization: `Bearer ${rotated.body.token}` })).status, 200, "new token");
});

test("reads and creations run at once; a delete waits for approval, then runs on approve and not on reject", async (t) => {
  const { call, directory } = await fixture(t);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  const mcp = (body: object) => call("POST", "/api/app-mcp", body, { authorization: `Bearer ${token}` });

  const made = parsed(await mcp(toolCall(1, "create_group", { name: "백엔드" })));
  assert.equal(made.name, "백엔드");
  const other = parsed(await mcp(toolCall(2, "create_group", { name: "프론트" })));
  assert.equal((await call("GET", "/api/groups")).body.length, 2, "created right away");

  const pending = parsed(await mcp(toolCall(3, "delete_group", { group_id: made.id })));
  assert.equal(pending.status, "pending_approval");
  assert.ok(pending.approvalId);
  assert.equal((await call("GET", "/api/groups")).body.length, 2, "nothing deleted before the user approves");
  const waiting = (await call("GET", "/api/app-approvals?status=pending")).body.approvals;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].tool, "delete_group");
  assert.match(waiting[0].summary, /삭제/u);
  const notes = (await call("GET", "/api/notifications")).body;
  assert.ok(notes.some((note: { key?: string; type: string }) => note.key === `approval:${pending.approvalId}` && note.type === "permission"), "the user is notified");

  const approved = await call("POST", `/api/app-approvals/${pending.approvalId}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.deepEqual((await call("GET", "/api/groups")).body.map((group: { id: string }) => group.id), [other.id], "deleted on approval");
  assert.equal((await call("POST", `/api/app-approvals/${pending.approvalId}/approve`)).status, 409, "runs once");
  const after = (await call("GET", "/api/notifications")).body;
  assert.ok(!after.some((note: { key?: string }) => note.key === `approval:${pending.approvalId}`), "the waiting notice is resolved");
  assert.ok(after.some((note: { key?: string }) => note.key === `approval-result:${pending.approvalId}`), "the result is recorded");

  const second = parsed(await mcp(toolCall(4, "delete_group", { group_id: other.id })));
  const rejected = await call("POST", `/api/app-approvals/${second.approvalId}/reject`);
  assert.equal(rejected.body.status, "rejected");
  assert.equal((await call("GET", "/api/groups")).body.length, 1, "a rejected delete never runs");
  const status = parsed(await mcp(toolCall(5, "list_approvals", { approval_id: second.approvalId })));
  assert.equal(status.approvals[0].status, "rejected", "the AI can read the outcome");

  // An approved call that fails is recorded as failed with the route's reason.
  const missing = parsed(await mcp(toolCall(6, "delete_group", { group_id: "nope" })));
  const failed = await call("POST", `/api/app-approvals/${missing.approvalId}/approve`);
  assert.equal(failed.body.status, "failed");
  assert.match(failed.body.error, /그룹을 찾을 수 없습니다/u);
  assert.equal((await call("POST", "/api/app-approvals/none/approve")).status, 404);

  // Kept across a restart.
  const saved = JSON.parse(await readFile(join(directory, "app-approvals.json"), "utf8"));
  assert.equal(saved.length, 3);
});

test("app tools reuse the routes' validation and return what the AI needs", async (t) => {
  const { call, directory } = await fixture(t);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  const mcp = (body: object) => call("POST", "/api/app-mcp", body, { authorization: `Bearer ${token}` });
  const bad = await mcp(toolCall(1, "rename_session", { session_id: "none", title: "x" }));
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /세션을 찾을 수 없습니다/u, "the route's own error");
  const full = await mcp(toolCall(2, "create_session", { prompt: "x", agent: "codex", cwd: directory, permission_mode: "full" }));
  assert.equal(full.body.result.isError, true, "full access is never granted by an AI");
  const policy = await mcp(toolCall(3, "create_lead", { name: "api", merge_policy: "auto" }));
  assert.equal(policy.body.result.isError, true, "auto-merge needs update_lead and the user's approval");
  const lead = parsed(await mcp(toolCall(4, "create_lead", { name: "api", cwds: [directory] })));
  assert.equal(lead.mergePolicy, "ask");
  const schedule = parsed(await mcp(toolCall(5, "create_lead_schedule", { lead_id: lead.id, prompt: "점검", cron: "0 9 * * *" })));
  assert.equal(schedule.createdBy, "user");
  assert.deepEqual(parsed(await mcp(toolCall(6, "list_sessions"))), []);
  const workspaces = parsed(await mcp(toolCall(7, "list_workspaces")));
  assert.equal(workspaces.currentWorkspaceId, "default");
  assert.equal((await mcp(toolCall(8, "rm_rf"))).body.error.code, -32602);
});

test("a lead's run gets the lead tools and the app tools; its approvals land in its chat", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-app-tools-lead-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lead: Session = {
    id: "lead-1", title: "담당", agent: "codex", workers: ["claude"], cwd, status: "done", createdAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "default", skills: [], events: [], steward: { turns: 1, since: "2026-01-01T00:00:00.000Z", name: "api" },
  };
  const { call } = await fixture(t, [lead]);
  await call("GET", "/api/stewards");
  const token = issueComputerToken({ sessionId: "lead-1", workspaceId: "default", agent: "codex", owner: "lead-1:orchestrator" });
  t.after(() => revokeComputerToken(token));
  const mcp = (body: object) => call("POST", "/api/lead-mcp", body, { "x-sinawi-token": token });
  const names = (await mcp(rpc(1, "tools/list"))).body.result.tools.map((tool: { name: string }) => tool.name);
  for (const name of [...LEAD_TOOL_NAMES, "list_sessions", "create_session", "list_leads", "approve_merge", "get_user_preferences"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("create_lead_schedule"), "a lead uses its own schedule_* tools");

  const made = parsed(await mcp(toolCall(2, "schedule_create", { prompt: "점검", cron: "0 9 * * *" })));
  const pending = parsed(await mcp(toolCall(3, "schedule_delete", { id: made.id })));
  assert.equal(pending.status, "pending_approval");
  const stewardId = (await call("GET", "/api/stewards")).body[0].id;
  assert.equal((await call("GET", `/api/stewards/${stewardId}/schedules`)).body.length, 1, "not deleted yet");
  const chat = () => call("GET", "/api/sessions").then((res) => res.body.find((item: Session) => item.id === "lead-1") as Session);
  assert.ok((await chat()).events.some((event) => /승인 대기/u.test(event.text)), "the wait shows in the lead's chat");
  const card = (await call("GET", "/api/app-approvals?status=pending")).body.approvals[0];
  assert.equal(card.requester, "api", "the card names the lead");
  assert.equal(card.sessionTitle, "담당");
  assert.equal(withJosa(approvalRequester(card), "이/가"), "담당 'api'가", "the notice names the lead with the right particle");
  const approved = await call("POST", `/api/app-approvals/${pending.approvalId}/approve`);
  assert.equal(approved.body.status, "approved", approved.body.error);
  assert.equal((await call("GET", `/api/stewards/${stewardId}/schedules`)).body.length, 0, "deleted after approval");
  assert.ok((await chat()).events.some((event) => /승인되어 실행했습니다/u.test(event.text)), "the result is an event in the chat");
});

test("scripts/sinawi-mcp.mjs speaks stdio MCP to the app with the token, and says so when the token is missing", async (t) => {
  const { httpServer, directory, call } = await fixture(t);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  const port = (httpServer.address() as { port: number }).port;
  const session = async (env: Record<string, string>, messages: object[]) => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts", "sinawi-mcp.mjs")], { env: { PATH: process.env.PATH ?? "", HOME: directory, SINAWI_URL: `http://127.0.0.1:${port}`, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    const lines: any[] = [];
    const lineReader = createInterface({ input: child.stdout! });
    const done = new Promise<void>((resolve) => lineReader.on("line", (line) => { lines.push(JSON.parse(line)); if (lines.length === messages.length) resolve(); }));
    for (const message of messages) child.stdin!.write(`${JSON.stringify(message)}\n`);
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("no answer from sinawi-mcp")), 5_000))]);
    child.kill();
    return lines.sort((a, b) => a.id - b.id);
  };
  const [init, list] = await session({ SINAWI_MCP_TOKEN: token }, [rpc(1, "initialize", { protocolVersion: "2025-06-18" }), rpc(2, "tools/list")]);
  assert.equal(init.result.serverInfo.name, "sinawi");
  assert.ok(list.result.tools.some((tool: { name: string }) => tool.name === "list_sessions"));
  const [denied] = await session({ SINAWI_MCP_TOKEN: "wrong" }, [rpc(1, "tools/list")]);
  assert.match(denied.error.message, /토큰/u);
  const [fromFile] = await session({ SINAWI_DATA_DIR: directory }, [rpc(1, "tools/list")]);
  assert.ok(fromFile.result.tools.length > 50, "reads the token from the data folder when none is given");
});

test("create_session without a prompt opens an empty chat; without workers it takes the workspace's team", async (t) => {
  const { call, directory } = await fixture(t);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  const mcp = (body: object) => call("POST", "/api/app-mcp", body, { authorization: `Bearer ${token}` });
  const empty = await mcp(toolCall(1, "create_session", { cwd: directory, title: "나중에 쓸 채팅" }));
  assert.notEqual(empty.body.result.isError, true, empty.body.result.content?.[0]?.text);
  const row = parsed(empty);
  assert.equal(row.title, "나중에 쓸 채팅");
  assert.equal(row.status, "done", "nothing runs until a message comes");
  const sessions = (await call("GET", "/api/sessions")).body as Session[];
  const made = sessions.find((item) => item.id === row.id)!;
  assert.ok(made, "the chat is listed for the UI");
  assert.equal(made.agent, "claude", "no agent: the workspace's default lead");
  assert.ok(made.workers.length >= 1, "no workers: the allowed agents");
  assert.ok(!made.events.some((event) => event.agent === "user"), "no first message");
  assert.equal((await call("POST", "/api/sessions", { cwd: directory })).status, 201, "the API takes an empty chat too");

  // The workspace's own default team comes before 'every allowed agent'.
  await call("PATCH", "/api/workspaces", { workspaceId: "default", defaults: { agent: "codex", workers: ["grok"] } });
  const team = (await call("POST", "/api/sessions", { cwd: directory, workers: [] })).body as Session;
  assert.equal(team.agent, "codex");
  assert.deepEqual(team.workers, ["grok"]);
});

test("withWorkspaceTeam fills only the gaps: picked workers, then the default team, then the allowed agents", () => {
  const base = { prompt: "", cwd: "/tmp", agent: "codex" as const };
  assert.deepEqual(withWorkspaceTeam({ ...base, workers: ["claude"] }, { workers: ["grok"] }, ["claude", "codex", "grok"]).workers, ["claude"]);
  assert.deepEqual(withWorkspaceTeam({ ...base, workers: [] }, { workers: ["grok"] }, ["claude", "codex", "grok"]).workers, ["grok"]);
  assert.deepEqual(withWorkspaceTeam({ ...base, workers: [] }, { workers: ["codex"] }, ["claude", "grok"]).workers, ["claude", "grok"], "a default the workspace no longer allows is skipped");
  const lead = withWorkspaceTeam({ ...base, agent: undefined as never, steward: { id: "s1" } }, { agent: "grok" }, ["claude", "grok"]);
  assert.equal(lead.agent, undefined, "a lead's thread keeps its gap for the lead's own agent");
  assert.deepEqual(lead.workers, ["claude", "grok"]);
  assert.equal(withWorkspaceTeam({ ...base, agent: undefined as never }, { agent: "grok" }, ["claude", "grok"]).agent, "grok");
});

test("approval lines name chats, leads and workspaces, with the ID only as a hint", async (t) => {
  assert.equal(namedLabel("API 정리", "3f2a9c1e-0000-4000-8000-000000000000"), "'API 정리' (3f2a9c1e)");
  assert.equal(namedLabel(undefined, "abc"), "abc");
  const names = nameLookup({ session: (id) => id === "s1" ? "로그인" : undefined });
  const tool = APP_TOOLS.find((item) => item.name === "delete_session")!;
  assert.equal(tool.summary!({ session_id: "s1" }, names), "채팅 '로그인' (s1) 삭제");
  assert.equal(tool.summary!({ session_id: "s2" }, names), "채팅 s2 삭제", "an unknown ID stays as is");

  const { call } = await fixture(t);
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  const mcp = (body: object) => call("POST", "/api/app-mcp", body, { authorization: `Bearer ${token}` });
  const group = parsed(await mcp(toolCall(1, "create_group", { name: "백엔드" })));
  const pending = parsed(await mcp(toolCall(2, "delete_group", { group_id: group.id })));
  assert.match(pending.summary, /그룹 '백엔드' \(/u);
  const waiting = (await call("GET", "/api/app-approvals?status=pending")).body.approvals[0];
  assert.equal(waiting.workspaceName, "기본");
  const note = await noteWithKey(call, `approval:${pending.approvalId}`);
  assert.match(note.body, /^외부 AI가 요청한/u);
});
