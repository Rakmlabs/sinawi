import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkerLog, summarizeOutput, workerLogRows } from "./worker-log";
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

test("tool results fold into their call: Claude in order, Grok into the newest call", async () => {
  const { groupWorkerLog } = await import("./worker-log");
  const tool = (id: string, text: string, agent: SessionEvent["agent"] = "claude") => event(id, {}, { type: "tool", text, agent });
  const claude = groupWorkerLog(workerLogRows([
    tool("a", "명령: ao-browser screenshot"), tool("b", "파일 읽기: src/app/page.tsx"),
    tool("ra", '도구 결과: {\n  "url": "http://localhost",\n  "width": 389\n}'), tool("rb", "도구 결과: line 1\nline 2"),
    event("m", {}, { type: "message", text: "확인했습니다." }), tool("skill", "스킬 불러옴: orchestra-browser"), tool("orphan", "도구 결과: 고아"),
  ]));
  assert.deepEqual(claude.map((item) => [item.name, item.detail, item.output]), [
    ["명령", "ao-browser screenshot", '{\n  "url": "http://localhost",\n  "width": 389\n}'],
    ["파일 읽기", "src/app/page.tsx", "line 1\nline 2"],
    ["", "", undefined], ["스킬 불러옴", "orchestra-browser", undefined], ["", "", "고아"],
  ]);
  const grok = groupWorkerLog(workerLogRows([
    tool("a", "파일 읽기: a.ts", "grok"), tool("b", "명령: ls", "grok"), tool("rb", "결과: a.ts", "grok"), tool("rb2", "결과: b.ts", "grok"),
  ]));
  assert.deepEqual(grok.map((item) => item.output), [undefined, "a.ts\nb.ts"]);
});

test("command and file change rows become one-line calls", async () => {
  const { groupWorkerLog } = await import("./worker-log");
  const [command, edit, single] = groupWorkerLog(workerLogRows([
    event("c", { id: "c", type: "command_execution", command: "npm  test\n", status: "completed", exit_code: 0, aggregated_output: "ok" }),
    event("e", { id: "e", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "update" }] }, { type: "edit" }),
    event("s", { id: "s", type: "file_change", status: "completed", changes: [{ path: "only.ts", kind: "add" }] }, { type: "edit" }),
  ]));
  assert.deepEqual([command.name, command.detail, command.output], ["명령", "npm test", "ok"]);
  assert.deepEqual([edit.name, edit.detail], ["파일 수정", "2개 파일"]);
  assert.equal(single.detail, "only.ts");
});

test("splitToolCall keeps plain labels and moves multi-line content to output", async () => {
  const { splitToolCall } = await import("./worker-log");
  assert.deepEqual(splitToolCall("도구 실행"), { name: "도구 실행", detail: "" });
  assert.deepEqual(splitToolCall("명령: echo a: b"), { name: "명령", detail: "echo a: b" });
  assert.deepEqual(splitToolCall("mcp_tool: first\nsecond"), { name: "mcp_tool", detail: "first", output: "first\nsecond" });
});

test("summarizeOutput gives the first meaningful line and the remaining line count", async () => {
  const { summarizeOutput } = await import("./worker-log");
  assert.deepEqual(summarizeOutput(""), { line: "", extraLines: 0 });
  assert.deepEqual(summarizeOutput("  hello  world \n"), { line: "hello world", extraLines: 0 });
  assert.deepEqual(summarizeOutput('{\n  "url": "x",\n  "width": 389\n}'), { line: '{"url":"x","width":389}', extraLines: 3 });
  assert.deepEqual(summarizeOutput("---\n- main\n  - item"), { line: "- main", extraLines: 2 });
  assert.deepEqual(summarizeOutput("{ not json\nnext"), { line: "{ not json", extraLines: 1 });
  const long = summarizeOutput("x".repeat(500), 20);
  assert.equal(long.line.length, 20);
  assert.ok(long.line.endsWith("…"));
});

test("cleanBriefTitle strips markdown and skips a short generic heading", async () => {
  const { cleanBriefTitle } = await import("./worker-log");
  assert.equal(cleanBriefTitle("## 목표\n\n**사이드바** 버그를 `고친다`\n\n## 범위\n- a"), "사이드바 버그를 고친다");
  assert.equal(cleanBriefTitle("## 목표: [로그인](http://x) 화면 정리"), "목표: 로그인 화면 정리");
  assert.equal(cleanBriefTitle("```\ncode\n```\n> - [ ] _첫 할 일_"), "첫 할 일");
  assert.equal(cleanBriefTitle("plain_snake_case brief"), "plain_snake_case brief");
  assert.equal(cleanBriefTitle("## 목표"), "목표");
  assert.equal(cleanBriefTitle(""), "");
  assert.equal(cleanBriefTitle("a".repeat(300)).length, 140);
});

test("a screenshot read back as base64 is summarized as an image", () => {
  const data = "A".repeat(200);
  assert.equal(summarizeOutput(`[{"type":"image","source":{"type":"base64","data":"${data}"}}]`).line, "[이미지]");
});
