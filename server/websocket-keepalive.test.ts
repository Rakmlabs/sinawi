// M3/M4: a window that stops answering pings is closed (it no longer counts as an open app window),
// a live one stays, and a server whose data could not be loaded stays up and says why.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { injectRequest } from "./app-tools.js";
import { createServer } from "./server.js";
import { appKey } from "./app-key.js";

const ORIGIN = `http://127.0.0.1:${process.env.SINAWI_PORT ?? 3001}`;

async function start(t: test.TestContext, directory: string) {
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], wsPingMs: 150 });
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { created, port: (created.httpServer.address() as { port: number }).port };
}

/**
 * Opens a window socket. `until: "message"` waits for the first sessions message (the server has the
 * window and its data); `"open"` only for the upgrade. A socket that does not answer pings may be cut
 * before the server, still loading its data under load, sends anything: waiting for a message then
 * never ended and hung the whole run for 18 minutes (third review N5). Closing early or taking longer
 * than 10 s now rejects.
 */
const connect = (port: number, autoPong: boolean, until: "open" | "message" = "message") => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`sinawi-app.${appKey()}`], { headers: { origin: ORIGIN }, autoPong });
  const timer = setTimeout(() => { socket.terminate(); reject(new Error(`no ${until} within 10 s`)); }, 10_000);
  const done = (value: WebSocket | Error) => { clearTimeout(timer); if (value instanceof Error) reject(value); else resolve(value); };
  socket.once(until, () => done(socket));
  socket.once("error", (error) => done(error));
  socket.once("close", (code) => done(new Error(`closed (${code}) before ${until}`)));
});

/** Resolves with the close code, or rejects after `ms`. */
const closeCode = (socket: WebSocket, ms = 10_000) => new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`socket still open after ${ms} ms`)), ms);
  socket.once("close", (code) => { clearTimeout(timer); resolve(code); });
});

test("a window that stops answering pings is closed; one that answers stays", { timeout: 30_000 }, async (t) => {
  const { created, port } = await start(t, await mkdtemp(join(tmpdir(), "sinawi-ws-keepalive-")));
  const live = await connect(port, true);
  // The silent window is cut by the keepalive whether or not its first message got through.
  const dead = await connect(port, false, "open");
  assert.equal(await closeCode(dead), 1006, "terminated by the server");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(live.readyState, WebSocket.OPEN);
  const health = await injectRequest(created.app as never, "GET", "/api/health") as { body: { windows: number } };
  assert.equal(health.body.windows, 1);
  live.close();
});

test("unreadable data keeps the server up: /api/health says why and a window is closed, not crashed", { timeout: 30_000 }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sinawi-start-error-"));
  const blocker = join(parent, "not-a-folder");
  await writeFile(blocker, "");
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  // The data folder sits under a file: every read fails with ENOTDIR, so loading the data rejects.
  const { created, port } = await start(t, join(blocker, "data"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const health = await injectRequest(created.app as never, "GET", "/api/health") as { body: { ok: boolean; error?: string } };
  assert.equal(health.body.ok, true, "still recognisable as Sinawi by the app");
  assert.match(health.body.error ?? "", /ENOTDIR|not a directory/iu);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`sinawi-app.${appKey()}`], { headers: { origin: ORIGIN } });
  assert.equal(await closeCode(socket), 1011);
});

test("a window that fell behind gets an edited event again once it drains, not only new ones", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-ws-behind-"));
  const options = { dataDir: directory, modelHomeDir: directory, availableAgents: ["claude" as const], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], wsPingMs: 150, wsBufferLimit: 8 * 1024 * 1024 };
  const created = createServer(options);
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const port = (created.httpServer.address() as { port: number }).port;
  const window = await connect(port, true);
  try {
    const received: any[] = [];
    window.on("message", (data) => received.push(JSON.parse(String(data))));
    const orchestra = created.orchestra as unknown as { sessions: Map<string, any>; publish: (session: any, options?: { full?: boolean }) => void };
    const time = new Date().toISOString();
    const session = { id: "behind-1", title: "t", status: "done", agent: "claude", workers: [], cwd: directory, workspaceId: "default", createdAt: time, events: [{ id: "e1", type: "message", agent: "user", text: "hello", time }] };
    orchestra.sessions.set(session.id, session);
    orchestra.publish(session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(received.some((message) => message.session?.id === "behind-1"));

    options.wsBufferLimit = -1; // every send now finds the buffer full
    session.events[0].text = "edited"; // same last event id
    orchestra.publish(session, { full: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!received.some((message) => message.session?.events?.[0]?.text === "edited"), "skipped while behind");

    options.wsBufferLimit = 8 * 1024 * 1024;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const caughtUp = received.find((message) => message.session?.id === "behind-1" && message.session.events?.[0]?.text === "edited");
    assert.ok(caughtUp, "the edit arrives with the catch-up");
    assert.ok(!caughtUp.incremental, "sent whole");
  } finally { window.terminate(); }
});
