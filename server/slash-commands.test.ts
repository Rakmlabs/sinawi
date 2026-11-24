// "/clear" and "/compact" typed into a chat start the agents over instead of reaching a headless CLI as text,
// and a CLI's terminal-only commands (/model, /cost …) are answered by the app. Fake runners and a fake
// `claude` CLI only: no network, no login, no port 3001 (server/test-guard.ts).
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { injectRequest } from "./app-tools.js";
import { Orchestra } from "./orchestra.js";
import { createServer } from "./server.js";
import { contextEvents, lastContextReset, parseSlash } from "./slash-commands.js";
import type { AgentId, Session } from "./types.js";

async function settle(orchestra: Orchestra, session: Session) {
  const start = Date.now();
  while (orchestra.isWorking(session.id)) {
    if (Date.now() - start > 15_000) throw new Error("run did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isSummaryRun = (options: RunCliOptions) => options.prompt.startsWith("[앱 — /compact]");

function recorder() {
  const calls: RunCliOptions[] = [];
  let run = 0;
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (isSummaryRun(options)) return { exitCode: 0, finalText: "## 요약\n- 로그인 버그는 토큰 만료 처리 누락이었다", sessionId: `summary-${++run}` };
    return { exitCode: 0, finalText: "답", sessionId: `cli-${++run}` };
  };
  return { calls, runner };
}

test("a whole message that is a command is parsed; paths, skills and prose are not", () => {
  assert.deepEqual(parseSlash("/clear"), { kind: "app", command: "clear", args: "" });
  assert.deepEqual(parseSlash("/reset"), { kind: "app", command: "clear", args: "" });
  assert.deepEqual(parseSlash("/compact  API 결정 위주로 "), { kind: "app", command: "compact", args: "API 결정 위주로" });
  assert.deepEqual(parseSlash("/cost"), { kind: "app", command: "usage", args: "" });
  assert.deepEqual(parseSlash("/model opus"), { kind: "cli", name: "model" });
  assert.equal(parseSlash("/Users/me/a.ts 고쳐줘"), undefined);
  assert.equal(parseSlash("/tmp/x"), undefined);
  assert.equal(parseSlash("/frontend-design 랜딩"), undefined, "a skill or custom command goes to the CLI, which expands it");
  assert.equal(parseSlash("이거 /clear 해도 돼?"), undefined);
});

for (const agent of ["claude", "codex", "grok"] as AgentId[]) {
  test(`${agent}: /clear keeps the chat, drops every resume and leaves the old conversation out of the next turn`, async () => {
    const { calls, runner } = recorder();
    const orchestra = new Orchestra(undefined, runner);
    const session = await orchestra.create({ prompt: "첫 요청: 로그인 버그", agent, workers: [agent], cwd: process.cwd() });
    await settle(orchestra, session);
    assert.ok(session.cliSessionId, "the lead's CLI session is remembered before /clear");
    session.workerSessionIds = { [agent]: "worker-old" };

    const before = calls.length;
    const same = await orchestra.followup(session.id, "/clear");
    assert.equal(same.id, session.id, "the same chat, not a new one");
    assert.equal(calls.length, before, "/clear never reaches the CLI");
    assert.equal(session.cliSessionId, undefined);
    assert.equal(session.workerSessionIds, undefined);
    assert.ok(!session.events.some((event) => event.agent === "user" && event.text === "/clear"), "the command is not logged as a message to the agent");
    const marker = session.events[lastContextReset(session.events)];
    assert.equal(marker.metadata?.contextReset, "clear");
    assert.ok(session.events.some((event) => event.text.includes("첫 요청")), "the history stays (folded on screen)");

    await orchestra.followup(session.id, "새 요청: 다른 일");
    await settle(orchestra, session);
    const next = calls.slice(before).find((call) => call.usageContext?.role === "orchestrator")!;
    assert.equal(next.resumeSessionId, undefined, "no --resume after /clear");
    assert.doesNotMatch(next.prompt, /첫 요청/u, "the cleared conversation is not handed over");
    assert.match(next.prompt, /새 요청: 다른 일/u);
    assert.deepEqual(contextEvents(session.events).filter((event) => event.agent === "user").map((event) => event.text), ["새 요청: 다른 일"]);
  });

  test(`${agent}: /compact asks the lead for a summary in its own session, then the next turn starts fresh from it`, async () => {
    const { calls, runner } = recorder();
    const orchestra = new Orchestra(undefined, runner);
    const session = await orchestra.create({ prompt: "첫 요청: 로그인 버그", agent, workers: [agent], cwd: process.cwd() });
    await settle(orchestra, session);
    const resumed = session.cliSessionId;
    assert.ok(resumed);

    await orchestra.followup(session.id, "/compact 원인 위주로");
    const summaryRun = calls.find(isSummaryRun)!;
    assert.ok(summaryRun, "the lead's CLI writes the summary");
    assert.equal(summaryRun.agent, agent);
    assert.equal(summaryRun.resumeSessionId, resumed, "the summary run sees the lead's whole session");
    assert.equal(summaryRun.readOnly, true, "summarizing touches nothing");
    assert.match(summaryRun.prompt, /원인 위주로/u, "the user's instructions reach the summary");
    assert.equal(session.cliSessionId, undefined, "the summary run's session is not kept either");
    const marker = session.events[lastContextReset(session.events)];
    assert.equal(marker.metadata?.contextReset, "compact");
    assert.match(marker.metadata?.summary ?? "", /토큰 만료/u, "the screen keeps the summary");

    const before = calls.length;
    await orchestra.followup(session.id, "이어서 고쳐줘");
    await settle(orchestra, session);
    const next = calls.slice(before).find((call) => call.usageContext?.role === "orchestrator")!;
    assert.equal(next.resumeSessionId, undefined, "no --resume after /compact");
    assert.match(next.prompt, /토큰 만료 처리 누락/u, "the new session starts from the summary");
    assert.doesNotMatch(next.prompt, /첫 요청: 로그인 버그/u, "not from the raw history");
  });
}

test("/compact without a CLI session summarizes the messages; a failed summary falls back to them", async () => {
  const calls: RunCliOptions[] = [];
  let fail = false;
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (isSummaryRun(options)) return fail ? { exitCode: 1, finalText: "" } : { exitCode: 0, finalText: "메시지 요약" };
    return { exitCode: 0, finalText: "답" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "첫 요청", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await settle(orchestra, session);
  assert.equal(session.cliSessionId, undefined, "this fake CLI reports no session id");
  await orchestra.compact(session.id);
  const summaryRun = calls.find(isSummaryRun)!;
  assert.equal(summaryRun.resumeSessionId, undefined);
  assert.match(summaryRun.prompt, /지금까지의 대화:[\s\S]*첫 요청/u, "without a session the messages are the input");
  assert.equal(session.handoffContext, "메시지 요약");

  fail = true;
  await orchestra.followup(session.id, "둘째 요청");
  await settle(orchestra, session);
  await orchestra.compact(session.id);
  assert.match(session.handoffContext ?? "", /압축한 이전 대화:\n메시지 요약[\s\S]*둘째 요청/u, "the fallback keeps the earlier summary and the new messages");
  assert.match(session.events.at(-1)!.text, /요약 실행이 실패해/u);
  await assert.rejects(orchestra.compact(session.id), /압축할 대화가 없습니다/u, "nothing new to compact");
});

test("a CLI's terminal-only command is answered, not sent; commands wait for a running turn", async () => {
  let release: () => void = () => undefined;
  let held = false;
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (!held && options.prompt.includes("오래 걸리는 일")) { held = true; await new Promise<void>((resolve) => { release = resolve; }); }
    return { exitCode: 0, finalText: "답", sessionId: "cli-1" };
  };
  const orchestra = new Orchestra(undefined, runner);
  await assert.rejects(orchestra.create({ prompt: "/clear", agent: "claude", workers: ["claude"], cwd: process.cwd() }), /대화가 있는 채팅에서/u);
  await assert.rejects(orchestra.create({ prompt: "/model opus", agent: "claude", workers: ["claude"], cwd: process.cwd() }), /CLI 터미널 전용[\s\S]*팀 선택/u);
  assert.equal(calls.length, 0);

  const session = await orchestra.create({ prompt: "첫 요청", agent: "claude", workers: ["claude"], cwd: process.cwd() });
  await settle(orchestra, session);
  const events = session.events.length;
  await assert.rejects(orchestra.followup(session.id, "/cost"), /사용량/u);
  await assert.rejects(orchestra.followup(session.id, "/status"), /CLI 터미널 전용/u);
  await assert.rejects(orchestra.followup(session.id, "/help"), /\/clear[\s\S]*\/compact/u);
  assert.equal(calls.length, 1, "none of them reached the CLI");
  assert.equal(session.events.length, events, "nor the conversation");

  await orchestra.followup(session.id, "오래 걸리는 일");
  while (!held) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(orchestra.liveTurn(session.id, "/clear"), /작업 중에는 맥락을 지울 수 없습니다/u);
  await assert.rejects(orchestra.liveTurn(session.id, "/compact"), /작업 중에는 압축할 수 없습니다/u);
  await assert.rejects(orchestra.liveTurn(session.id, "/model"), /CLI 터미널 전용/u);
  assert.equal(session.cliSessionId, "cli-1", "a refused command changes nothing");
  release();
  await settle(orchestra, session);
});

// The real routes and Orchestra with a fake `claude` that logs its arguments: a lead's chat opened over MCP,
// then /clear and /compact sent from outside (send_message) and from the app (POST /messages).
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args.includes("--help")) { console.log("Usage: claude [options] --output-format"); process.exit(0); }
const reply = (prompt) => {
  const runs = (process.env.FAKE_LOG && fs.existsSync(process.env.FAKE_LOG)) ? fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\\n").filter(Boolean).length : 0;
  const id = "fake-" + (runs + 1);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt }) + "\\n");
  const text = prompt.startsWith("[앱 — /compact]") ? "## 요약\\n- 결론: 세션 토큰 만료 처리 누락" : "답: " + (prompt.trim().split("\\n").at(-1) || "");
  const out = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
  out({ type: "system", subtype: "init", session_id: id });
  out({ type: "assistant", session_id: id, message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: id });
  process.exit(0);
};
const p = args.indexOf("-p");
if (p >= 0 && args[p + 1] && !args[p + 1].startsWith("-")) reply(args[p + 1]);
else { let input = ""; process.stdin.on("data", (c) => { input += c; }); process.stdin.on("end", () => reply(input)); }
`;

test("over the real routes: a lead's chat opened by MCP clears and compacts, and the CLI is called without --resume after", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-slash-"));
  const project = join(directory, "project");
  await mkdir(project);
  const fake = join(directory, "claude");
  const log = join(directory, "claude-calls.jsonl");
  await writeFile(fake, FAKE_CLAUDE);
  await chmod(fake, 0o755);
  await appendFile(log, "");
  const saved = { bin: process.env.SINAWI_CLAUDE_BIN, log: process.env.FAKE_LOG };
  process.env.SINAWI_CLAUDE_BIN = fake;
  process.env.FAKE_LOG = log;
  const created = createServer({ dataDir: directory, modelHomeDir: directory, staticDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => {
    for (const session of created.orchestra.list()) if (session.status === "running") created.orchestra.stop(session.id);
    created.httpServer.close(); created.websocket.close();
    await created.flushSessions().catch(() => undefined);
    if (saved.bin === undefined) delete process.env.SINAWI_CLAUDE_BIN; else process.env.SINAWI_CLAUDE_BIN = saved.bin;
    if (saved.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = saved.log;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers, 60_000) as Promise<{ status: number; body: any }>;
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  let rpc = 0;
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const answer = await call("POST", "/api/app-mcp", { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}`, "x-sinawi-client": "grok-bot" });
    const text = answer.body.result?.content?.[0]?.text ?? JSON.stringify(answer.body);
    if (answer.body.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  const resumeOf = (args: string[]) => args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
  const leadCalls = async () => (await calls()).filter((entry) => !entry.prompt.startsWith("[앱 — /compact]") && entry.prompt.includes("사용자 요청:"));

  const lead = (await call("POST", "/api/stewards", { name: "데모", agent: "claude", cwds: [project], workers: [{ agent: "claude" }] })).body;
  const opened = await mcp("create_session", { lead_id: lead.id, prompt: "로그인 버그 원인 찾아줘", agent: "claude" });
  const session = created.orchestra.get(opened.id)!;
  assert.equal(session.steward?.id, lead.id, "a lead's chat");
  await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  await mcp("send_message", { session_id: opened.id, prompt: "더 자세히" });
  await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  assert.ok(resumeOf((await leadCalls()).at(-1)!.args), "before /clear the second turn resumes the first");

  // From outside: the same text a user would type.
  await mcp("send_message", { session_id: opened.id, prompt: "/clear" });
  assert.equal(session.events[lastContextReset(session.events)].metadata?.contextReset, "clear");
  await mcp("send_message", { session_id: opened.id, prompt: "새 주제: 결제 화면" });
  await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  const afterClear = (await leadCalls()).at(-1)!;
  assert.equal(resumeOf(afterClear.args), undefined, "no --resume after /clear");
  assert.doesNotMatch(afterClear.prompt, /로그인 버그 원인 찾아줘/u);

  // From the app: /compact summarizes in the lead's session, then a fresh one starts from the summary.
  const compacted = await call("POST", `/api/sessions/${opened.id}/messages`, { prompt: "/compact" });
  assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
  const summaryRun = (await calls()).find((entry) => entry.prompt.startsWith("[앱 — /compact]"))!;
  assert.ok(resumeOf(summaryRun.args), "the summary run resumes the lead's session");
  assert.ok(summaryRun.args.includes("--tools") && summaryRun.args[summaryRun.args.indexOf("--tools") + 1] === "", "and has no tools");
  assert.match(session.events[lastContextReset(session.events)].metadata?.summary ?? "", /토큰 만료/u);
  await call("POST", `/api/sessions/${opened.id}/messages`, { prompt: "이어서 진행" });
  await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  const afterCompact = (await leadCalls()).at(-1)!;
  assert.equal(resumeOf(afterCompact.args), undefined, "no --resume after /compact");
  assert.match(afterCompact.prompt, /세션 토큰 만료 처리 누락/u, "the new session starts from the summary");

  const model = await call("POST", `/api/sessions/${opened.id}/messages`, { prompt: "/model sonnet" });
  assert.equal(model.status, 400);
  assert.match(model.body.error, /CLI 터미널 전용/u);
  assert.ok(!(await calls()).some((entry) => entry.prompt.includes("/model sonnet")), "never sent to the CLI");
});
