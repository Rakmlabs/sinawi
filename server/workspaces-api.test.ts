import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Express } from "express";
import { createServer, newWorkspaceId } from "./server.js";
import { loadGroups, loadSessions, loadToolSettings, loadWorkspaceState, mutateGroups, mutateToolSettings, saveSessions, saveWorkspaceState } from "./store.js";
import type { Session } from "./types.js";

function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req);
    res.assignSocket(socket as never);
    res.on("error", reject);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No response: ${method} ${path}`)); }, 3000);
    res.on("finish", () => {
      clearTimeout(timer);
      try {
        const payload = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : undefined });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    app(req, res);
    if (json) req.push(json);
    req.complete = true;
    req.push(null);
  });
}

const base = { agent: "codex" as const, workers: ["claude" as const], status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [] };
const server = (directory: string, sessionSaver?: typeof saveSessions) => createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [], sessionSaver });

test("new workspace ids come from the name, else a random ws- id", () => {
  assert.equal(newWorkspaceId("Side Project!", new Set()), "side-project");
  assert.match(newWorkspaceId("사이드", new Set()), /^ws-[0-9a-f]{8}$/);
  assert.match(newWorkspaceId("side project", new Set(["side-project"])), /^ws-[0-9a-f]{8}$/);
  assert.equal(newWorkspaceId("a".repeat(80), new Set()).length, 64);
});

test("workspaces can be created, renamed and validated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-ws-crud-"));
  await saveWorkspaceState({ currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }], defaults: { default: { cwd: "/work", allowedAgents: ["claude", "grok"], mode: "manual" } } }, directory);
  const { app, websocket } = server(directory);
  try {
    const initial = await request(app, "GET", "/api/workspaces");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.workspaces, [{ id: "default", name: "기본" }]);
    assert.deepEqual(initial.body.runningByWorkspace, { default: 0 });

    const created = await request(app, "POST", "/api/workspaces", { name: "  Side Project  " });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.workspaces, [{ id: "default", name: "기본" }, { id: "side-project", name: "Side Project" }]);
    // Defaults are copied from the current workspace.
    assert.deepEqual(created.body.defaults["side-project"], { cwd: "/work", allowedAgents: ["claude", "grok"], mode: "manual" });
    assert.equal(created.body.currentWorkspaceId, "default");
    const korean = await request(app, "POST", "/api/workspaces", { name: "회사" });
    assert.match(korean.body.workspaces[2].id, /^ws-[0-9a-f]{8}$/);
    for (const name of ["", "   ", "x".repeat(41), 3]) assert.equal((await request(app, "POST", "/api/workspaces", { name })).status, 400, String(name));

    const renamed = await request(app, "PATCH", "/api/workspaces/side-project", { name: " 사이드 " });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.workspaces[1].name, "사이드");
    assert.equal((await request(app, "PATCH", "/api/workspaces/missing", { name: "x" })).status, 404);
    assert.equal((await request(app, "PATCH", "/api/workspaces/Bad%20Id", { name: "x" })).status, 400);
    assert.equal((await request(app, "PATCH", "/api/workspaces/side-project", { name: "" })).status, 400);

    const switched = await request(app, "PATCH", "/api/workspaces", { currentWorkspaceId: "side-project" });
    assert.equal(switched.body.currentWorkspaceId, "side-project");
    assert.equal((await request(app, "PATCH", "/api/workspaces", { currentWorkspaceId: "missing" })).status, 400);
    assert.equal((await request(app, "PATCH", "/api/workspaces", { workspaceId: "missing", defaults: {} })).status, 400);
    assert.equal((await request(app, "PATCH", "/api/workspaces", { defaultsByWorkspace: { missing: {} } })).status, 400);
    const partial = await request(app, "PATCH", "/api/workspaces", { defaultsByWorkspace: { "side-project": { cwd: "/side" } } });
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.body.defaults["side-project"], { cwd: "/side" });
    assert.equal(partial.body.defaults.default.cwd, "/work");

    const { runningByWorkspace: _counts, ...persisted } = partial.body;
    assert.deepEqual(await loadWorkspaceState(directory), persisted);

    // Every workspace-scoped route rejects ids that are not in the list.
    assert.equal((await request(app, "GET", "/api/sessions?workspace=missing")).status, 400);
    assert.equal((await request(app, "POST", "/api/groups", { name: "G", workspaceId: "missing" })).status, 400);
    assert.equal((await request(app, "POST", "/api/groups", { name: "G", workspaceId: "side-project" })).status, 201);
    // Without a workspace, groups land in the current workspace.
    assert.equal((await request(app, "POST", "/api/groups", { name: "H" })).body.workspaceId, "side-project");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("deleting a workspace moves its sessions and groups and refuses the last or a running one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-ws-delete-"));
  await saveWorkspaceState({ currentWorkspaceId: "b", workspaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], defaults: { a: {}, b: { cwd: "/b" }, c: {} } }, directory);
  await saveSessions([
    { ...base, cwd: directory, id: "in-a", title: "A", workspaceId: "a" },
    { ...base, cwd: directory, id: "in-b", title: "B", workspaceId: "b", groupId: "group-b" },
    { ...base, cwd: directory, id: "in-c", title: "C", workspaceId: "c" },
  ], directory);
  await mutateGroups((groups) => { groups.push({ id: "group-b", name: "Group", createdAt: base.createdAt, workspaceId: "b" }); }, directory);
  await mutateToolSettings((settings) => { settings.b = { disabledSkills: ["x"], disabledMcp: [] }; }, directory);
  const written: string[][] = [];
  const { app, websocket, orchestra } = server(directory, async (sessions, dir, changed) => {
    if (changed) written.push([...changed]);
    await saveSessions(sessions, dir, changed);
  });
  try {
    await request(app, "GET", "/api/workspaces");
    orchestra.get("in-c")!.status = "running";
    const running = await request(app, "DELETE", "/api/workspaces/c");
    assert.equal(running.status, 409);
    assert.match(running.body.error, /실행 중/);
    assert.deepEqual((await request(app, "GET", "/api/workspaces")).body.runningByWorkspace, { a: 0, b: 0, c: 1 });
    orchestra.get("in-c")!.status = "done";

    assert.equal((await request(app, "DELETE", "/api/workspaces/missing")).status, 404);
    assert.equal((await request(app, "DELETE", "/api/workspaces/b?moveTo=missing")).status, 400);
    assert.equal((await request(app, "DELETE", "/api/workspaces/b?moveTo=b")).status, 400);

    written.length = 0;
    const deleted = await request(app, "DELETE", "/api/workspaces/b?moveTo=c");
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.workspaces.map((item: any) => item.id), ["a", "c"]);
    assert.equal(deleted.body.currentWorkspaceId, "c");
    assert.equal(deleted.body.defaults.b, undefined);
    assert.deepEqual(written.flat(), ["in-b"]);
    const sessions = await loadSessions(directory);
    assert.equal(sessions.find((item) => item.id === "in-b")?.workspaceId, "c");
    assert.equal(sessions.find((item) => item.id === "in-b")?.groupId, "group-b");
    assert.equal(sessions.find((item) => item.id === "in-a")?.workspaceId, "a");
    assert.equal((await loadGroups(directory))[0].workspaceId, "c");
    assert.equal((await loadToolSettings(directory)).b, undefined);
    assert.deepEqual((await loadWorkspaceState(directory)).workspaces.map((item) => item.id), ["a", "c"]);

    // Without moveTo, contents go to the first remaining workspace.
    assert.equal((await request(app, "DELETE", "/api/workspaces/c")).status, 200);
    const final = await loadWorkspaceState(directory);
    assert.deepEqual(final.workspaces, [{ id: "a", name: "A" }]);
    assert.equal(final.currentWorkspaceId, "a");
    assert.ok((await loadSessions(directory)).every((item: Session) => item.workspaceId === "a"));
    assert.equal((await loadGroups(directory))[0].workspaceId, "a");

    const last = await request(app, "DELETE", "/api/workspaces/a");
    assert.equal(last.status, 409);
    assert.equal((await loadWorkspaceState(directory)).workspaces.length, 1);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("session and group move routes accept any existing workspace and reject unknown ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-ws-move-"));
  await saveWorkspaceState({ currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }, { id: "client-x", name: "Client X" }], defaults: {} }, directory);
  await saveSessions([
    { ...base, cwd: directory, id: "single", title: "Single", workspaceId: "default", groupId: "group-1" },
    { ...base, cwd: directory, id: "grouped", title: "Grouped", workspaceId: "default", groupId: "group-1" },
  ], directory);
  await mutateGroups((groups) => { groups.push({ id: "group-1", name: "Project", createdAt: base.createdAt, workspaceId: "default" }); }, directory);
  const { app, websocket } = server(directory);
  try {
    assert.equal((await request(app, "PATCH", "/api/sessions/single/workspace", { workspaceId: "missing" })).status, 400);
    assert.equal((await request(app, "PATCH", "/api/sessions/single/workspace", { workspaceId: "BAD" })).status, 400);
    const moved = await request(app, "PATCH", "/api/sessions/single/workspace", { workspaceId: "client-x" });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.workspaceId, "client-x");

    assert.equal((await request(app, "PATCH", "/api/groups/group-1/workspace", { workspaceId: "missing" })).status, 400);
    assert.equal((await loadGroups(directory))[0].workspaceId, "default");
    const group = await request(app, "PATCH", "/api/groups/group-1/workspace", { workspaceId: "client-x" });
    assert.equal(group.status, 200);
    assert.equal((await loadSessions(directory)).find((item) => item.id === "grouped")?.workspaceId, "client-x");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});
