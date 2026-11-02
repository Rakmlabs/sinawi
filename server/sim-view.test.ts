import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { SimScreen, takeFrames } from "./sim-view.js";
import type { Exec } from "./sim-tool.js";

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
