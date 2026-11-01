import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "../server/types";
import { quietState } from "./run-activity";

const event = (time: string) => ({ id: "e", sessionId: "s", agent: "claude", type: "message", text: "x", time }) as SessionEvent;

test("a running session is quiet after 8s without a visible event; heartbeats say it is alive", () => {
  const now = Date.parse("2026-11-02T00:01:00Z");
  const base = { status: "running" as const, events: [event("2026-11-02T00:00:30Z")] };
  assert.deepEqual(quietState({ ...base, lastActivityAt: "2026-11-02T00:00:58Z" }, now), { seconds: 30, alive: true });
  assert.deepEqual(quietState(base, now), { seconds: 30, alive: false });
  assert.equal(quietState({ ...base, events: [event("2026-11-02T00:00:55Z")] }, now), undefined);
  assert.equal(quietState({ ...base, status: "done" }, now), undefined);
});
