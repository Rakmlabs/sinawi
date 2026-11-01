import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkerLog, workerLogRows } from "./worker-log";
import type { SessionEvent } from "../server/types";

function event(id: string, item: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { id, sessionId: "s", agent: "codex", type: "command", text: JSON.stringify(item), time: "2026-10-30T00:00:00Z", delegationId: "task", ...extra };
}

test("command start and completion merge in place with status, output and exit code", () => {
  const start = event("start", { id: "item_1", type: "command_execution", command: "npm test", status: "in_progress" });
  const unrelated = event("message", {}, { type: "message", text: "테스트 중" });
  const done = event("done", { id: "item_1", type: "command_execution", command: "npm test", status: "completed", exit_code: 0, aggregated_output: "통과\n" });
  const rows = workerLogRows([start, unrelated, done]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event.id, "start");
  assert.equal(rows[0].text, "npm test");
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].exitCode, 0);
  assert.equal(rows[0].output, "통과\n");
  assert.equal(workerLogRows([start, done, start])[0].status, "completed");
});

test("merge does not conflate agents, tasks, sessions, or unstructured events", () => {
  const item = { id: "item_1", type: "command_execution", command: "pwd", status: "in_progress" };
  const rows = workerLogRows([
    event("a", item), event("b", item, { agent: "claude" }),
    event("c", item, { delegationId: "other" }), event("d", item, { sessionId: "other" }),
    event("e", {}, { text: "pwd" }), event("f", {}, { text: "pwd" }),
  ]);
  assert.equal(rows.length, 6);
});

test("parse wrapper events, failed exits and structured file changes", () => {
  const row = parseWorkerLog(event("bad", { type: "item.completed", item: { id: "cmd", type: "command_execution", command: "false", exit_code: 1, aggregated_output: "failure" } }));
  assert.equal(row.status, "failed");
  assert.equal(row.exitCode, 1);
  const files = { id: "files", type: "file_change", status: "completed", changes: [{ path: "src/new.ts", kind: "add" }, { path: "src/main.tsx", kind: "update" }, { path: "old.txt", kind: "delete" }, null, { path: 17 }] };
  assert.deepEqual(parseWorkerLog(event("edit", files)).changes, [
    { path: "src/new.ts", kind: "add" }, { path: "src/main.tsx", kind: "modify" }, { path: "old.txt", kind: "delete" },
  ]);
  assert.equal(workerLogRows([event("f1", { ...files, status: "in_progress" }), event("f2", files)]).length, 1);
});

test("malformed, plain and unknown logs remain readable without throwing", () => {
  for (const text of ["npm test", '{"type":"command_execution",…', "null", "[]", '{"other":1}']) {
    assert.equal(parseWorkerLog(event("plain", {}, { text })).text, text);
  }
  const row = parseWorkerLog(event("bad-fields", { type: "command_execution", command: {}, aggregated_output: null, exit_code: "0" }));
  assert.equal(row.text, "");
  assert.equal(row.output, undefined);
  assert.equal(row.exitCode, undefined);
});

test("normalized CLI lifecycle reaches one readable row without losing long output", async () => {
  const { normalizeCliLine } = await import("../server/cli");
  const { workerLogSummary } = await import("./worker-log");
  const output = "긴 출력입니다.\n".repeat(1000);
  const raw = [
    { type: "item.started", item: { id: "cmd", type: "command_execution", command: "npm test" } },
    { type: "item.completed", item: { id: "cmd", type: "command_execution", command: "npm test", exit_code: 0, aggregated_output: output } },
  ];
  const events = raw.flatMap((value, index) => normalizeCliLine("codex", JSON.stringify(value)).map((line) => event(String(index), {}, { type: line.type, text: line.text })));
  const [row, extra] = workerLogRows(events);
  assert.equal(extra, undefined);
  assert.equal(row.status, "completed");
  assert.equal(row.output, output);
  assert.equal(workerLogSummary(row), "npm test");
});

test("partial completion updates retain the command and file list from earlier events", () => {
  const rows = workerLogRows([
    event("start", { id: "cmd", type: "command_execution", status: "in_progress", command: "npm test" }),
    event("done", { id: "cmd", type: "command_execution", status: "completed", exit_code: 0, aggregated_output: "passed" }),
    event("files-start", { id: "files", type: "file_change", status: "in_progress", changes: [{ kind: "add", path: "src/new.ts" }] }),
    event("files-done", { id: "files", type: "file_change", status: "completed" }),
  ]);
  assert.equal(rows[0].text, "npm test");
  assert.equal(rows[0].status, "completed");
  assert.deepEqual(rows[1].changes, [{ kind: "add", path: "src/new.ts" }]);
  assert.equal(rows[1].status, "completed");
});

test("legacy item ids reused after task boundaries stay separate in activity", () => {
  const rows = workerLogRows([
    event("task-a", {}, { type: "delegation", text: "첫 작업", delegationId: undefined }),
    event("a", { id: "item_1", type: "command_execution", command: "pwd" }, { delegationId: undefined }),
    event("task-b", {}, { type: "delegation", text: "두 번째 작업", delegationId: undefined }),
    event("b", { id: "item_1", type: "command_execution", command: "npm test" }, { delegationId: undefined }),
  ]).filter((row) => row.type === "command");
  assert.deepEqual(rows.map((row) => row.text), ["pwd", "npm test"]);
});
