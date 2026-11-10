import test from "node:test";
import assert from "node:assert/strict";
import { clampedIn, fractionIn, inputSender, pastTap, pickDevice, pressTracker, specialKey, type SimDevice, type SimInput } from "./sim-panel";

const SIZE = { width: 400, height: 800 };

test("a press that barely moves is a tap and sends nothing until release", () => {
  const sent: SimInput[] = [];
  const press = pressTracker({ x: 0.5, y: 0.5 }, (input) => sent.push(input));
  press.move({ x: 0.505, y: 0.5 }, SIZE);
  assert.deepEqual(sent, []);
  press.end({ x: 0.505, y: 0.5 });
  assert.deepEqual(sent, [{ kind: "tap", x: 0.5, y: 0.5 }]);
  assert.equal(pastTap({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, SIZE), false);
  assert.equal(pastTap({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.51 }, SIZE), true);
});

test("a drag goes down where it was pressed, follows the pointer and lifts on release", () => {
  const sent: SimInput[] = [];
  const press = pressTracker({ x: 0.5, y: 0.8 }, (input) => sent.push(input));
  press.move({ x: 0.5, y: 0.7 }, SIZE);
  press.move({ x: 0.5, y: 0.6 }, SIZE);
  // Coming back near the start is still the same drag, not a tap.
  press.move({ x: 0.5, y: 0.8 }, SIZE);
  press.end({ x: 0.5, y: 0.2 });
  assert.deepEqual(sent, [
    { kind: "down", x: 0.5, y: 0.8 }, { kind: "move", x: 0.5, y: 0.7 }, { kind: "move", x: 0.5, y: 0.6 },
    { kind: "move", x: 0.5, y: 0.8 }, { kind: "up", x: 0.5, y: 0.2 },
  ]);
});

test("a cancelled press lifts a drag where it last was and never taps", () => {
  const sent: SimInput[] = [];
  const drag = pressTracker({ x: 0.5, y: 0.8 }, (input) => sent.push(input));
  drag.move({ x: 0.5, y: 0.6 }, SIZE);
  drag.end();
  assert.deepEqual(sent.at(-1), { kind: "up", x: 0.5, y: 0.6 });
  const still: SimInput[] = [];
  pressTracker({ x: 0.5, y: 0.5 }, (input) => still.push(input)).end();
  assert.deepEqual(still, []);
});

test("inputs are posted one at a time in order, and only the newest waiting move is kept", async () => {
  const posted: SimInput[] = [];
  const release: Array<() => void> = [];
  const send = inputSender((input) => { posted.push(input); return new Promise<void>((resolve) => release.push(resolve)); });
  const step = async () => { release.shift()!(); await new Promise((resolve) => setImmediate(resolve)); };
  send({ kind: "down", x: 0.5, y: 0.8 });
  for (const y of [0.7, 0.6, 0.5]) send({ kind: "move", x: 0.5, y });
  send({ kind: "up", x: 0.5, y: 0.4 });
  send({ kind: "move", x: 0.1, y: 0.1 });
  assert.deepEqual(posted, [{ kind: "down", x: 0.5, y: 0.8 }], "nothing overtakes the request in flight");
  await step(); await step(); await step();
  assert.deepEqual(posted, [{ kind: "down", x: 0.5, y: 0.8 }, { kind: "move", x: 0.5, y: 0.5 }, { kind: "up", x: 0.5, y: 0.4 }, { kind: "move", x: 0.1, y: 0.1 }]);
});

test("a failed post is reported and the next input still goes out", async () => {
  const errors: unknown[] = [];
  const posted: string[] = [];
  const send = inputSender(async (input) => { posted.push(input.kind); if (input.kind === "down") throw new Error("boom"); }, (error) => errors.push(error));
  send({ kind: "down", x: 0, y: 0 });
  send({ kind: "up", x: 0, y: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, ["down", "up"]);
  assert.equal(errors.length, 1);
});

test("a point outside the frame is clamped to its edge", () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };
  assert.deepEqual(clampedIn(rect, 50, 250), { x: 0, y: 0.5 });
  assert.deepEqual(clampedIn(rect, 400, 900), { x: 1, y: 1 });
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
