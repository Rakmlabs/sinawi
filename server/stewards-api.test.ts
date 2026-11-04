import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Express } from "express";
import { createServer, startInput } from "./server.js";
import { loadSchedules } from "./schedules.js";
import { issueComputerToken, revokeComputerToken } from "./computer-tokens.js";
import { loadStewards, loadWorkspaceState, saveSessions, saveWorkspaceState } from "./store.js";
import { notesPath, saveNotes, userPreferencesPath } from "./steward.js";
import type { Session } from "./types.js";

function request(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...headers, ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req);
    res.assignSocket(socket as never);
    res.on("error", reject);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No response: ${method} ${path}`)); }, 3000);
    res.on("finish", () => {
      clearTimeout(timer);
      try {
        const payload = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : undefined });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    app(req, res);
    if (json) req.push(json);
    req.complete = true;
    req.push(null);
  });
}

const server = (directory: string) => createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });

async function fixture(t: test.TestContext, sessions: Session[] = [], legacyMergePolicy?: "auto" | "ask") {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-stewards-api-"));
  if (sessions.length) await saveSessions(sessions, directory);
  if (legacyMergePolicy) await saveWorkspaceState({ currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }], defaults: {}, stewardSettings: { legacyMergePolicy } }, directory);
  const created = server(directory);
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await new Promise((resolve) => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true }); });
  return { directory, ...created };
}

const legacyLead = (cwd: string): Session => ({
  id: "lead-1", title: "담당", agent: "codex", workers: ["claude"], cwd, status: "done", createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: "default", systemPrompt: "짧게", skills: [], events: [
    { id: "e1", sessionId: "lead-1", agent: "codex", type: "message", role: "orchestrator", text: "끝냈습니다\n<<NOTES>>\n- n\n<</NOTES>>", time: "2026-01-01T00:00:01.000Z" },
  ],
  goal: { items: [{ text: "API 만들기", status: "done" }], startedAt: "", autoTurns: 0, idleTurns: 0 },
  steward: { turns: 2, since: "2026-01-01T00:00:00.000Z", name: "api" },
});

test("leads can be created, listed, read, edited and deleted", async (t) => {
  const { app, directory } = await fixture(t);
  assert.deepEqual((await request(app, "GET", "/api/stewards")).body, []);
  const created = await request(app, "POST", "/api/stewards", { name: " 백엔드 ", agent: "claude", systemPrompt: "백엔드만 봅니다", skills: ["review"], workers: [{ agent: "codex", model: "gpt-5" }], cwds: ["/work/api"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "백엔드");
  assert.equal(created.body.mergePolicy, "ask", "a new lead asks before merging");
  assert.deepEqual(created.body.workers, [{ id: "codex", label: "Codex", agent: "codex", model: "gpt-5" }]);
  assert.deepEqual(created.body.threads, []);
  const id = created.body.id as string;
  assert.equal((await loadStewards(directory)).length, 1, "written to stewards.json");

  assert.equal((await request(app, "POST", "/api/stewards", { name: "백엔드" })).status, 400, "names are unique");
  assert.equal((await request(app, "POST", "/api/stewards", {})).status, 400, "a name is required");

  const patched = await request(app, "PATCH", `/api/stewards/${id}`, { name: "서버", mergePolicy: "never", systemPrompt: "서버를 봅니다", notes: "- 사용자가 쓴 노트" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "서버");
  assert.equal(patched.body.mergePolicy, "never");
  assert.equal(patched.body.systemPrompt, "서버를 봅니다");
  assert.equal(patched.body.notes, "- 사용자가 쓴 노트\n");
  assert.equal(await readFile(notesPath(directory, id), "utf8"), "- 사용자가 쓴 노트\n");
  assert.equal((await request(app, "PATCH", `/api/stewards/${id}`, { mergePolicy: "sometimes" })).status, 400);
  assert.equal((await request(app, "PATCH", `/api/stewards/${id}`, {})).status, 400);
  assert.equal((await request(app, "GET", `/api/stewards/${id}`)).body.name, "서버");
  assert.equal((await request(app, "GET", "/api/stewards")).body.length, 1);

  assert.equal((await request(app, "DELETE", `/api/stewards/${id}`)).status, 204);
  assert.equal((await request(app, "GET", `/api/stewards/${id}`)).status, 404);
  assert.equal((await request(app, "PATCH", `/api/stewards/${id}`, { name: "x" })).status, 404);
  assert.equal((await request(app, "DELETE", `/api/stewards/${id}`)).status, 404);
  assert.deepEqual(await loadStewards(directory), []);
});

test("a lead chat saved by an older version shows up as a lead entity with its notes", async (t) => {
  const { app, directory } = await fixture(t, [legacyLead("/work/api")]);
  await saveNotes(directory, "lead-1", "- 옛 노트");
  const list = await request(app, "GET", "/api/stewards");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, "lead-1");
  assert.equal(list.body[0].name, "api");
  assert.equal(list.body[0].mergePolicy, "auto");
  const one = await request(app, "GET", "/api/stewards/lead-1");
  assert.equal(one.body.notes, "- 옛 노트\n");
  assert.deepEqual(one.body.threads.map((thread: { id: string }) => thread.id), ["lead-1"]);
  const panel = await request(app, "GET", "/api/sessions/lead-1/steward");
  assert.equal(panel.body.steward.id, "lead-1");
  assert.equal(panel.body.pendingMerge, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await loadStewards(directory))[0]?.id, "lead-1", "the migration is saved");
});

test("a chat's summary is one GET", async (t) => {
  const { app } = await fixture(t, [legacyLead("/work/api")]);
  const summary = await request(app, "GET", "/api/sessions/lead-1/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.status, "done");
  assert.equal(summary.body.lastAnswer, "끝냈습니다");
  assert.deepEqual(summary.body.checklist, [{ text: "API 만들기", status: "done" }]);
  assert.equal(summary.body.pendingMerge, null);
  assert.equal(summary.body.steward.name, "api");
  assert.equal(summary.body.steward.mergePolicy, "auto");
  assert.equal((await request(app, "GET", "/api/sessions/missing/summary")).status, 404);
});

test("merge approval and rejection need a merge that waits", async (t) => {
  const lead = legacyLead("/work/api");
  lead.steward!.pendingMerge = { branches: [{ workerId: "claude", branch: "sinawi/lead-1/claude", path: "/nowhere" }], createdAt: "2026-01-01T00:00:00.000Z" };
  const { app } = await fixture(t, [lead]);
  assert.equal((await request(app, "GET", "/api/sessions/lead-1/summary")).body.pendingMerge.branches[0].branch, "sinawi/lead-1/claude");
  const rejected = await request(app, "POST", "/api/sessions/lead-1/merge/reject");
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.steward.pendingMerge, undefined);
  assert.equal((await request(app, "POST", "/api/sessions/lead-1/merge/reject")).status, 400);
  assert.equal((await request(app, "POST", "/api/sessions/lead-1/merge/approve")).status, 400);
  assert.equal((await request(app, "POST", "/api/sessions/missing/merge/approve")).status, 404);
});

test("the user's common preferences are read and written as user-preferences.md", async (t) => {
  const { app, directory } = await fixture(t);
  assert.equal((await request(app, "GET", "/api/user-preferences")).body.text, "");
  const saved = await request(app, "PUT", "/api/user-preferences", { text: "  - 답은 짧게\n" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.text, "- 답은 짧게");
  assert.equal(await readFile(userPreferencesPath(directory), "utf8"), "- 답은 짧게\n");
  assert.equal((await request(app, "GET", "/api/user-preferences")).body.text, "- 답은 짧게");
  assert.equal((await request(app, "PUT", "/api/user-preferences", { text: 3 })).status, 400);
  assert.equal((await request(app, "PUT", "/api/user-preferences", { text: "x".repeat(9_000) })).status, 400);
  await request(app, "PUT", "/api/user-preferences", { text: "" });
  assert.equal((await request(app, "GET", "/api/user-preferences")).body.text, "");
});

test("the legacy merge policy setting is read, saved in workspaces.json and applied to migrated leads", async (t) => {
  const { app, directory } = await fixture(t, [legacyLead("/work/api")]);
  assert.deepEqual((await request(app, "GET", "/api/stewards/settings")).body, { legacyMergePolicy: "auto" });
  const saved = await request(app, "PUT", "/api/stewards/settings", { legacyMergePolicy: "ask" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { legacyMergePolicy: "ask", updated: 1 });
  assert.equal((await loadWorkspaceState(directory)).stewardSettings?.legacyMergePolicy, "ask");
  assert.equal((await request(app, "GET", "/api/stewards/lead-1")).body.mergePolicy, "ask");
  assert.equal((await loadStewards(directory))[0].mergePolicy, "ask");
  assert.equal((await request(app, "PUT", "/api/stewards/settings", { legacyMergePolicy: "never" })).status, 400, "never is for the per-lead and bulk choices");
  // Another workspace change keeps the setting.
  await request(app, "POST", "/api/workspaces", { name: "다른 곳" });
  assert.equal((await loadWorkspaceState(directory)).stewardSettings?.legacyMergePolicy, "ask");
});

test("an older lead chat loaded while the setting says ask migrates as ask", async (t) => {
  const { app } = await fixture(t, [legacyLead("/work/api")], "ask");
  assert.equal((await request(app, "GET", "/api/stewards")).body[0].mergePolicy, "ask");
  assert.equal((await request(app, "GET", "/api/sessions/lead-1/summary")).body.steward.mergePolicy, "ask");
});

test("one request sets every lead's merge policy", async (t) => {
  const { app, directory } = await fixture(t, [legacyLead("/work/api")]);
  await request(app, "POST", "/api/stewards", { name: "웹" });
  const bulk = await request(app, "POST", "/api/stewards/merge-policy/bulk", { policy: "never" });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.updated, 2);
  assert.deepEqual(bulk.body.stewards.map((item: { mergePolicy: string }) => item.mergePolicy), ["never", "never"]);
  assert.deepEqual((await loadStewards(directory)).map((item) => item.mergePolicy), ["never", "never"]);
  assert.equal((await request(app, "POST", "/api/stewards/merge-policy/bulk", { policy: "sometimes" })).status, 400);
  assert.equal((await request(app, "POST", "/api/stewards/merge-policy/bulk", {})).status, 400);
});

test("a migrated lead's policy picked in its panel holds, and the panel reads it back", async (t) => {
  const { app } = await fixture(t, [legacyLead("/work/api")]);
  const patched = await request(app, "PATCH", "/api/stewards/lead-1", { mergePolicy: "ask" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.mergePolicy, "ask");
  assert.equal((await request(app, "GET", "/api/sessions/lead-1/steward")).body.steward.mergePolicy, "ask", "the panel shows it");
  assert.equal((await request(app, "GET", "/api/sessions/lead-1/summary")).body.steward.mergePolicy, "ask");
  const setting = await request(app, "PUT", "/api/stewards/settings", { legacyMergePolicy: "auto" });
  assert.equal(setting.body.updated, 0, "the legacy setting does not undo a policy picked by hand");
  assert.equal((await request(app, "GET", "/api/stewards/lead-1")).body.mergePolicy, "ask");
});

test("leads' notes and the user's preferences live in the server's data folder", async (t) => {
  const { app, orchestra, directory } = await fixture(t);
  assert.equal(orchestra.stewardDataDir, directory);
  const created = await request(app, "POST", "/api/stewards", { name: "노트" });
  await request(app, "PATCH", `/api/stewards/${created.body.id}`, { notes: "- 여기" });
  assert.equal(await readFile(notesPath(directory, created.body.id), "utf8"), "- 여기\n");
  await request(app, "PUT", "/api/user-preferences", { text: "- 짧게" });
  assert.equal(await readFile(userPreferencesPath(directory), "utf8"), "- 짧게\n");
});

test("report times are a lead's: the per-chat API and the lead API set the same one", async (t) => {
  const lead = legacyLead("/work/api");
  lead.steward!.report = "08:00";
  const { app } = await fixture(t, [lead]);
  assert.equal((await request(app, "GET", "/api/stewards/lead-1")).body.report, "08:00", "an older chat's report time moved to its lead");
  const panel = await request(app, "GET", "/api/sessions/lead-1/steward");
  assert.equal(panel.body.report, "08:00");
  assert.equal(panel.body.threads, 1);
  const viaChat = await request(app, "PATCH", "/api/sessions/lead-1/steward", { report: "07:15" });
  assert.equal(viaChat.status, 200);
  assert.equal(viaChat.body.steward.report, undefined, "nothing is kept on the chat");
  assert.equal((await request(app, "GET", "/api/stewards/lead-1")).body.report, "07:15");
  assert.equal((await request(app, "PATCH", "/api/stewards/lead-1", { report: "6:05" })).body.report, "06:05");
  assert.equal((await request(app, "PATCH", "/api/stewards/lead-1", { report: "25:00" })).status, 400);
  assert.equal((await request(app, "PATCH", "/api/stewards/lead-1", { report: null })).body.report, undefined);
  assert.equal((await request(app, "GET", "/api/sessions/lead-1/summary")).body.steward.report, null);
  assert.equal((await request(app, "POST", "/api/stewards", { name: "아침", report: "09:30" })).body.report, "09:30");
});

test("a new chat of a lead may leave the folder to the lead", async (t) => {
  const { app } = await fixture(t);
  const missing = await request(app, "POST", "/api/sessions", { prompt: "x", agent: "codex", workers: ["codex"], steward: { id: "nope" } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /담당을 찾을 수 없습니다/u, "the folder was not asked for: the lead was looked up");
  const plain = await request(app, "POST", "/api/sessions", { prompt: "x", agent: "codex", workers: ["codex"] });
  assert.equal(plain.status, 400, "an ordinary chat still needs a folder");
  assert.doesNotMatch(plain.body.error, /담당/u);
});

test("a lead's schedules can be listed, created, edited, paused and deleted over the API", async (t) => {
  const { app, directory } = await fixture(t);
  const lead = (await request(app, "POST", "/api/stewards", { name: "일정" })).body;
  assert.deepEqual((await request(app, "GET", `/api/stewards/${lead.id}/schedules`)).body, []);
  const created = await request(app, "POST", `/api/stewards/${lead.id}/schedules`, { title: "아침", prompt: "어제 바뀐 것 정리", cron: "0 9 * * 1-5", timezone: "Asia/Seoul" });
  assert.equal(created.status, 201);
  assert.equal(created.body.createdBy, "user");
  assert.equal(created.body.enabled, true);
  assert.ok(created.body.nextRunAt);
  const id = created.body.id as string;
  assert.equal((await loadSchedules(directory))[0]?.id, id, "written to schedules.json");
  assert.equal((await request(app, "POST", `/api/stewards/${lead.id}/schedules`, { prompt: "x", cron: "nope" })).status, 400);
  assert.equal((await request(app, "POST", `/api/stewards/${lead.id}/schedules`, { prompt: 3, cron: "0 9 * * *" })).status, 400);
  assert.equal((await request(app, "POST", "/api/stewards/none/schedules", { prompt: "x", cron: "0 9 * * *" })).status, 404);

  const paused = await request(app, "PATCH", `/api/schedules/${id}`, { enabled: false });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.enabled, false);
  const edited = await request(app, "PATCH", `/api/schedules/${id}`, { prompt: "새 내용", at: "2099-01-02T09:00", cron: "" });
  assert.equal(edited.body.prompt, "새 내용");
  assert.equal(edited.body.cron, undefined);
  assert.equal(edited.body.at, new Date("2099-01-02T00:00:00Z").toISOString());
  assert.equal((await request(app, "PATCH", "/api/schedules/none", { enabled: true })).status, 404);
  assert.equal((await request(app, "GET", `/api/stewards/${lead.id}/schedules`)).body.length, 1);

  assert.equal((await request(app, "DELETE", `/api/schedules/${id}`)).status, 204);
  assert.deepEqual((await request(app, "GET", `/api/stewards/${lead.id}/schedules`)).body, []);
  assert.equal((await request(app, "DELETE", `/api/schedules/${id}`)).status, 404);
});

test("the lead tool endpoint takes only a lead run's own token", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-lead-mcp-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { app } = await fixture(t, [legacyLead(cwd)]);
  await request(app, "GET", "/api/stewards");
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const tokens = {
    lead: issueComputerToken({ sessionId: "lead-1", workspaceId: "default", agent: "codex", owner: "lead-1:orchestrator" }),
    worker: issueComputerToken({ sessionId: "lead-1", workspaceId: "default", agent: "claude", owner: "lead-1:claude" }),
    other: issueComputerToken({ sessionId: "plain", workspaceId: "default", agent: "codex", owner: "plain:orchestrator" }),
  };
  t.after(() => { for (const token of Object.values(tokens)) revokeComputerToken(token); });
  const call = (token: string | undefined, body: unknown) => request(app, "POST", "/api/lead-mcp", body, token ? { "x-sinawi-token": token } : {});
  assert.equal((await call(undefined, list)).status, 403, "no token");
  assert.equal((await call("made-up", list)).status, 403, "unknown token");
  assert.equal((await call(tokens.worker, list)).status, 403, "a worker's run cannot use the lead's tools");
  assert.equal((await call(tokens.other, list)).status, 403, "a chat that is not a lead");
  const tools = await call(tokens.lead, list);
  assert.equal(tools.status, 200);
  assert.ok(tools.body.result.tools.some((tool: { name: string }) => tool.name === "delegate_task"));
  const idle = await call(tokens.lead, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate_task", arguments: { brief: "x" } } });
  assert.equal(idle.body.result.isError, true, "no turn running: the lead hears why");
  const made = await call(tokens.lead, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "schedule_create", arguments: { prompt: "점검", cron: "0 9 * * *" } } });
  assert.equal(made.body.result.isError, undefined);
  const lead = (await request(app, "GET", "/api/stewards")).body[0];
  const listed = (await request(app, "GET", `/api/stewards/${lead.id}/schedules`)).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].createdBy, "lead");
});

test("POST /api/sessions accepts a lead's chat with only steward:{id}", () => {
  const workspace = (value: unknown, fallback = "default") => (typeof value === "string" ? value : fallback) as never;
  const input = startInput({ prompt: "안녕", steward: { id: "lead-1" } }, workspace, "default" as never);
  assert.equal(input.agent, undefined, "the team comes from the lead (Orchestra.create)");
  assert.deepEqual(input.workers, []);
  assert.equal(input.cwd, "");
  assert.deepEqual(input.steward, { name: undefined, id: "lead-1" });
  assert.equal(startInput({ prompt: "안녕", cwd: "/tmp" }, workspace, "default" as never).agent, undefined, "a plain chat may leave the agent to the workspace (withWorkspaceTeam)");
  assert.throws(() => startInput({ prompt: "안녕", agent: "gpt", cwd: "/tmp" }, workspace, "default" as never), /에이전트/u, "an unknown agent is still refused");
  assert.equal(startInput({ cwd: "/tmp" }, workspace, "default" as never).prompt, "", "no prompt: an empty chat");
});
