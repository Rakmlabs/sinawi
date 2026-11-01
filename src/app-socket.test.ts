import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerMessage, reconnectDelay, RECONNECT_CAP_MS } from "./app/socket";

test("reconnect delay doubles per attempt with equal jitter and caps at 30s", () => {
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(0, () => 1), 1_000);
  assert.equal(reconnectDelay(1, () => 1), 2_000);
  assert.equal(reconnectDelay(3, () => 0.5), 6_000);
  assert.equal(reconnectDelay(4, () => 1), 16_000);
  assert.equal(reconnectDelay(5, () => 1), RECONNECT_CAP_MS);
  assert.equal(reconnectDelay(50, () => 1), RECONNECT_CAP_MS);
  assert.equal(reconnectDelay(50, () => 0), RECONNECT_CAP_MS / 2);
});

test("reconnect delay stays in range for any random source and bad attempts", () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const r of [0, 0.25, 0.999, -3, 7]) {
      const delay = reconnectDelay(attempt, () => r);
      const ceiling = Math.min(RECONNECT_CAP_MS, 1_000 * 2 ** attempt);
      assert.ok(delay >= ceiling / 2 && delay <= ceiling, `${attempt}/${r} -> ${delay}`);
    }
  }
  assert.equal(reconnectDelay(-2, () => 1), 1_000);
  assert.equal(reconnectDelay(Number.NaN, () => 1), 1_000);
});

test("server frames parse to typed messages and bad frames are logged and dropped", () => {
  const warnings: unknown[][] = [];
  const warn = (...args: unknown[]) => { warnings.push(args); };
  assert.deepEqual(parseServerMessage('{"type":"sessions","sessions":[]}', warn), { type: "sessions", sessions: [] });
  assert.equal(parseServerMessage("{not json", warn), undefined);
  assert.equal(parseServerMessage('"text"', warn), undefined);
  assert.equal(parseServerMessage("null", warn), undefined);
  assert.equal(parseServerMessage("[1,2]", warn), undefined);
  assert.equal(parseServerMessage('{"type":3}', warn), undefined);
  assert.equal(parseServerMessage(new ArrayBuffer(2), warn), undefined);
  assert.equal(warnings.length, 6);
});
