import test from "node:test";
import assert from "node:assert/strict";
import { sessionNotifications, authNotification } from "./notification-sources.js";
import type { Session } from "./types.js";
test("unknown auth produces no notification; login commands stay agent-specific", () => {
  assert.equal(authNotification("personal", "grok", "unknown"), undefined);
  assert.equal(authNotification("personal", "grok", "unauthenticated")?.action?.command, "grok");
  assert.equal(authNotification("company", "claude", "unauthenticated")?.action?.command, "claude auth login");
});
test("session events produce actionable permission, quota, stall, error and completion notifications", () => {
  const session = { id: "s", title: "작업", workspaceId: "personal", cwd: "/tmp", status: "done", events: [
    { id: "p", type: "warning", text: "권한 거부: rm" },
    { id: "q", type: "handoff", text: "전환", metadata: { quotaFallback: true } },
    { id: "e", type: "error", text: "응답 없이 작업이 중단되었습니다" },
  ] } as Session;
  const notes = sessionNotifications(session);
  assert.deepEqual(notes.map((n) => n.type), ["permission", "quota", "error", "run-finished"]);
  assert.ok(notes.every((n) => n.action?.sessionId === "s"));
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
