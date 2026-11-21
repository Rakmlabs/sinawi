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

const ORIGIN = `http://127.0.0.1:${process.env.SINAWI_PORT ?? 3001}`;

async function start(t: test.TestContext, directory: string) {
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], wsPingMs: 150 });
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true }); });
  return { created, port: (created.httpServer.address() as { port: number }).port };
}

const connect = (port: number, autoPong: boolean) => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: ORIGIN }, autoPong });
  socket.once("message", () => resolve(socket));
  socket.once("error", reject);
});

test("a window that stops answering pings is closed; one that answers stays", async (t) => {
  const { created, port } = await start(t, await mkdtemp(join(tmpdir(), "sinawi-ws-keepalive-")));
  const live = await connect(port, true);
  const dead = await connect(port, false);
  const closed = new Promise<number>((resolve) => dead.once("close", resolve));
  assert.equal(await closed, 1006, "terminated by the server");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(live.readyState, WebSocket.OPEN);
  const health = await injectRequest(created.app as never, "GET", "/api/health") as { body: { windows: number } };
  assert.equal(health.body.windows, 1);
  live.close();
});

test("unreadable data keeps the server up: /api/health says why and a window is closed, not crashed", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sinawi-start-error-"));
  const blocker = join(parent, "not-a-folder");
  await writeFile(blocker, "");
  t.after(() => rm(parent, { recursive: true, force: true }));
  // The data folder sits under a file: every read fails with ENOTDIR, so loading the data rejects.
  const { created, port } = await start(t, join(blocker, "data"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const health = await injectRequest(created.app as never, "GET", "/api/health") as { body: { ok: boolean; error?: string } };
  assert.equal(health.body.ok, true, "still recognisable as Sinawi by the app");
  assert.match(health.body.error ?? "", /ENOTDIR|not a directory/iu);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: ORIGIN } });
  const code = await new Promise<number>((resolve) => socket.once("close", resolve));
  assert.equal(code, 1011);
});

test("a window that fell behind gets an edited event again once it drains, not only new ones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-ws-behind-"));
  const options = { dataDir: directory, modelHomeDir: directory, availableAgents: ["claude" as const], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], wsPingMs: 150, wsBufferLimit: 8 * 1024 * 1024 };
  const created = createServer(options);
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true }); });
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
