import assert from "node:assert/strict";
import test from "node:test";
import { sessionStreamMessage } from "./server.js";
import type { Session } from "./types.js";

const session: Session = {
  id: "session-1", title: "Fixture", agent: "codex", workers: ["claude"], cwd: "/tmp",
  status: "running", createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: "personal",
  events: [
    { id: "event-1", sessionId: "session-1", agent: "codex", type: "status", text: "started", time: "2026-01-01T00:00:00.000Z" },
    { id: "event-2", sessionId: "session-1", agent: "codex", type: "message", text: "working", time: "2026-01-01T00:00:01.000Z" },
  ],
};

test("session stream sends only events after the connection cursor", () => {
  const message = sessionStreamMessage(session, "event-1");
  assert.equal(message.incremental, true);
  assert.deepEqual(message.session.events.map((event) => event.id), ["event-2"]);
  assert.equal(message.session.status, "running");
});

test("session stream falls back to a full snapshot when the cursor was evicted", () => {
  const message = sessionStreamMessage(session, "evicted-event");
  assert.equal("incremental" in message, false);
  assert.equal(message.session.events.length, 2);
});

test("session stream sends a full snapshot when already-sent events were rewritten", () => {
  const message = sessionStreamMessage(session, "event-1", true);
  assert.equal("incremental" in message, false);
  assert.deepEqual(message.session.events.map((event) => event.id), ["event-1", "event-2"]);
});
