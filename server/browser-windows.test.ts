// A browser window the user moved out of the app window answers its workspace's agents alone, and
// tells the app window when it comes back or when elements were picked for the chat.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createServer } from "./server.js";
import { appKey } from "./app-key.js";
import { BrowserWindows, parseBrowserWindowMessage, parseBrowserWindowUrl } from "./browser-windows.js";

const ORIGIN = `http://127.0.0.1:${process.env.SINAWI_PORT ?? 3001}`;

test("only /ws/browser with a plain workspace and window id is a browser window", () => {
  assert.deepEqual(parseBrowserWindowUrl("/ws/browser?workspace=personal&id=w3k9x0ab"), { id: "w3k9x0ab", workspaceId: "personal" });
  assert.equal(parseBrowserWindowUrl("/ws"), undefined);
  assert.equal(parseBrowserWindowUrl("/ws/browser"), undefined);
  assert.equal(parseBrowserWindowUrl("/ws/browser?workspace=personal"), undefined);
  assert.equal(parseBrowserWindowUrl("/ws/browser?workspace=a%20b&id=w1"), undefined);
  assert.equal(parseBrowserWindowUrl("/ws/browser/x?workspace=personal&id=w1"), undefined);
  assert.equal(parseBrowserWindowUrl(undefined), undefined);
});

test("a browser window may only say focus, dock or attach", () => {
  assert.deepEqual(parseBrowserWindowMessage('{"type":"focus"}'), { type: "focus" });
  assert.deepEqual(parseBrowserWindowMessage('{"type":"dock","id":"other"}'), { type: "dock" });
  const element = { id: "a", kind: "element", label: "button", preview: "data:image/png;base64,AA" };
  assert.deepEqual(parseBrowserWindowMessage(JSON.stringify({ type: "attach", items: [element] })), { type: "attach", items: [element] });
  // Only things shaped like an attachment reach the composer.
  assert.deepEqual(parseBrowserWindowMessage(JSON.stringify({ type: "attach", items: [null, { id: "a" }, "x", element, [element]] })), { type: "attach", items: [element] });
  assert.equal(parseBrowserWindowMessage('{"type":"attach","items":[{"id":"a"}]}'), undefined);
  assert.equal(parseBrowserWindowMessage('{"type":"attach","items":"x"}'), undefined);
  assert.equal(parseBrowserWindowMessage('{"type":"browser-command"}'), undefined);
  assert.equal(parseBrowserWindowMessage("not json"), undefined);
  assert.equal(parseBrowserWindowMessage("[]"), undefined);
});

test("a workspace's command goes to its window the user used last, and to nobody else's", () => {
  const socket = () => ({ readyState: WebSocket.OPEN }) as WebSocket;
  const changes: number[] = [];
  const windows = new BrowserWindows((list) => changes.push(list.length));
  const [a, b, other] = [socket(), socket(), socket()];
  assert.equal(windows.target("personal"), undefined);
  windows.add(a, { id: "w1", workspaceId: "personal" });
  windows.add(b, { id: "w2", workspaceId: "personal" });
  windows.add(other, { id: "w3", workspaceId: "company" });
  assert.equal(windows.target("personal"), b, "the newest one until the user picks");
  windows.touch(a);
  assert.equal(windows.target("personal"), a);
  assert.equal(windows.target("company"), other);
  assert.equal(windows.target(undefined), undefined, "a command that names no workspace stays with the app window");
  (a as { readyState: number }).readyState = WebSocket.CLOSED;
  assert.equal(windows.target("personal"), b, "a closed socket is skipped");
  windows.remove(b); windows.remove(b);
  assert.deepEqual(windows.list(), [{ id: "w3", workspaceId: "company" }]);
  assert.deepEqual(changes, [1, 2, 3, 1], "the app window hears about every change, once, with the open windows only");
});

test("commands wait for a workspace's window that just dropped, and go to the app window only if it stays away", async () => {
  const sent: string[] = [];
  const socket = () => ({ readyState: WebSocket.OPEN, send: (message: string) => { sent.push(message); } }) as unknown as WebSocket;
  const fallen: string[] = [];
  const windows = new BrowserWindows(undefined, (message) => fallen.push(message), 60);
  assert.equal(windows.hold("personal", "c0", "m0"), false, "no window was there: nothing to wait for");
  const first = socket();
  windows.add(first, { id: "w1", workspaceId: "personal" });
  assert.equal(windows.hold("personal", "c0", "m0"), false, "its window is open: the command goes straight there");
  windows.remove(first);
  // Dropped: the workspace's commands are kept, once each (a resent command does not pile up); other workspaces are not.
  assert.equal(windows.hold("personal", "c1", "m1"), true);
  assert.equal(windows.hold("personal", "c1", "m1"), true);
  assert.equal(windows.hold("personal", "c2", "m2"), true);
  assert.equal(windows.hold("company", "c3", "m3"), false);
  assert.equal(windows.hold(undefined, "c4", "m4"), false);
  // Back in time (a reload): it gets what waited, and the app window gets nothing.
  windows.add(socket(), { id: "w1", workspaceId: "personal" });
  assert.deepEqual(sent, ["m1", "m2"]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(fallen, []);
  // Gone for good: after the grace period the app window runs what waited, and later commands are not held.
  const again = windows.target("personal")!;
  windows.remove(again);
  assert.equal(windows.hold("personal", "c5", "m5"), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(fallen, ["m5"]);
  assert.equal(windows.hold("personal", "c6", "m6"), false);
  // With a second window still open, nothing waits: that one answers.
  const [a, b] = [socket(), socket()];
  windows.add(a, { id: "w1", workspaceId: "personal" });
  windows.add(b, { id: "w2", workspaceId: "personal" });
  windows.remove(b);
  assert.equal(windows.hold("personal", "c7", "m7"), false);
  assert.equal(windows.target("personal"), a);
  windows.dispose();
});

type Frame = { type: string; [key: string]: unknown };

/** A socket with every frame it received and a way to wait for one. */
function open(url: string, key = appKey()) {
  const socket = new WebSocket(url, [`sinawi-app.${key}`], { headers: { origin: ORIGIN } });
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => { try { frames.push(JSON.parse(data.toString()) as Frame); } catch { /* not ours */ } for (const waiter of waiters.splice(0)) waiter(); });
  const next = async (match: (frame: Frame) => boolean, ms = 10_000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = frames.find(match);
      if (found) { frames.splice(frames.indexOf(found), 1); return found; }
      if (Date.now() > deadline) throw new Error(`no matching frame within ${ms} ms`);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 100))]);
    }
  };
  const opened = new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  return { socket, frames, next, opened };
}

test("the server routes a workspace's browser commands to its window outside the app, and relays what that window says", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-browser-windows-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], browserWindowGraceMs: 400 });
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const port = (created.httpServer.address() as { port: number }).port;

  const app = open(`ws://127.0.0.1:${port}/ws`);
  t.after(() => app.socket.terminate());
  assert.deepEqual((await app.next((frame) => frame.type === "browser-windows")).windows, [], "the app window starts with the list");

  // Without the app's key it is not the app: no socket.
  const stranger = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?workspace=personal&id=w1`, ["sinawi-app.nope"], { headers: { origin: ORIGIN } });
  await new Promise<void>((resolve) => { stranger.once("error", () => resolve()); stranger.once("open", () => { stranger.terminate(); assert.fail("opened without the key"); }); });

  const outside = open(`ws://127.0.0.1:${port}/ws/browser?workspace=personal&id=w1`);
  t.after(() => outside.socket.terminate());
  await outside.opened;
  assert.deepEqual((await app.next((frame) => frame.type === "browser-windows")).windows, [{ id: "w1", workspaceId: "personal" }]);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { windows: number };
  assert.equal(health.windows, 1, "a browser window is not an app window");

  // personal's agent: the window outside the app answers alone.
  const personal = created.browserBridge.request("status", {}, 5_000, "personal", "session:s1");
  const command = await outside.next((frame) => frame.type === "browser-command");
  assert.equal(command.workspaceId, "personal");
  assert.equal(command.owner, "session:s1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(app.frames.some((frame) => frame.type === "browser-command"), false, "the app window is not asked, so it opens no second browser");
  assert.equal(created.browserBridge.resolve(String(command.id), { ok: true, result: { open: true } }), true);
  assert.deepEqual(await personal, { ok: true, result: { open: true }, error: undefined });

  // Another workspace's agent: the app window, as before.
  const company = created.browserBridge.request("status", {}, 5_000, "company");
  const forApp = await app.next((frame) => frame.type === "browser-command");
  assert.equal(forApp.workspaceId, "company");
  assert.equal(outside.frames.some((frame) => frame.type === "browser-command" && frame.workspaceId === "company"), false);
  created.browserBridge.resolve(String(forApp.id), { ok: true });
  await company;

  // What the window tells the app window.
  outside.socket.send(JSON.stringify({ type: "attach", items: [{ id: "el1", kind: "element", label: "button" }] }));
  assert.deepEqual(await app.next((frame) => frame.type === "browser-attach"), { type: "browser-attach", workspaceId: "personal", items: [{ id: "el1", kind: "element", label: "button" }] });
  outside.socket.send(JSON.stringify({ type: "dock" }));
  assert.deepEqual(await app.next((frame) => frame.type === "browser-dock"), { type: "browser-dock", id: "w1", workspaceId: "personal" });

  // The window drops and is back in a moment (a reload): a command sent in between waits for it,
  // and the app window never sees it (it would open a second browser for the same work).
  outside.socket.close();
  assert.deepEqual((await app.next((frame) => frame.type === "browser-windows")).windows, []);
  const during = created.browserBridge.request("click", { ref: "e1" }, 5_000, "personal");
  const reloaded = open(`ws://127.0.0.1:${port}/ws/browser?workspace=personal&id=w1`);
  t.after(() => reloaded.socket.terminate());
  const waited = await reloaded.next((frame) => frame.type === "browser-command");
  assert.equal(waited.action, "click");
  assert.equal(app.frames.some((frame) => frame.type === "browser-command"), false);
  created.browserBridge.resolve(String(waited.id), { ok: true });
  await during;

  // Closed for good: after the grace period its workspace's commands are the app window's again.
  await app.next((frame) => frame.type === "browser-windows");
  reloaded.socket.close();
  assert.deepEqual((await app.next((frame) => frame.type === "browser-windows")).windows, []);
  const back = created.browserBridge.request("status", {}, 5_000, "personal");
  const again = await app.next((frame) => frame.type === "browser-command");
  assert.equal(again.workspaceId, "personal");
  created.browserBridge.resolve(String(again.id), { ok: true });
  await back;
});
