import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { activeClockCount, subscribeClock } from "./app/clock";

test("clock subscribers share one interval per period and it stops with the last one", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  try {
    const a: number[] = [];
    const b: number[] = [];
    const offA = subscribeClock(1_000, (now) => a.push(now));
    const offB = subscribeClock(1_000, (now) => b.push(now));
    const offSlow = subscribeClock(60_000, () => undefined);
    assert.equal(activeClockCount(), 2);
    mock.timers.tick(1_000);
    mock.timers.tick(1_000);
    assert.deepEqual(a, [1_000, 2_000]);
    assert.deepEqual(b, [1_000, 2_000]);
    offA();
    mock.timers.tick(1_000);
    assert.equal(a.length, 2);
    assert.equal(b.length, 3);
    offB();
    offB();
    assert.equal(activeClockCount(), 1);
    offSlow();
    assert.equal(activeClockCount(), 0);
  } finally {
    mock.timers.reset();
  }
});
