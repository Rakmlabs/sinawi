import { test } from "node:test";
import assert from "node:assert/strict";
import { canPromoteLive, canUndoAutoHandoff, conversationText, delegationTasks, formatElapsed, delegationWorkers, liveBadgeLabel, mainConversation, mergeSession } from "./conversation";
import type { Session, SessionEvent } from "../server/types";

const event = (id: string, type: SessionEvent["type"], agent: SessionEvent["agent"], text: string, extra: Partial<SessionEvent> = {}): SessionEvent => ({ id, sessionId: "s", type, agent, text, time: "2026-10-30T00:00:00.000Z", ...extra });
const session = (events: SessionEvent[], extra: Partial<Session> = {}): Session => ({ workspaceId: "personal", id: "s", title: "작업", agent: "codex", workers: ["claude"], cwd: "/tmp", status: "running", createdAt: "2026-10-30T00:00:00Z", events, ...extra });

test("main chat only contains user, orchestrator, task card and handoff, including same-agent planner", () => {
  const s = session([
    event("user", "message", "user", "검토해 주세요"),
    event("plan", "message", "codex", "내부 계획", { role: "planner" }),
    event("raw", "tool", "codex", "명령 로그"),
    event("wire", "status", "codex", "CLI 세션 연결됨"),
    event("delegate-only", "message", "codex", '<<DELEGATE to="claude">>검토<</DELEGATE>>', { role: "orchestrator" }),
    event("task", "delegation", "claude", "검토", { role: "worker", delegationId: "task" }),
    event("report", "message", "claude", "워커 결과", { role: "worker", delegationId: "task" }),
    event("error", "error", "claude", "원시 오류", { role: "worker", delegationId: "task" }),
    event("answer", "message", "codex", "검토 결과입니다", { role: "orchestrator" }),
    event("switch", "handoff", "claude", "오케스트라가 Codex → Claude로 바뀌었습니다"),
    event("next", "message", "claude", "이어서 진행합니다", { role: "orchestrator" }),
  ], { agent: "claude", workers: ["codex"] });
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["user", "task", "answer", "switch", "next"]);
});

test("delegation syntax is removed while preserving normal reply and user text", () => {
  assert.equal(conversationText('검토합니다.\n<<DELEGATE to="claude">>내부 작업<</DELEGATE>>\n곧 알려드릴게요.'), "검토합니다.\n\n곧 알려드릴게요.");
});

test("repeated tasks for one worker retain separate status, elapsed time and threads", () => {
  const s = session([
    event("a", "delegation", "claude", "첫 작업", { delegationId: "a", taskStatus: "running" }),
    event("ac", "command", "claude", "npm test", { delegationId: "a" }),
    event("ad", "status", "claude", "완료", { delegationId: "a", taskStatus: "done", time: "2026-10-30T00:00:05Z" }),
    event("b", "delegation", "claude", "두 번째 작업", { delegationId: "b", taskStatus: "running", time: "2026-10-30T00:00:06Z" }),
    event("bc", "edit", "claude", "src/main.tsx\n+ 변경", { delegationId: "b", time: "2026-10-30T00:00:07Z" }),
  ]);
  const tasks = delegationTasks(s, Date.parse("2026-10-30T00:00:09Z"));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[0].elapsed, "0:05");
  assert.equal(tasks[1].status, "running");
  assert.equal(tasks[1].elapsed, "0:03");
  assert.equal(tasks[1].activity, "src/main.tsx + 변경");
  assert.deepEqual(tasks[0].thread.map((item) => item.id), ["ac", "ad"]);
  const [worker] = delegationWorkers(s, Date.parse("2026-10-30T00:00:09Z"));
  assert.equal(worker.agent, "claude");
  assert.deepEqual(worker.tasks.map((task) => task.event.id), ["a", "b"]);
  assert.equal(worker.status, "running");
});

test("explicit delegation links keep concurrent worker logs isolated across later boundaries", () => {
  const s = session([
    event("a", "delegation", "claude", "첫 작업", { role: "worker", delegationId: "a", taskStatus: "running" }),
    event("ac", "command", "claude", "첫 명령", { role: "worker", delegationId: "a", time: "2026-10-30T00:00:01Z" }),
    event("b", "delegation", "claude", "두 번째 작업", { role: "worker", delegationId: "b", taskStatus: "running", time: "2026-10-30T00:00:02Z" }),
    event("u", "message", "user", "진행 상황 알려줘", { time: "2026-10-30T00:00:03Z" }),
    event("bc", "command", "claude", "두 번째 명령", { role: "worker", delegationId: "b", time: "2026-10-30T00:00:04Z" }),
    event("orchestrator", "message", "codex", "진행 중입니다", { role: "orchestrator", delegationId: "a", time: "2026-10-30T00:00:05Z" }),
    event("ad", "status", "claude", "첫 작업 완료", { role: "worker", delegationId: "a", taskStatus: "done", time: "2026-10-30T00:00:06Z" }),
  ]);
  const tasks = delegationTasks(s, Date.parse("2026-10-30T00:00:09Z"));
  assert.deepEqual(tasks[0].thread.map((item) => item.id), ["ac", "ad"]);
  assert.deepEqual(tasks[1].thread.map((item) => item.id), ["bc"]);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[1].status, "running");
  assert.equal(tasks[1].elapsed, "0:07");
});

test("live status answers stay in the main chat, out of the worker thread, and can be promoted when ambiguous", () => {
  const s = session([
    event("task", "delegation", "claude", "검토", { role: "worker", workerId: "B", delegationId: "task", taskStatus: "running" }),
    event("cmd", "command", "claude", "npm test", { role: "worker", workerId: "B", delegationId: "task" }),
    event("ask", "message", "user", "뭐하고 있어?"),
    event("status", "message", "grok", "테스트를 돌리는 중입니다.", { metadata: { live: "status", ambiguous: true, prompt: "그거 봐" } }),
    event("queued", "message", "grok", "B의 다음 턴에 넣었습니다.", { metadata: { live: "directive" } }),
  ]);
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["task", "ask", "status", "queued"]);
  assert.deepEqual(delegationTasks(s, Date.parse("2026-10-30T00:00:09Z"))[0].thread.map((item) => item.id), ["cmd"]);
  assert.equal(liveBadgeLabel(s.events[3]), "상태");
  assert.equal(liveBadgeLabel(s.events[4]), "지시");
  assert.equal(canPromoteLive(s.events[3]), true);
  assert.equal(canPromoteLive({ metadata: { live: "status", ambiguous: true, promoted: true } }), false);
  const merged = mergeSession(s, { ...s, pendingInstructions: [], events: [event("status", "message", "grok", "테스트를 돌리는 중입니다.", { metadata: { live: "status", ambiguous: true, promoted: true } }), event("late", "command", "claude", "이후 명령")] });
  assert.equal(merged.events.find((item) => item.id === "status")?.metadata?.promoted, true);
  assert.equal(merged.events.some((item) => item.id === "cmd"), true);
  assert.equal(merged.events.some((item) => item.id === "late"), true);
});

test("explicit worker messages stay out of the main chat after user and delegation boundaries", () => {
  const s = session([
    event("a", "delegation", "claude", "검토", { role: "worker", delegationId: "a", taskStatus: "running" }),
    event("u", "message", "user", "추가 질문"),
    event("b", "delegation", "grok", "조사", { role: "worker", delegationId: "b", taskStatus: "running" }),
    event("late", "message", "claude", "늦게 도착한 워커 결과", { delegationId: "a" }),
    event("answer", "message", "codex", "중간 답변", { role: "orchestrator" }),
  ]);
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["a", "u", "b", "answer"]);
});

test("task error and stopped session terminate card timers", () => {
  const failed = session([
    event("a", "delegation", "claude", "검토"),
    event("e", "error", "claude", "실패", { delegationId: "a", taskStatus: "error", time: "2026-10-30T00:00:04Z" }),
  ]);
  assert.equal(delegationTasks(failed, Date.parse("2026-10-30T00:02:00Z"))[0].elapsed, "0:04");
  assert.equal(delegationTasks(failed, Date.now())[0].status, "error");
  const stopped = session([event("a", "delegation", "claude", "검토")], { status: "stopped", endedAt: "2026-10-30T00:00:08Z" });
  assert.equal(delegationTasks(stopped, Date.now())[0].elapsed, "0:08");
  assert.equal(delegationTasks(stopped, Date.now())[0].status, "stopped");
});

test("legacy worker messages stay in worker thread, primary synthesis remains visible", () => {
  const s = session([event("u", "message", "user", "검토"), event("a", "delegation", "claude", "검토"), event("w", "message", "claude", "워커 결과"), event("m", "message", "codex", "최종 답변")], { status: "done" });
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["u", "a", "m"]);
});

test("legacy messages before an automatic handoff use its recorded previous orchestrator", () => {
  const s = session([
    event("before", "message", "codex", "전환 전 답변"),
    event("switch", "handoff", "claude", "오케스트라 변경: Codex → Claude (설계 작업)", {
      metadata: { auto: true, from: "codex", to: "claude", reason: "설계 작업" },
    }),
    event("after", "message", "claude", "전환 후 답변"),
  ], { agent: "claude" });
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["before", "switch", "after"]);
});

test("only a completed, active automatic handoff can be undone", () => {
  const automatic = event("switch", "handoff", "claude", "자동 전환", { metadata: { auto: true, from: "codex", to: "claude", reason: "설계" } });
  assert.equal(canUndoAutoHandoff(automatic, "done", "switch"), true);
  assert.equal(canUndoAutoHandoff(automatic, "done", "newer"), false);
  assert.equal(canUndoAutoHandoff(automatic, "running", "switch"), false);
  assert.equal(canUndoAutoHandoff({ ...automatic, metadata: { ...automatic.metadata, undone: true } }, "done", "switch"), false);
  assert.equal(canUndoAutoHandoff(event("manual", "handoff", "claude", "수동 전환"), "done", "manual"), false);
});

test("session start and planner failures appear as chat errors", () => {
  const s = session([
    event("request", "message", "user", "Run this"),
    event("planning", "error", "codex", "Planning failed", { role: "planner" }),
    event("fatal", "error", "codex", "CLI authentication failed"),
  ], { status: "error" });
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["request", "planning", "fatal"]);
});

test("permission warnings and explicit stop events remain visible in main chat", () => {
  const s = session([
    event("warning", "warning", "claude", "권한 거부: git status", { role: "orchestrator" }),
    event("wire", "status", "claude", "CLI 세션 연결됨", { role: "orchestrator" }),
    event("stopped", "status", "claude", "중지됨", { role: "orchestrator" }),
  ], { status: "stopped" });
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["warning", "stopped"]);
});

test("duplicate same-agent workers keep separate sidebar groups and logs", () => {
  const s = session([
    event("a", "delegation", "codex", "first", { role: "worker", workerId: "codex-1", workerLabel: "Codex 1", delegationId: "a" }),
    event("b", "delegation", "codex", "second", { role: "worker", workerId: "codex-2", workerLabel: "Codex 2", delegationId: "b" }),
    event("reply-a", "message", "codex", "first result", { role: "worker", workerId: "codex-1", delegationId: "a" }),
    event("reply-b", "message", "codex", "second result", { role: "worker", workerId: "codex-2", delegationId: "b" }),
    event("answer", "message", "codex", "synthesis", { role: "orchestrator" }),
  ], { workers: ["codex", "codex"] });
  const groups = delegationWorkers(s, Date.now());
  assert.deepEqual(groups.map((worker) => worker.id), ["codex-1", "codex-2"]);
  assert.deepEqual(groups.map((worker) => worker.label), ["Codex 1", "Codex 2"]);
  assert.deepEqual(groups.map((worker) => worker.tasks[0].thread.map((item) => item.id)), [["reply-a"], ["reply-b"]]);
  assert.deepEqual(mainConversation(s).map((item) => item.id), ["a", "b", "answer"]);
});

test("main chat removes delegation directives addressed to worker ids", () => {
  assert.equal(conversationText('Start <<DELEGATE to="codex-2">>test<</DELEGATE>>'), "Start");
});

test("delegation tasks expose start/end so a leaf clock can tick only running tasks", () => {
  const s = session([
    event("a", "delegation", "claude", "첫 작업", { delegationId: "a", taskStatus: "running" }),
    event("ad", "status", "claude", "완료", { delegationId: "a", taskStatus: "done", time: "2026-10-30T00:00:05Z" }),
    event("b", "delegation", "claude", "두 번째 작업", { delegationId: "b", taskStatus: "running", time: "2026-10-30T00:00:06Z" }),
  ]);
  const [done, running] = delegationTasks(s, Date.parse("2026-10-30T00:01:10Z"));
  assert.equal(done.startedAt, "2026-10-30T00:00:00.000Z");
  assert.equal(done.endedAt, "2026-10-30T00:00:05Z");
  assert.equal(running.startedAt, "2026-10-30T00:00:06Z");
  assert.equal(running.endedAt, undefined);
  assert.equal(running.elapsed, formatElapsed(Date.parse(running.startedAt), Date.parse("2026-10-30T00:01:10Z")));
  assert.equal(formatElapsed(0, 65_000), "1:05");
  assert.equal(formatElapsed(10_000, 0), "0:00");
});

test("after a quota fallback the card names the agent and model that actually ran", () => {
  const s = session([
    event("t", "delegation", "codex", "작업", { role: "worker", workerId: "codex", workerLabel: "Codex", delegationId: "t", taskStatus: "running", model: "gpt-5.5" }),
    event("h", "status", "claude", "작업을 이어받고 있습니다.", { role: "worker", workerId: "codex", workerLabel: "Codex", delegationId: "t", taskStatus: "running", model: "haiku" }),
    event("d", "status", "claude", "작업을 완료했습니다.", { role: "worker", workerId: "codex", workerLabel: "Codex", delegationId: "t", taskStatus: "done", model: "haiku" }),
  ]);
  const [task] = delegationTasks(s, Date.parse("2026-10-30T00:00:09Z"));
  assert.equal(task.event.agent, "claude");
  assert.equal(task.event.workerLabel, "Claude");
  assert.equal(task.event.model, "haiku");
  const custom = session([
    event("t", "delegation", "codex", "작업", { role: "worker", workerId: "front", workerLabel: "프론트", delegationId: "t", taskStatus: "running", model: "gpt-5.5" }),
    event("h", "status", "claude", "작업을 이어받고 있습니다.", { role: "worker", workerId: "front", workerLabel: "프론트", delegationId: "t", taskStatus: "running" }),
  ]);
  const [renamed] = delegationTasks(custom, Date.parse("2026-10-30T00:00:09Z"));
  assert.equal(renamed.event.workerLabel, "프론트", "a custom label stays");
  assert.equal(renamed.event.model, undefined, "the fallback's CLI default, not Codex's model");
});

test("checklists leave the chat text and commander goals read as one line", () => {
  const text = conversationText('계획입니다.\n<<CHECKLIST>>\n- [ ] A\n<</CHECKLIST>>\n<<GOAL id="g1" title="로그인">>\n## 목표\n길게\n<</GOAL>>');
  assert.equal(text, "계획입니다.\n\n- **[g1] 로그인**");
});
