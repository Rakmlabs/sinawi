import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  TerminalSessionManager,
  isTerminalRequestAllowed,
  type PtyProcess,
  type TerminalClient,
} from "./terminal.js";

class FakePty implements PtyProcess {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private readonly events = new EventEmitter();
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill() { this.killed = true; }
  onData(listener: (data: string) => void) {
    this.events.on("data", listener);
    return { dispose: () => this.events.off("data", listener) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.events.on("exit", listener);
    return { dispose: () => this.events.off("exit", listener) };
  }
  output(data: string) { this.events.emit("data", data); }
  exit(code: number) { this.events.emit("exit", { exitCode: code }); }
}

class FakeClient extends EventEmitter implements TerminalClient {
  readyState = 1;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); this.emit("sent", data); }
  close() { this.readyState = 3; this.emit("close"); }
  message(data: object) { this.emit("message", Buffer.from(JSON.stringify(data))); }
}

async function waitUntil(predicate: () => boolean) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

test("terminal websocket accepts only loopback clients and the app origins", () => {
  assert.equal(isTerminalRequestAllowed("127.0.0.1", "http://127.0.0.1:3001"), true);
  assert.equal(isTerminalRequestAllowed("127.0.0.1", "http://127.0.0.1:5188"), true);
  assert.equal(isTerminalRequestAllowed("::1", "http://localhost:5188"), true);
  assert.equal(isTerminalRequestAllowed("::ffff:127.0.0.1", "tauri://localhost"), true);
  assert.equal(isTerminalRequestAllowed("192.168.1.5", "http://127.0.0.1:3001"), false);
  assert.equal(isTerminalRequestAllowed("127.0.0.1", "https://evil.example"), false);
  assert.equal(isTerminalRequestAllowed("127.0.0.1", undefined), false);
});

test("terminal sessions survive reconnects, replay bounded scrollback, and route input", async () => {
  const pty = new FakePty();
  const manager = new TerminalSessionManager({ ptyFactory: async () => pty, maxBufferBytes: 8 });
  const first = new FakeClient();
  await manager.attach("tab-1", first, { cwd: process.cwd(), cols: 80, rows: 24 });
  pty.output("123456");
  pty.output("7890");
  first.close();

  const second = new FakeClient();
  await manager.attach("tab-1", second, { cwd: "/ignored", cols: 100, rows: 30 });
  assert.deepEqual(JSON.parse(second.sent[0]), { type: "ready", id: "tab-1", cwd: process.cwd() });
  assert.equal(second.sent[1], "34567890");
  assert.equal(manager.list()[0].pid, 42);
  assert.equal(manager.list()[0].alive, true);
  second.message({ type: "input", data: "ls" });
  second.message({ type: "resize", cols: 120, rows: 40 });
  assert.deepEqual(pty.writes, ["ls"]);
  assert.deepEqual(pty.resizes.at(-1), [120, 40]);

  manager.run("tab-1", "codex login");
  assert.equal(pty.writes.at(-1), "codex login\r");
  manager.delete("tab-1");
  assert.equal(pty.killed, true);
});

test("ready is sent only after the session can run commands and before scrollback replay", async () => {
  const pty = new FakePty();
  const manager = new TerminalSessionManager({ ptyFactory: async () => pty });
  const first = new FakeClient();
  await manager.attach("ready", first, { cwd: process.cwd(), cols: 80, rows: 24 });
  pty.output("prior output");
  first.close();

  const reconnect = new FakeClient();
  reconnect.on("sent", (data: string) => {
    if (data.startsWith("{") && JSON.parse(data).type === "ready") manager.run("ready", "echo runnable");
  });
  await manager.attach("ready", reconnect, { cwd: process.cwd(), cols: 80, rows: 24 });

  assert.deepEqual(JSON.parse(reconnect.sent[0]), { type: "ready", id: "ready", cwd: process.cwd() });
  assert.equal(reconnect.sent[1], "prior output");
  assert.equal(pty.writes.at(-1), "echo runnable\r");
});

test("terminal session reports exit and kills detached PTYs after inactivity", async () => {
  const pty = new FakePty();
  let cleanup: (() => void) | undefined;
  const manager = new TerminalSessionManager({
    ptyFactory: async () => pty,
    inactivityMs: 10,
    schedule: (fn) => { cleanup = fn; return 1 as unknown as NodeJS.Timeout; },
    cancelSchedule: () => undefined,
  });
  const client = new FakeClient();
  await manager.attach("tab-2", client, { cwd: process.cwd(), cols: 80, rows: 24 });
  pty.exit(7);
  assert.deepEqual(JSON.parse(client.sent.at(-1)!), { type: "exit", code: 7 });

  const detachedPty = new FakePty();
  const detachedManager = new TerminalSessionManager({
    ptyFactory: async () => detachedPty,
    inactivityMs: 10,
    schedule: (fn) => { cleanup = fn; return 1 as unknown as NodeJS.Timeout; },
    cancelSchedule: () => undefined,
  });
  const detachedClient = new FakeClient();
  await detachedManager.attach("tab-3", detachedClient, { cwd: process.cwd(), cols: 80, rows: 24 });
  detachedClient.close();
  cleanup?.();
  assert.equal(detachedPty.killed, true);
  assert.deepEqual(detachedManager.list(), []);
});

test("dead sessions are removed after their final client disconnects", async () => {
  const pty = new FakePty();
  let cleanup: (() => void) | undefined;
  const manager = new TerminalSessionManager({
    ptyFactory: async () => pty,
    schedule: (fn) => { cleanup = fn; return 1 as unknown as NodeJS.Timeout; },
    cancelSchedule: () => undefined,
  });
  const client = new FakeClient();
  await manager.attach("dead", client, { cwd: process.cwd(), cols: 80, rows: 24 });
  pty.exit(0);
  client.close();
  cleanup?.();
  assert.deepEqual(manager.list(), []);
});

test("disconnecting while spawn is pending kills the eventual PTY without retaining a session", async () => {
  const pty = new FakePty();
  let finishSpawn!: (pty: FakePty) => void;
  const manager = new TerminalSessionManager({
    ptyFactory: () => new Promise((resolve) => { finishSpawn = resolve; }),
  });
  const client = new FakeClient();
  const attached = manager.attach("pending-disconnect", client, { cwd: process.cwd(), cols: 80, rows: 24 });
  await waitUntil(() => typeof finishSpawn === "function");
  client.close();
  finishSpawn(pty);
  await assert.rejects(attached, /취소/);
  assert.equal(pty.killed, true);
  assert.deepEqual(manager.list(), []);
});

test("delete and close cancel pending spawns and kill their eventual PTYs", async () => {
  const ptys = [new FakePty(), new FakePty()];
  const resolvers: Array<(pty: FakePty) => void> = [];
  const manager = new TerminalSessionManager({
    ptyFactory: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  const deleted = manager.attach("pending-delete", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 });
  await waitUntil(() => resolvers.length === 1);
  assert.equal(manager.delete("pending-delete"), true);
  resolvers[0](ptys[0]);
  await assert.rejects(deleted, /취소/);

  const closed = manager.attach("pending-close", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 });
  await waitUntil(() => resolvers.length === 2);
  manager.close();
  resolvers[1](ptys[1]);
  await assert.rejects(closed, /취소/);
  assert.equal(ptys.every((pty) => pty.killed), true);
  assert.deepEqual(manager.list(), []);
});

test("terminal close kills every active PTY", async () => {
  const created = [new FakePty(), new FakePty()];
  const pending = [...created];
  const manager = new TerminalSessionManager({ ptyFactory: async () => pending.shift()! });
  await manager.attach("one", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 });
  await manager.attach("two", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 });
  const active = manager.list();
  assert.equal(active.length, 2);
  manager.close();
  assert.deepEqual(manager.list(), []);
  assert.equal(created.every((pty) => pty.killed), true);
});

test("terminal spawn failures are surfaced and reported for notifications", async () => {
  const reported: string[] = [];
  const manager = new TerminalSessionManager({
    ptyFactory: async () => { throw new Error("node-pty unavailable"); },
    onError: (message) => { reported.push(message); },
  });

  await assert.rejects(
    manager.attach("broken", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 }),
    /node-pty unavailable/,
  );
  assert.deepEqual(reported, ["node-pty unavailable"]);
  assert.deepEqual(manager.list(), []);
});

test("a rejected notification callback cannot become an unhandled rejection", async () => {
  let unhandled: unknown;
  const listener = (error: unknown) => { unhandled = error; };
  process.once("unhandledRejection", listener);
  const manager = new TerminalSessionManager({
    ptyFactory: async () => { throw new Error("spawn failed"); },
    onError: async () => { throw new Error("notification failed"); },
  });
  await assert.rejects(
    manager.attach("callback-failure", new FakeClient(), { cwd: process.cwd(), cols: 80, rows: 24 }),
    /spawn failed/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", listener);
  assert.equal(unhandled, undefined);
});
