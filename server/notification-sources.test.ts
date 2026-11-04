import test from "node:test";
import assert from "node:assert/strict";
import { sessionNotifications, authNotification } from "./notification-sources.js";
import type { Session } from "./types.js";
test("unknown auth produces no notification; login commands stay agent-specific", () => {
  assert.equal(authNotification("personal", "grok", "unknown"), undefined);
  assert.equal(authNotification("personal", "grok", "unauthenticated")?.action?.command, "grok");
  assert.equal(authNotification("company", "claude", "unauthenticated")?.action?.command, "claude auth login");
});
test("session events produce actionable permission, quota and completion notifications without surfacing recovered errors", () => {
  const session = { id: "s", title: "작업", workspaceId: "personal", cwd: "/tmp", status: "done", events: [
    { id: "p", type: "warning", text: "권한 거부: rm" },
    { id: "q", type: "handoff", text: "전환", metadata: { quotaFallback: true } },
    { id: "e", type: "error", text: "응답 없이 작업이 중단되었습니다" },
  ] } as Session;
  const notes = sessionNotifications(session);
  assert.deepEqual(notes.map((n) => n.type), ["permission", "quota", "run-finished"]);
  assert.ok(notes.every((n) => n.action?.sessionId === "s"));
});

test("a terminal task failure produces one error notification from the final failure", () => {
  const session = { id: "s", title: "작업", workspaceId: "personal", cwd: "/tmp", status: "error", endedAt: "2026-11-04T00:00:00.000Z", events: [
    { id: "tool", type: "error", text: "npm test exited 1" },
    { id: "retry", type: "status", text: "다른 방법으로 다시 시도합니다" },
    { id: "worker", type: "error", text: "워커가 종료 코드 2로 끝났습니다", role: "worker", taskStatus: "error" },
    { id: "fatal", type: "error", text: "모든 재시도가 실패했습니다" },
  ] } as Session;

  const errors = sessionNotifications(session).filter((note) => note.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, "failed:s:2026-11-04T00:00:00.000Z");
  assert.equal(errors[0].title, "작업 오류");
  assert.equal(errors[0].body, "모든 재시도가 실패했습니다");
});

test("quoted failures and transient CLI errors do not notify while work continues", () => {
  const session = { id: "s", title: "작업", workspaceId: "personal", cwd: "/tmp", status: "running", turnCount: 2, events: [
    { id: "user", agent: "user", type: "message", text: "로그에 permission denied가 보입니다" },
    { id: "tool", agent: "codex", type: "error", text: "npm test exited 1" },
    { id: "quoted", agent: "codex", type: "message", text: "MCP server 'docs' authentication required라는 출력이 있었습니다" },
    { id: "retry", agent: "codex", type: "status", text: "수정 후 다시 검사합니다" },
  ] } as Session;

  assert.deepEqual(sessionNotifications(session), []);
});

test("a project lead's finished turn reads as a message from it", () => {
  const session = {
    id: "lead1", title: "첫 일", workspaceId: "personal", status: "done", endedAt: "t1", agent: "claude", cwd: "/w/api",
    steward: { turns: 1, since: "", name: "api" },
    events: [{ id: "1", time: "", type: "message", role: "orchestrator", agent: "claude", text: "포트는 4000입니다.\n<<NOTES>>\n- x\n<</NOTES>>" }],
  } as unknown as Session;
  const [note] = sessionNotifications(session);
  assert.equal(note.type, "lead");
  assert.equal(note.title, "「api」 담당");
  assert.equal(note.body, "포트는 4000입니다.");
});


test("login and MCP failure notices launch authentication in the workspace account", () => {
  const root = "/temporary/work-account";
  assert.match(authNotification("work", "codex", "unauthenticated", undefined, root)?.action?.command ?? "", /CODEX_HOME='\/temporary\/work-account'/);
  const session = { id: "s", workspaceId: "work", agent: "codex", status: "error", events: [{ id: "e", agent: "codex", type: "error", text: 'MCP server "docs" authentication required' }] } as unknown as Session;
  const [notice] = sessionNotifications(session, { codex: root });
  assert.match(notice.action?.command ?? "", /CODEX_HOME='\/temporary\/work-account'/);
});

test("historical permission and quota notices keep their keys across later turns", () => {
  const session = { id: "s", workspaceId: "personal", agent: "claude", status: "running", turnCount: 1, events: [
    { id: "request-1", agent: "user", type: "message", text: "Start" },
    { id: "p1", agent: "claude", type: "error", text: "permission denied" },
    { id: "q1", agent: "claude", type: "error", text: "rate limit" },
    { id: "p2", agent: "claude", type: "warning", text: "permission denied again" },
  ] } as unknown as Session;
  const first = sessionNotifications(session).map((note) => note.key);
  assert.equal(new Set(first).size, 2, "retries within one request share a key");
  session.turnCount = 5;
  assert.deepEqual(sessionNotifications(session).map((note) => note.key), first, "automatic turns do not replay historical alerts");
  session.events.push(
    { id: "request-2", sessionId: "s", agent: "user", type: "message", text: "Next task", time: "" },
    { id: "p3", sessionId: "s", agent: "claude", type: "error", text: "permission denied", time: "" },
  );
  const next = sessionNotifications(session).map((note) => note.key);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.ok(!first.includes(next.at(-1)), "a new user request can alert again");
});

test("a specialized terminal failure never resurfaces an older recovered error", () => {
  for (const text of ["permission denied", "rate limit", 'MCP server "docs" authentication required']) {
    const session = { id: "s", workspaceId: "personal", agent: "claude", status: "error", events: [
      { id: "old", agent: "claude", type: "error", text: "npm test exited 1" },
      { id: "final", agent: "claude", type: "error", text },
    ] } as unknown as Session;
    assert.equal(sessionNotifications(session).filter((note) => note.type === "error").length, 0, text);
  }
});
