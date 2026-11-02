import test from "node:test";
import assert from "node:assert/strict";
import { fractionIn, gesture, pickDevice, specialKey, type SimDevice } from "./sim-panel";

test("a press that barely moves is a tap, a longer one a drag with a bounded duration", () => {
  const size = { width: 400, height: 800 };
  assert.deepEqual(gesture({ x: 0.5, y: 0.5, t: 0 }, { x: 0.505, y: 0.5, t: 90 }, size), { kind: "tap", x: 0.5, y: 0.5 });
  assert.deepEqual(gesture({ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.2, t: 30 }, size), { kind: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, duration: 0.1 });
  assert.equal((gesture({ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 9_000 }, size) as { duration: number }).duration, 2);
});

test("pointer positions become fractions of the shown frame, nothing outside it", () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };
  assert.deepEqual(fractionIn(rect, 200, 150), { x: 0.5, y: 0.25 });
  assert.equal(fractionIn(rect, 99, 150), undefined);
  assert.equal(fractionIn({ ...rect, width: 0 }, 100, 50), undefined);
});

test("the remembered device wins, then a booted one", () => {
  const devices: SimDevice[] = [{ udid: "A", name: "iPhone 15", runtime: "iOS 17.0", booted: false }, { udid: "B", name: "iPhone 16 Pro", runtime: "iOS 18.6", booted: true }];
  assert.equal(pickDevice(devices, "A")?.udid, "A");
  assert.equal(pickDevice(devices, "gone")?.udid, "B");
  assert.equal(pickDevice([], null), undefined);
});

test("only Enter, Backspace and Tab are sent as keys", () => {
  assert.equal(specialKey("Enter"), "enter");
  assert.equal(specialKey("Backspace"), "backspace");
  assert.equal(specialKey("Tab"), "tab");
  assert.equal(specialKey("a"), undefined);
});
