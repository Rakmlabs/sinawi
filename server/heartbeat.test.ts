import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCliLine, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { StallDetector } from "./supervision.js";
import type { Session } from "./types.js";

async function settle(session: Session, timeoutMs = 5_000) {
  const started = Date.now();
  while (session.status === "running") {
    if (Date.now() - started > timeoutMs) throw new Error("session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Claude partial-message deltas are liveness only, never chat text", () => {
  const delta = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }, session_id: "s1" });
  assert.deepEqual(normalizeCliLine("claude", delta), []);
});

test("raw CLI activity keeps a quiet run alive past the inactivity watchdog", async () => {
  const published: Session[] = [];
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    // 600ms of thinking with no visible line, against a 150ms watchdog.
    const beat = setInterval(() => options.onActivity?.(), 30);
    setTimeout(() => {
      clearInterval(beat);
      options.onLine({ type: "message", text: "answer", finalText: "answer" });
      resolve({ exitCode: 0, finalText: "answer" });
    }, 600);
  });
  const orchestra = new Orchestra((session) => { published.push(structuredClone(session)); }, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 150);
  orchestra.heartbeatPublishMs = 100;
  const session = await orchestra.create({ prompt: "think hard", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "done");
  assert.ok(published.some((item) => item.status === "running" && item.lastActivityAt), "clients learn the run is alive");
  assert.equal(session.lastActivityAt, undefined, "cleared once the run ends");
});

test("without activity the watchdog still stops a silent run", async () => {
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    options.signal?.addEventListener("abort", () => resolve({ exitCode: 143, finalText: "" }), { once: true });
  });
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 60);
  const session = await orchestra.create({ prompt: "silent", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "error");
});

test("a worker heartbeat restarts the stall idle clock without counting as a tool line", () => {
  let now = 0;
  const detector = new StallDetector({ idleMs: 1_000, now: () => now });
  now = 900;
  detector.heartbeat();
  now = 1_500;
  assert.equal(detector.checkIdle(), undefined);
  now = 2_000;
  assert.equal(detector.checkIdle()?.kind, "no-progress");
});

test("activity without any session event is capped: endless retry noise fails with a specific error", async () => {
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    // Raw output forever (partial deltas, retries), but nothing that becomes a message/tool/result.
    const beat = setInterval(() => options.onActivity?.(), 20);
    options.signal?.addEventListener("abort", () => { clearInterval(beat); resolve({ exitCode: 143, finalText: "" }); }, { once: true });
  });
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 10_000);
  orchestra.quietLimitMs = 300;
  const started = Date.now();
  const session = await orchestra.create({ prompt: "retry forever", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "error");
  assert.ok(Date.now() - started < 5_000, "well before the 10s inactivity watchdog");
  assert.match(session.events.at(-1)?.text ?? "", /메시지·도구·결과 이벤트가 없어/);
});
