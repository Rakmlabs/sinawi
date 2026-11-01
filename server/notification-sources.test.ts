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
