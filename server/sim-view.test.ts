import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { SimScreen, takeFrames } from "./sim-view.js";
import type { Exec } from "./sim-tool.js";
import { SimTouch } from "./sim-hid.js";

const UDID = "7EB6DC72-9B70-4729-AF3E-72A5E09A8113";
const part = (body: string) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`), Buffer.from(body)]);

test("takeFrames pulls whole JPEG parts and keeps a partial one for the next chunk", () => {
  const header = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n");
  const whole = Buffer.concat([header, part("AAAA"), part("BBBBBB")]);
  const cut = whole.length - 3;
  const first = takeFrames(whole.subarray(0, cut));
  assert.deepEqual(first.frames.map(String), ["AAAA"]);
  const second = takeFrames(Buffer.concat([first.rest, whole.subarray(cut)]));
  assert.deepEqual(second.frames.map(String), ["BBBBBB"]);
  assert.equal(second.rest.length, 0);
});

function fakeAxe() {
  const calls: string[][] = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;
  return { calls, child, spawnAxe: (args: string[]) => { calls.push(args); return child; } };
}

test("frames start one stream per device and report the newest frame", () => {
  const axe = fakeAxe();
  const screen = new SimScreen({ spawnAxe: axe.spawnAxe });
  assert.equal(screen.frame(UDID), undefined);
  axe.child.stdout!.emit("data", Buffer.concat([part("one"), part("two")]));
  const frame = screen.frame(UDID);
  assert.ok(frame && "seq" in frame);
  assert.equal(String(frame.jpeg), "two");
  assert.equal(axe.calls.length, 1);
  assert.deepEqual(axe.calls[0].slice(0, 3), ["stream-video", "--udid", UDID]);
  screen.stopAll();
});

test("a stream that never produced a frame reports why", () => {
  const axe = fakeAxe();
  const screen = new SimScreen({ spawnAxe: axe.spawnAxe });
  screen.frame(UDID);
  axe.child.emit("error", Object.assign(new Error("spawn axe ENOENT"), { code: "ENOENT" }));
  const frame = screen.frame(UDID);
  assert.ok(frame && "error" in frame && /AXe/u.test(frame.error));
  screen.stopAll();
});

test("panel input maps screen fractions to device points and uses held touches", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "describe-ui") return { code: 0, stdout: JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const screen = new SimScreen({ exec, spawnAxe: fakeAxe().spawnAxe });
  assert.deepEqual(await screen.input(UDID, { kind: "tap", x: 0.5, y: 0.25 }), { ok: true });
  assert.deepEqual(calls.at(-1), ["touch", "-x", "201", "-y", "219", "--down", "--up", "--delay", "0.1", "--udid", UDID]);
  await screen.input(UDID, { kind: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, duration: 9 });
  assert.deepEqual(calls.at(-1), ["drag", "--start-x", "201", "--start-y", "699", "--end-x", "201", "--end-y", "175", "--duration", "2", "--udid", UDID]);
  await screen.input(UDID, { kind: "key", key: "enter" });
  assert.deepEqual(calls.at(-1), ["key", "40", "--udid", UDID]);
  await screen.input(UDID, { kind: "type", text: "안녕" });
  assert.deepEqual(calls.at(-1), ["type", "안녕", "--udid", UDID]);
  assert.equal(calls.filter((args) => args[0] === "describe-ui").length, 1, "screen size is cached");
  assert.equal((await screen.input(UDID, { kind: "key", key: "f1" })).ok, false);
  screen.stopAll();
});

test("a frame request waits for the next frame instead of being polled", async () => {
  const axe = fakeAxe();
  const screen = new SimScreen({ spawnAxe: axe.spawnAxe });
  // Nothing captured yet: the request waits and gets the first frame the moment it arrives.
  const first = screen.nextFrame(UDID, undefined, 2_000);
  setTimeout(() => axe.child.stdout!.emit("data", part("one")), 20);
  const one = await first;
  assert.ok(one && "seq" in one && String(one.jpeg) === "one");
  // Asking for something newer than what was shown waits for the next capture.
  const started = Date.now();
  const next = screen.nextFrame(UDID, String(one.seq), 2_000);
  setTimeout(() => axe.child.stdout!.emit("data", part("two")), 30);
  const two = await next;
  assert.ok(two && "seq" in two && String(two.jpeg) === "two");
  assert.ok(Date.now() - started < 1_000, "answered by the frame, not by the timeout");
  // No newer frame in time: nothing new, and the stream asks for all the frames AXe can give.
  assert.equal(await screen.nextFrame(UDID, String(two.seq), 20), undefined);
  assert.equal(axe.calls[0][axe.calls[0].indexOf("--fps") + 1], "30");
  screen.stopAll();
});

/** A stand-in for the sim-hid helper: records the lines written to it; the test decides when each is acknowledged. */
function fakeHid(options: { auto?: boolean; error?: string } = {}) {
  const lines: Array<{ id: number; t: string; x: number; y: number }> = [];
  const stdout = new EventEmitter();
  let ended = false, killed = false;
  const say = (message: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin: Object.assign(new EventEmitter(), {
      write: (text: string) => {
        const line = JSON.parse(text) as (typeof lines)[number];
        lines.push(line);
        if (options.auto) setImmediate(() => say({ id: line.id, ok: true }));
        return true;
      },
      end: () => { ended = true; },
    }),
    kill: () => { killed = true; return true; },
  }) as unknown as ChildProcess;
  // The first line (ready, or why not) comes once someone is reading, as it does from a real process.
  stdout.once("newListener", () => setImmediate(() => say(options.error ? { error: options.error } : { ready: true })));
  return { child, lines, say, ack: (id: number) => say({ id, ok: true }), get ended() { return ended; }, get killed() { return killed; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("moves are coalesced: while one is on its way only the newest position waits", async () => {
  const hid = fakeHid();
  const touch = new SimTouch(hid.child);
  assert.equal(await touch.whenReady(), true);
  const down = touch.send("down", 0.5, 0.8);
  await tick();
  hid.ack(1);
  assert.deepEqual(await down, { ok: true });
  const first = touch.send("move", 0.5, 0.7);
  const second = touch.send("move", 0.5, 0.6);
  const third = touch.send("move", 0.5, 0.5);
  await tick();
  assert.deepEqual(hid.lines.map((line) => line.y), [0.8, 0.7], "only one move is in flight");
  assert.deepEqual(await second, { ok: true, dropped: true });
  hid.ack(2);
  assert.deepEqual(await first, { ok: true });
  await tick();
  assert.deepEqual(hid.lines.map((line) => [line.t, line.y]), [["down", 0.8], ["move", 0.7], ["move", 0.5]]);
  // An up does not wait behind a move, and makes a move still waiting pointless.
  const stale = touch.send("move", 0.5, 0.4);
  await tick();
  const up = touch.send("up", 0.5, 0.3);
  assert.deepEqual(await stale, { ok: true, dropped: true });
  await tick();
  assert.deepEqual(hid.lines.at(-1), { id: 4, t: "up", x: 0.5, y: 0.3 });
  hid.ack(3); hid.ack(4);
  assert.deepEqual(await third, { ok: true });
  assert.deepEqual(await up, { ok: true });
  touch.close();
  assert.equal(hid.ended, true, "closing stdin lets the helper lift the finger");
});

test("a helper that fails to start or dies answers every send with the reason", async () => {
  const broken = fakeHid({ error: "device not found" });
  const touch = new SimTouch(broken.child);
  assert.equal(await touch.whenReady(), false);
  assert.deepEqual(await touch.send("down", 0, 0), { ok: false, error: "device not found" });
  assert.equal(broken.killed, true);

  const hid = fakeHid();
  let dead = false;
  const live = new SimTouch(hid.child, () => { dead = true; });
  const pending = live.send("down", 0.1, 0.1);
  await tick(); await tick();
  hid.child.emit("exit", 1);
  assert.equal((await pending).ok, false);
  assert.equal(dead, true);
});

test("with the helper a drag is live: down, moves and up go to it as they arrive, and a tap never starts axe", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const hid = fakeHid({ auto: true });
  let spawned = 0;
  const screen = new SimScreen({ exec, spawnAxe: fakeAxe().spawnAxe, spawnHid: async () => { spawned += 1; return hid.child; }, tapHoldMs: 1 });
  assert.deepEqual(await screen.input(UDID, { kind: "down", x: 0.5, y: 0.8 }), { ok: true });
  assert.deepEqual(await screen.input(UDID, { kind: "move", x: 0.5, y: 0.6 }), { ok: true });
  assert.deepEqual(hid.lines.map((line) => [line.t, line.x, line.y]), [["down", 0.5, 0.8], ["move", 0.5, 0.6]], "the finger moved before release");
  assert.deepEqual(await screen.input(UDID, { kind: "up", x: 0.5, y: 0.2 }), { ok: true });
  assert.deepEqual(await screen.input(UDID, { kind: "tap", x: 2, y: -1 }), { ok: true });
  assert.deepEqual(hid.lines.slice(2).map((line) => [line.t, line.x, line.y]), [["up", 0.5, 0.2], ["down", 1, 0], ["up", 1, 0]]);
  assert.equal(spawned, 1, "one helper per device");
  assert.deepEqual(calls, [], "no axe process, not even for the screen size");
  assert.equal((await screen.input(UDID, { kind: "move", x: 0.5, y: 0.5 })).ok, false, "a move without a down is refused");
  screen.stopAll();
  await tick();
  assert.equal(hid.ended, true);
});

test("without the helper a drag is replayed by axe on release, from where it started", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "describe-ui") return { code: 0, stdout: JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let now = 1_000, spawned = 0;
  const screen = new SimScreen({ exec, spawnAxe: fakeAxe().spawnAxe, now: () => now, spawnHid: async () => { spawned += 1; return fakeHid({ error: "this Xcode has no simulator HID client" }).child; } });
  assert.deepEqual(await screen.input(UDID, { kind: "down", x: 0.5, y: 0.8 }), { ok: true });
  assert.deepEqual(await screen.input(UDID, { kind: "move", x: 0.5, y: 0.5 }), { ok: true });
  assert.deepEqual(calls, [], "nothing runs until release");
  now += 400;
  assert.deepEqual(await screen.input(UDID, { kind: "up", x: 0.5, y: 0.2 }), { ok: true });
  assert.deepEqual(calls.at(-1), ["drag", "--start-x", "201", "--start-y", "699", "--end-x", "201", "--end-y", "175", "--duration", "0.4", "--udid", UDID]);
  await screen.input(UDID, { kind: "tap", x: 0.5, y: 0.25 });
  assert.deepEqual(calls.at(-1), ["touch", "-x", "201", "-y", "219", "--down", "--up", "--delay", "0.1", "--udid", UDID]);
  assert.equal(spawned, 1, "a helper that failed is not restarted for every touch");
  now += 31_000;
  await screen.input(UDID, { kind: "tap", x: 0.5, y: 0.25 });
  assert.equal(spawned, 2, "but it is tried again later");
  screen.stopAll();
});
