import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "../server/types";
import { currentActivity, quietState } from "./run-activity";

const event = (time: string) => ({ id: "e", sessionId: "s", agent: "claude", type: "message", text: "x", time }) as SessionEvent;

test("a running session is quiet after 8s without a visible event; heartbeats say it is alive", () => {
  const now = Date.parse("2026-11-02T00:01:00Z");
  const base = { status: "running" as const, events: [event("2026-11-02T00:00:30Z")] };
  assert.deepEqual(quietState({ ...base, lastActivityAt: "2026-11-02T00:00:58Z" }, now), { seconds: 30, alive: true });
  assert.deepEqual(quietState(base, now), { seconds: 30, alive: false });
  assert.equal(quietState({ ...base, events: [event("2026-11-02T00:00:55Z")] }, now), undefined);
  assert.equal(quietState({ ...base, status: "done" }, now), undefined);
});

test("a blocking CI watch reads as waiting for the deploy, through the 30s heartbeats", () => {
  const event = (text: string, time: string, extra: Partial<SessionEvent> = {}) => ({ id: time, agent: "claude", type: "tool", text, time, role: "worker", workerLabel: "Claude", ...extra }) as SessionEvent;
  const events = [
    event("명령: gh run watch 41376400382 --interval 30 >/dev/null", "2026-11-02T02:13:04.000Z"),
    event("도구 실행", "2026-11-02T02:13:34.000Z"),
    event("도구 실행", "2026-11-02T02:14:04.000Z"),
  ];
  assert.deepEqual(currentActivity({ status: "running", events }), { who: "Claude", kind: "deploy", text: "명령: gh run watch 41376400382 --interval 30 >/dev/null", since: "2026-11-02T02:13:04.000Z" });
  const reading = [event("파일 읽기: /repo/.git/HEAD", "2026-11-02T02:24:46.000Z", { role: "orchestrator", agent: "grok" })];
  assert.equal(currentActivity({ status: "running", events: reading })?.who, "lead");
  assert.equal(currentActivity({ status: "running", events: [...events, event("도구 결과: ok", "2026-11-02T02:20:00.000Z")] }), undefined);
  assert.equal(currentActivity({ status: "done", events }), undefined);
});
