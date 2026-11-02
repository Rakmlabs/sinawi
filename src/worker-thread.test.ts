import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerThread } from "./WorkerThread";
import { delegationTasks, delegationWorkers } from "./conversation";
import type { Session } from "../server/types";

test("worker main view renders all of one worker's tasks in order with separators", () => {
  const session: Session = { workspaceId: "personal", id: "s", title: "작업", agent: "codex", workers: ["claude"], cwd: "/tmp", status: "running", createdAt: "2026-10-30T00:00:00Z", events: [
    { id: "a", sessionId: "s", agent: "claude", type: "delegation", delegationId: "a", role: "worker", taskStatus: "running", text: "선택한 작업", time: "2026-10-30T00:00:00Z" },
    { id: "b", sessionId: "s", agent: "claude", type: "delegation", delegationId: "b", role: "worker", taskStatus: "running", text: "다른 작업", time: "2026-10-30T00:00:01Z" },
    { id: "log", sessionId: "s", agent: "claude", type: "command", delegationId: "a", role: "worker", text: "npm test", time: "2026-10-30T00:00:02Z" },
    { id: "grok", sessionId: "s", agent: "grok", type: "delegation", delegationId: "grok", role: "worker", taskStatus: "running", text: "다른 워커 작업", time: "2026-10-30T00:00:02Z" },
    { id: "reply", sessionId: "s", agent: "codex", type: "message", role: "orchestrator", text: "총괄 응답", time: "2026-10-30T00:00:03Z" },
  ] };
  const [worker] = delegationWorkers(session, Date.parse("2026-10-30T00:00:04Z"));
  const html = renderToStaticMarkup(createElement(WorkerThread, { worker }));
  assert.match(html, /role="log" aria-label="작업 세션 로그"/);
  assert.match(html, /Claude · 2개 작업/);
  assert.match(html, /선택한 작업/);
  assert.match(html, /npm test/);
  assert.match(html, /<strong class="wt-name">명령<\/strong><code class="wt-arg">npm test<\/code>/);
  assert.match(html, /다른 작업/);
  assert.doesNotMatch(html, /다른 워커 작업|총괄 응답/);
  assert.ok(html.indexOf("선택한 작업") < html.indexOf("다른 작업"));
  assert.match(html, /작업 1/);
  assert.match(html, /작업 2/);
  assert.match(renderToStaticMarkup(createElement(WorkerThread, { worker: { ...worker, tasks: [worker.tasks[1]] } })), /작업을 준비하고 있습니다/);
});

test("worker command rows merge, hide output by default, and render file badges and markdown", () => {
  const base = { sessionId: "s", agent: "codex" as const, delegationId: "task", time: "2026-10-30T00:00:00Z" };
  const [task] = delegationTasks({ workspaceId: "personal", id: "s", title: "작업", agent: "claude", workers: ["codex"], cwd: "/tmp", status: "done", createdAt: base.time, events: [
    { ...base, id: "task", type: "delegation", text: "작업 요청" },
    { ...base, id: "start", type: "command", text: JSON.stringify({ id: "cmd", type: "command_execution", command: "npm test", status: "in_progress" }) },
    { ...base, id: "done", type: "command", text: JSON.stringify({ id: "cmd", type: "command_execution", command: "npm test", status: "completed", exit_code: 0, aggregated_output: "모든 테스트 통과" }) },
    { ...base, id: "files", type: "edit", text: JSON.stringify({ type: "file_change", status: "completed", changes: [{ path: "src/new.ts", kind: "add" }, { path: "src/main.tsx", kind: "update" }] }) },
    { ...base, id: "message", type: "message", text: "## 작업 결과\n\n**완료**했습니다. `npm test`" },
  ] }, Date.parse(base.time));
  const html = renderToStaticMarkup(createElement(WorkerThread, { worker: { id: "codex", label: "Codex", agent: "codex", tasks: [task], status: task.status, elapsed: task.elapsed, activity: task.activity } }));
  // Start and completion of one command are a single compact row; the output is its one-line summary.
  assert.equal((html.match(/class="wt-call wt-command"/g) ?? []).length, 1);
  assert.match(html, /<code class="wt-arg">npm test<\/code>/);
  assert.match(html, /wt-dot completed/);
  assert.match(html, /<span class="wt-result-line">모든 테스트 통과<\/span>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /추가<\/span><code>src\/new.ts/);
  assert.match(html, /수정<\/span><code>src\/main.tsx/);
  assert.match(html, /<h2>작업 결과<\/h2>/);
  assert.match(html, /<strong>완료<\/strong>/);
  assert.doesNotMatch(html, /command_execution|aggregated_output|file_change/);
});

test("command chips distinguish running and failed exits and preserve plain legacy logs", () => {
  const base = { sessionId: "s", agent: "codex" as const, delegationId: "task", time: "2026-10-30T00:00:00Z" };
  const [task] = delegationTasks({ workspaceId: "personal", id: "s", title: "작업", agent: "claude", workers: ["codex"], cwd: "/tmp", status: "running", createdAt: base.time, events: [
    { ...base, id: "task", type: "delegation", text: "작업 요청" },
    { ...base, id: "running", type: "command", text: JSON.stringify({ id: "running", type: "command_execution", command: "sleep 1", status: "in_progress" }) },
    { ...base, id: "failure", type: "command", text: JSON.stringify({ id: "failure", type: "command_execution", command: "false", status: "completed", exit_code: 1, aggregated_output: "" }) },
    { ...base, id: "legacy", type: "command", text: "echo legacy" },
  ] }, Date.parse(base.time));
  const html = renderToStaticMarkup(createElement(WorkerThread, { worker: { id: "codex", label: "Codex", agent: "codex", tasks: [task], status: task.status, elapsed: task.elapsed, activity: task.activity } }));
  assert.match(html, /wt-dot in_progress" role="img" aria-label="진행중"><\/span><strong class="wt-name">명령<\/strong><code class="wt-arg">sleep 1/);
  assert.match(html, /wt-dot failed" role="img" aria-label="실패"><\/span><strong class="wt-name">명령<\/strong><code class="wt-arg">false/);
  assert.match(html, /출력이 없습니다\. · 종료 코드 1/);
  assert.match(html, /<code class="wt-arg">echo legacy<\/code>/);
});
