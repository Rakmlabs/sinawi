import assert from "node:assert/strict";
import { mediaBlockedMessage } from "./workspace-policy.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Express } from "express";
import { createServer } from "./server.js";
import { defaultRoutingSettings } from "./routing.js";
import { loadGroups, loadSessions, loadWorkspaceState, mutateGroups, saveSessions, saveWorkspaceState } from "./store.js";
import type { Session } from "./types.js";
import { saveProviderQuota } from "./quota.js";
import { envVar } from "./runtime.js";

// These fixtures predate configurable workspaces and use the legacy personal/company pair.
const seedLegacyWorkspaces = (directory: string) => saveWorkspaceState({ currentWorkspaceId: "personal", workspaces: [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }], defaults: { personal: {}, company: {} } }, directory);


// Exercise Express and JSON middleware without requiring a TCP listener.
function request(app: Express, method: string, path: string, body?: unknown, origin?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...(origin ? { origin } : {}), ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req);
    res.assignSocket(socket as never);
    res.on("error", reject);
    socket.on("error", reject);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No response: ${method} ${path}`)); }, 3000);
    res.on("finish", () => {
      clearTimeout(timer);
      try {
        const payload = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
        resolve({ status: res.statusCode, body: payload ? (String(res.getHeader("content-type")).includes("application/json") ? JSON.parse(payload) : payload) : undefined });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    app(req, res);
    if (json) req.push(json);
    req.complete = true;
    req.push(null);
  });
}

test("production serves the built frontend alongside guarded API and identifies reusable servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-production-"));
  const staticDir = join(directory, "dist");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Sinawi fixture</title>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log('bundled asset');");
  const options = { dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); } };
  const production = createServer({ ...options, staticDir });
  const development = createServer(options);
  try {
    const health = await request(production.app, "GET", "/api/health");
    assert.deepEqual(health, { status: 200, body: { ok: true, app: "sinawi", mode: "production", running: 0, version: envVar("SERVER_VERSION") ?? "", windows: 0 } });
    assert.deepEqual(await request(production.app, "GET", "/health"), health);
    assert.equal((await request(development.app, "GET", "/api/health")).body.mode, "development");
    assert.deepEqual(await request(development.app, "GET", "/health"), { status: 200, body: { ok: true, app: "sinawi", mode: "development", running: 0, version: envVar("SERVER_VERSION") ?? "", windows: 0 } });
    assert.equal((await request(development.app, "GET", "/")).status, 404);
    for (const route of ["/", "/conversation/example", "/usage"]) {
      const response = await request(production.app, "GET", route);
      assert.equal(response.status, 200);
      assert.match(response.body, /Sinawi fixture/);
    }
    assert.match((await request(production.app, "GET", "/assets/app.js")).body, /bundled asset/);
    for (const route of ["/assets/missing.js", "/api/missing", "/ws"]) {
      assert.equal((await request(production.app, "GET", route)).status, 404, route);
    }
    for (const route of ["/", "/api/health"]) {
      assert.equal((await request(production.app, "GET", route, undefined, "https://example.com")).status, 403);
    }
  } finally {
    production.websocket.close();
    development.websocket.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace API filters sessions and groups and persists workspace defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspace-api-"));
  const base = { agent: "codex" as const, workers: ["claude" as const], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [] };
  await saveSessions([
    { ...base, id: "personal-session", title: "Personal", workspaceId: "personal", groupId: "personal-group" },
    { ...base, id: "company-session", title: "Company", workspaceId: "company", groupId: "company-group" },
  ], directory);
  await mutateGroups((groups) => groups.push(
    { id: "personal-group", name: "Personal", createdAt: base.createdAt, workspaceId: "personal" },
    { id: "company-group", name: "Company", createdAt: base.createdAt, workspaceId: "company" },
  ), directory);
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  try {
    assert.deepEqual((await request(app, "GET", "/api/sessions?workspace=company")).body.map((item: Session) => item.id), ["company-session"]);
    assert.deepEqual((await request(app, "GET", "/api/groups?workspace=personal")).body.map((item: any) => item.id), ["personal-group"]);
    assert.deepEqual((await request(app, "GET", "/api/bootstrap?workspace=company")).body.groups.map((item: any) => item.id), ["company-group"]);
    assert.equal((await request(app, "GET", "/api/sessions?workspace=invalid")).status, 400);

    const updated = await request(app, "PATCH", "/api/workspaces", {
      currentWorkspaceId: "company",
      workspaceId: "company",
      defaults: { cwd: "/company", mode: "manual", agent: "claude", workers: ["codex"], autoSwitch: false },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.currentWorkspaceId, "company");
    assert.equal(updated.body.defaults.company.cwd, "/company");
    const { runningByWorkspace, ...persisted } = updated.body;
    assert.deepEqual(runningByWorkspace, { personal: 0, company: 0 });
    assert.deepEqual(await loadWorkspaceState(directory), persisted);

    const beforeInvalid = structuredClone(persisted);
    const invalidSnapshot = await request(app, "PATCH", "/api/workspaces", {
      currentWorkspaceId: "personal",
      defaultsByWorkspace: { personal: { cwd: "/new-personal", mode: "auto" }, company: { mode: "broken" } },
    });
    assert.equal(invalidSnapshot.status, 400);
    assert.deepEqual(await loadWorkspaceState(directory), beforeInvalid);

    const snapshot = await request(app, "PATCH", "/api/workspaces", {
      currentWorkspaceId: "personal",
      defaultsByWorkspace: { personal: { cwd: "/new-personal", mode: "auto" }, company: { cwd: "/new-company", mode: "manual" } },
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.defaults.personal.cwd, "/new-personal");
    assert.equal(snapshot.body.defaults.company.cwd, "/new-company");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("moving a session detaches it while moving a group carries its sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspace-move-"));
  const base = { agent: "codex" as const, workers: ["claude" as const], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal" as const };
  await saveSessions([
    { ...base, id: "single", title: "Single", groupId: "group-1" },
    { ...base, id: "grouped", title: "Grouped", groupId: "group-1" },
  ], directory);
  await mutateGroups((groups) => groups.push({ id: "group-1", name: "Project", createdAt: base.createdAt, workspaceId: "personal" }), directory);
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  try {
    const movedSession = await request(app, "PATCH", "/api/sessions/single/workspace", { workspaceId: "company" });
    assert.equal(movedSession.status, 200);
    assert.equal(movedSession.body.workspaceId, "company");
    assert.equal(movedSession.body.groupId, undefined);

    const movedGroup = await request(app, "PATCH", "/api/groups/group-1/workspace", { workspaceId: "company" });
    assert.equal(movedGroup.status, 200);
    assert.equal(movedGroup.body.workspaceId, "company");
    assert.equal((await loadGroups(directory))[0].workspaceId, "company");
    const sessions = await loadSessions(directory);
    assert.equal(sessions.find((item) => item.id === "grouped")?.workspaceId, "company");
    assert.equal(sessions.find((item) => item.id === "grouped")?.groupId, "group-1");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("group mutations broadcast a complete groups snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-group-broadcast-"));
  await seedLegacyWorkspaces(directory);
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  const messages: any[] = [];
  const client = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) };
  (websocket.clients as Set<any>).add(client);
  try {
    const created = await request(app, "POST", "/api/groups", { name: "Project", workspaceId: "personal" });
    assert.equal(created.status, 201);
    assert.deepEqual(messages.at(-1), { type: "groups", groups: [created.body] });

    const renamed = await request(app, "PATCH", `/api/groups/${created.body.id}`, { name: "Renamed" });
    assert.equal(renamed.status, 200);
    assert.equal(messages.at(-1).groups[0].name, "Renamed");

    assert.equal((await request(app, "PATCH", `/api/groups/${created.body.id}/workspace`, { workspaceId: "company" })).status, 200);
    assert.equal(messages.at(-1).groups[0].workspaceId, "company");

    assert.equal((await request(app, "DELETE", `/api/groups/${created.body.id}`)).status, 204);
    assert.deepEqual(messages.at(-1), { type: "groups", groups: [] });
  } finally {
    (websocket.clients as Set<any>).delete(client); websocket.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed group session persistence rolls ownership back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-group-rollback-"));
  const base = { agent: "codex" as const, workers: ["claude" as const], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal" as const };
  await saveSessions([{ ...base, id: "grouped", title: "Grouped", groupId: "group-1" }], directory);
  await mutateGroups((groups) => groups.push({ id: "group-1", name: "Project", createdAt: base.createdAt, workspaceId: "personal" }), directory);
  let failSaves = false;
  const { app, orchestra, websocket } = createServer({
    dataDir: directory, modelHomeDir: directory, availableAgents: [], routingSkillLoader: async () => [],
    modelRunner: async () => { throw new Error("No CLI in fixture"); },
    sessionSaver: async (sessions, target) => {
      if (failSaves) throw new Error("fixture persistence failure");
      await saveSessions(sessions, target);
    },
  });
  try {
    await request(app, "GET", "/api/sessions");
    failSaves = true;
    const moved = await request(app, "PATCH", "/api/groups/group-1/workspace", { workspaceId: "company" });
    assert.equal(moved.status, 400);
    assert.equal((await loadGroups(directory))[0].workspaceId, "personal");
    assert.equal(orchestra.get("grouped")?.workspaceId, "personal");
    assert.equal(orchestra.get("grouped")?.groupId, "group-1");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("session API renames completed sessions and deletes them from persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-session-api-"));
  const session: Session = {
    id: "session-1",
    title: "Original",
    agent: "codex",
    workers: ["claude"],
    cwd: directory,
    status: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    events: [],
    workspaceId: "personal",
  };
  await saveSessions([session], directory);
  const { app, websocket } = createServer({
    dataDir: directory,
    modelHomeDir: directory,
    modelRunner: async () => { throw new Error("No CLI in fixture"); },
    availableAgents: [],
    routingSkillLoader: async () => [],
  });

  try {
    const team = await request(app, "PATCH", "/api/sessions/session-1/team", {
      agent: "claude",
      model: "sonnet",
      reasoningEffort: "high",
      workers: ["codex"],
      workerConfigs: [{ agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "low", sessionMode: "new" }],
    });
    assert.equal(team.status, 200);
    assert.equal(team.body.agent, "claude");
    assert.equal(team.body.workerConfigs[0].sessionMode, "new");
    assert.equal((await loadSessions(directory))[0]?.workerConfigs?.[0].sessionMode, "new");
    assert.equal((await request(app, "PATCH", "/api/sessions/session-1/team", { agent: "claude", workers: ["codex"], workerConfigs: [{ agent: "codex", sessionMode: "invalid" }] })).status, 400);
    assert.deepEqual(team.body.workers, ["codex"]);
    assert.equal(team.body.events.at(-1).type, "handoff");
    assert.equal((await loadSessions(directory))[0]?.agent, "claude");
    const sameAgent = await request(app, "PATCH", "/api/sessions/session-1/team", { agent: "claude", workers: ["claude"] });
    assert.equal(sameAgent.status, 200);
    assert.equal(sameAgent.body.workerConfigs[0].id, "claude");

    const renamed = await request(app, "PATCH", "/api/sessions/session-1", { title: "Renamed" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, "Renamed");
    assert.equal((await loadSessions(directory))[0]?.title, "Renamed");

    const deleted = await request(app, "DELETE", "/api/sessions/session-1");
    assert.equal(deleted.status, 204);
    assert.deepEqual(await loadSessions(directory), []);
    assert.equal((await request(app, "DELETE", "/api/sessions/session-1")).status, 404);
  } finally {
    websocket.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routing API persists settings and returns an editable recommendation without starting execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-routing-api-"));
  const calls: string[] = [];
  const { app, orchestra, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, modelRunner: async () => { throw new Error("No CLI in fixture"); }, availableAgents: ["codex", "claude"], routingSkillLoader: async () => [], routingRunner: async (options) => {
    assert.equal(options.readOnly, true, "recommendation must use an enforced analysis profile");
    calls.push(options.prompt);
    return { exitCode: 0, finalText: JSON.stringify({ planner: { agent: "codex", reason: "테스트 계획" }, orchestrator: { agent: "claude", reason: "검토" }, workers: [{ agent: "codex", reason: "구현" }], skills: [], reason: "맞춤 팀" }) };
  } });
  try {
    const settings = structuredClone(defaultRoutingSettings);
    settings.planner = { agent: "codex", model: "custom-model", reasoningEffort: "high" };
    assert.equal((await request(app, "PUT", "/api/settings", settings)).status, 200);
    assert.equal((await request(app, "GET", "/api/settings")).body.planner.model, "custom-model");
    assert.equal(JSON.parse(await readFile(join(directory, "routing-settings.json"), "utf8")).planner.agent, "codex");
    const recommendation = await request(app, "POST", "/api/route", { prompt: "기능 구현", cwd: directory });
    assert.equal(recommendation.status, 200);
    assert.equal(recommendation.body.source, "planner");
    assert.equal(recommendation.body.orchestrator.agent, "claude");
    assert.equal(recommendation.body.workers[0].agent, "codex");
    assert.equal(calls.length, 1);
    assert.equal(orchestra.list().length, 0, "recommendation must wait for explicit execution");
    assert.equal((await request(app, "POST", "/api/route", { prompt: "missing cwd" })).status, 400);
    assert.equal((await request(app, "PUT", "/api/settings", { planner: { agent: "invalid" } })).status, 400);
    assert.equal((await request(app, "POST", "/api/route", { prompt: "request", cwd: directory }, "https://example.com")).status, 403);
    await writeFile(join(directory, "routing-settings.json"), "{invalid json");
    assert.equal((await request(app, "GET", "/api/settings")).status, 500);
    assert.equal((await request(app, "POST", "/api/route", { prompt: "구현", cwd: directory })).status, 400);
    assert.equal(await readFile(join(directory, "routing-settings.json"), "utf8"), "{invalid json");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("limits API reads provider state and refreshes Claude with a minimal Haiku probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-limits-api-"));
  const sessionDirectory = join(directory, ".codex", "sessions");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "latest.jsonl"), JSON.stringify({
    timestamp: "2026-10-30T12:00:00Z",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 15, window_minutes: 300 } } },
  }) + "\n");
  let probes = 0;
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const { app, websocket } = createServer({
    dataDir: directory, modelHomeDir: directory, availableAgents: [],
    modelRunner: async () => { throw new Error("No CLI in fixture"); },
    limitsRunner: async (options) => {
      probes++;
      assert.equal(options.agent, "claude");
      assert.equal(options.prompt, ".");
      assert.equal(options.model, "haiku");
      await probeGate;
      await saveProviderQuota({ agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 27 }], updatedAt: "2026-10-30T12:01:00Z", source: "claude-stream" }, directory);
      return { exitCode: 0, finalText: "." };
    },
  });
  try {
    const before = await request(app, "GET", "/api/limits");
    assert.equal(before.status, 200);
    assert.equal(before.body.providers.find((provider: any) => provider.agent === "codex").windows[0].remainingPercent, 85);
    assert.equal(before.body.providers.find((provider: any) => provider.agent === "grok").unavailableReason, "남은 한도 정보 제공 안 함");
    const firstRefresh = request(app, "POST", "/api/limits/refresh", {});
    const secondRefresh = request(app, "POST", "/api/limits/refresh", {});
    for (let attempt = 0; attempt < 20 && probes === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    releaseProbe?.();
    const [refreshed, alsoRefreshed] = await Promise.all([firstRefresh, secondRefresh]);
    assert.equal(refreshed.status, 200);
    assert.equal(alsoRefreshed.status, 200);
    assert.equal(probes, 1);
    assert.equal(refreshed.body.providers.find((provider: any) => provider.agent === "claude").windows[0].remainingPercent, 27);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("settings API discovers at startup and refreshes catalogs and auth without changing saved rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-model-api-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules[0].label = "사용자 배정 규칙";
  await writeFile(join(directory, "routing-settings.json"), JSON.stringify(settings));
  let grokOutput = "You are not authenticated";
  let grokCalls = 0;
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, authDiscovery: { sleep: async () => {} }, modelRunner: async (_command, args) => {
    if (args[0] === "models") { grokCalls++; return { stdout: grokOutput }; }
    return { stdout: "" };
  } });
  try {
    const initial = await request(app, "GET", "/api/settings");
    assert.equal(initial.status, 200);
    assert.equal(grokCalls, 2, "startup retries explicit unauthenticated results once");
    assert.equal(initial.body.modelOptions.grok.authDetail, "Grok 로그인 필요: 터미널에서 grok login");
    grokOutput = "* grok-4.7 (default)\n- grok-4.6";
    const refresh = await request(app, "POST", "/api/settings/models/refresh", {});
    assert.equal(refresh.status, 200);
    assert.deepEqual(refresh.body.modelOptions.grok.models, ["grok-4.7", "grok-4.6"]);
    assert.equal(refresh.body.modelOptions.grok.authStatus, "authenticated");
    assert.equal(refresh.body.rules[0].label, "사용자 배정 규칙");
    const loaded = await request(app, "GET", "/api/settings");
    assert.deepEqual(loaded.body.modelOptions.grok.models, ["grok-4.7", "grok-4.6"]);
    assert.equal(grokCalls, 3, "reading settings must reuse the discovered catalog");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "routing-settings.json"), "utf8")), settings);
    assert.equal((await request(app, "POST", "/api/settings/models/refresh", {}, "https://example.com")).status, 403);
    assert.equal(grokCalls, 3);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("auto handoff undo API restores the persisted team and rejects stale undo or invalid preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-auto-undo-api-"));
  const previousConfig = { agent: "codex" as const, model: "original", workers: ["claude" as const] };
  await saveSessions([{
    id: "auto-session", title: "Auto", agent: "claude", workers: ["codex"], cwd: directory,
    status: "done", createdAt: new Date().toISOString(), mode: "auto", autoSwitch: true, turnCount: 4, workspaceId: "personal",
    lastAutoSwitchTurn: 3, events: [{ id: "auto-event", sessionId: "auto-session", agent: "claude",
      type: "handoff", text: "오케스트라 변경: Codex → Claude (기획)", time: new Date().toISOString(),
      metadata: { auto: true, from: "codex", to: "claude", reason: "기획", previousConfig } }],
  }], directory);
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [],
    modelRunner: async () => { throw new Error("No CLI in fixture"); } });
  try {
    assert.equal((await request(app, "POST", "/api/sessions/auto-session/messages", { prompt: "ignored", mode: "invalid" })).status, 400);
    assert.equal((await request(app, "POST", "/api/sessions/auto-session/messages", { prompt: "ignored", autoSwitch: "false" })).status, 400);
    const undo = await request(app, "POST", "/api/sessions/auto-session/handoff/undo", { eventId: "auto-event" });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.agent, "codex");
    assert.equal(undo.body.model, "original");
    assert.equal(undo.body.lastAutoSwitchTurn, 4);
    assert.equal(undo.body.events.at(-1).metadata?.auto, undefined);
    const [saved] = await loadSessions(directory);
    assert.equal(saved.agent, "codex");
    assert.equal(saved.lastAutoSwitchTurn, 4);
    assert.equal(saved.events[0].metadata?.undone, true);
    assert.equal((await request(app, "POST", "/api/sessions/auto-session/handoff/undo", { eventId: "auto-event" })).status, 400);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("skills API isolates selected project folders and refresh bypasses cached discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-skills-api-"));
  const cwd = join(directory, "project");
  const other = join(directory, "other");
  const skillDir = join(cwd, ".agents", "skills", "fixture");
  await mkdir(skillDir, { recursive: true });
  await mkdir(other);
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: next14-fixture\ndescription: Initial\n---\nProject instructions");
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); } });
  try {
    const first = await request(app, "GET", `/api/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(first.status, 200);
    const skill = first.body.find((item: any) => item.name === "next14-fixture");
    assert.deepEqual(skill.agents, ["codex"]);
    assert.equal(skill.content, undefined, "public endpoint excludes instruction contents");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: next14-fixture\ndescription: Refreshed\n---\nNew instructions");
    const refreshed = await request(app, "POST", "/api/skills/refresh", { cwd });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.find((item: any) => item.name === "next14-fixture").description, "Refreshed");
    const otherSkills = await request(app, "GET", `/api/skills?cwd=${encodeURIComponent(other)}`);
    assert.ok(!otherSkills.body.some((item: any) => item.name === "next14-fixture"));
    assert.equal((await request(app, "POST", "/api/skills/refresh", { cwd: join(directory, "missing") })).status, 400);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("workspace allowed agents persist and company routing excludes Codex in every role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-policy-api-"));
  await seedLegacyWorkspaces(directory);
  const updatedAt = new Date().toISOString();
  await saveProviderQuota({ agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 3 }], updatedAt }, directory);
  await saveProviderQuota({ agent: "grok", windows: [{ key: "weekly", label: "주간", remainingPercent: 4 }], updatedAt }, directory);
  const invoked: any[] = [];
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["codex", "claude", "grok"], modelRunner: async () => { throw new Error("fixture"); }, routingSkillLoader: async () => [], routingRunner: async (options) => {
    invoked.push(options);
    return { exitCode: 0, finalText: JSON.stringify({ planner: { agent: "codex", reason: "plan" }, orchestrator: { agent: "codex", reason: "code" }, workers: [{ agent: "claude", reason: "review" }], skills: [], reason: "team" }) };
  } });
  try {
    const saved = await request(app, "PATCH", "/api/workspaces", { workspaceId: "company", defaults: { allowedAgents: ["claude", "grok"] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.defaults.company.allowedAgents, ["claude", "grok"]);
    assert.equal((await request(app, "PATCH", "/api/workspaces", { workspaceId: "company", defaults: { allowedAgents: ["invalid"] } })).status, 400);
    const settings = structuredClone(defaultRoutingSettings);
    settings.planner = { agent: "codex" };
    assert.equal((await request(app, "PUT", "/api/settings", settings)).status, 200);
    const routed = await request(app, "POST", "/api/route", { workspaceId: "company", cwd: directory, prompt: "리팩터 구현" });
    assert.equal(routed.status, 200);
    assert.ok(invoked.length);
    assert.ok(invoked.every((options) => options.agent !== "codex"));
    assert.ok([routed.body.planner, routed.body.orchestrator, ...routed.body.workers].every((selection) => selection.agent !== "codex"));
    assert.equal(invoked[0].usageContext.workspaceId, "company");
    assert.equal(invoked[0].usageContext.role, "router");
    const blocked = await request(app, "POST", "/api/sessions", { workspaceId: "company", cwd: directory, prompt: "hello", agent: "codex", workers: ["claude"] });
    assert.equal(blocked.status, 400);
    const usage = await request(app, "GET", "/api/usage");
    assert.equal(usage.status, 200);
    assert.deepEqual(usage.body, { runs: [] });
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test('workspace quota fallback settings persist and reject invalid policies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-fallback-settings-'));
  await seedLegacyWorkspaces(directory);
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error('fixture'); } });
  try {
    const defaults = { quotaFallback: false, quotaThreshold: 7, fallbackOrder: { codex: ['grok', 'claude'] } };
    const saved = await request(app, 'PATCH', '/api/workspaces', { workspaceId: 'personal', defaults });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.defaults.personal, defaults);
    for (const invalid of [{ quotaThreshold: -1 }, { quotaThreshold: 101 }, { quotaThreshold: '3' }, { quotaFallback: 'yes' }, { fallbackOrder: { codex: ['bad'] } }, { fallbackOrder: { bad: ['claude'] } }]) {
      assert.equal((await request(app, 'PATCH', '/api/workspaces', { workspaceId: 'personal', defaults: invalid })).status, 400);
    }
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test('router respects workspace fallback threshold instead of the old ten-percent filter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-router-threshold-'));
  const calls: string[] = [];
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ['codex', 'claude'], modelRunner: async (_command, args) => ({ stdout: args.includes('status') ? 'Logged in authenticated' : '', stderr: '' }), routingRunner: async (options) => { calls.push(options.agent); return { exitCode: 1, finalText: 'fixture' }; } });
  try {
    await saveProviderQuota({ agent: 'codex', updatedAt: new Date().toISOString(), windows: [{ key: 'five', label: 'five', remainingPercent: 5 }] }, directory);
    await request(app, 'PATCH', '/api/workspaces', { workspaceId: 'personal', defaults: { quotaThreshold: 3 } });
    await request(app, 'PUT', '/api/settings', { ...defaultRoutingSettings, planner: { agent: 'codex' } });
    const response = await request(app, 'POST', '/api/route', { prompt: '검토해 주세요', cwd: directory });
    assert.equal(response.status, 200);
    assert.equal(calls[0], 'codex');
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Claude defaults and media capability constraints survive quota and workspace filtering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-route-api-"));
  let classifierCalls = 0;
  const { app, websocket } = createServer({
    dataDir: directory, modelHomeDir: directory, availableAgents: ["codex", "claude", "grok"],
    routingSkillLoader: async () => [{ id: "shorts-hash", name: "marketing-shorts", source: "Test", description: "" }],
    modelRunner: async (_command, args) => ({ stdout: args.includes("models") ? "- grok-4.7 (default)" : "Logged in authenticated" }),
    routingRunner: async () => { classifierCalls++; return { exitCode: 1, finalText: "fixture" }; },
  });
  try {
    const route = (prompt: string) => request(app, "POST", "/api/route", { prompt, cwd: directory });
    const initial = await route("평범한 요청");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.orchestrator.agent, "claude");
    const media = await route("쇼츠 만들어줘");
    assert.equal(media.status, 200);
    assert.deepEqual(media.body.workers.map((worker: any) => worker.agent), ["grok", "codex"]);
    assert.ok(media.body.skills.includes("shorts-hash"));
    assert.equal(classifierCalls, 1);

    for (const agent of ["grok", "codex"] as const) {
      await saveProviderQuota({ agent, updatedAt: new Date().toISOString(), windows: [{ key: "active", label: "active", remainingPercent: 0, resetsAt: Date.now() / 1000 + 3600 }] }, directory);
    }
    const quotaDefault = await route("평범한 요청");
    assert.equal(quotaDefault.status, 200);
    assert.equal(quotaDefault.body.orchestrator.agent, "claude", "one eligible provider must suffice");
    const blocked = await route("이미지 생성해줘");
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /Grok 조정자를 사용할 수 없습니다/);

    await request(app, "PATCH", "/api/workspaces", { workspaceId: "personal", defaults: { quotaFallback: false, allowedAgents: ["claude"] } });
    const restricted = await route("마케팅 영상 만들어줘");
    assert.equal(restricted.status, 400);
    assert.match(restricted.body.error, /Grok 조정자를 사용할 수 없습니다/);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("manual media execution refuses to start when Grok is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-manual-media-"));
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude", "codex"], modelRunner: async () => { throw new Error("fixture unavailable"); } });
  try {
    const result = await request(app, "POST", "/api/sessions", { prompt: "광고 영상을 만들어줘", agent: "claude", workers: ["codex"], cwd: directory, mode: "manual" });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Grok 조정자를 사용할 수 없습니다/);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("migrated company settings reject detected and media-rule requests before creating or continuing sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next22-company-media-"));
  const companySession: Session = {
    id: "company-media-session", title: "Company", agent: "claude", workers: ["grok"], cwd: directory,
    status: "done", createdAt: "2026-10-30T00:00:00.000Z", endedAt: "2026-10-30T00:01:00.000Z",
    events: [{ id: "existing", sessionId: "company-media-session", agent: "user", type: "message", text: "기존 요청", time: "2026-10-30T00:00:00.000Z" }],
    workspaceId: "company",
  };
  await saveSessions([companySession], directory);
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules.push({
    id: "image", label: "사내 이미지 규칙", keywords: ["/render\\s+asset/i"],
    orchestrator: "grok", workers: ["grok"], reason: "fixture",
  });
  await writeFile(join(directory, "routing-settings.json"), JSON.stringify(settings));
  let launches = 0;
  const { app, orchestra, websocket } = createServer({
    dataDir: directory, modelHomeDir: directory, availableAgents: [], routingSkillLoader: async () => [],
    modelRunner: async () => { throw new Error("No CLI in fixture"); },
    routingRunner: async () => { launches++; return { exitCode: 0, finalText: "{}" }; },
  });
  // An install from before workspace settings: the migrated company workspace keeps media off.
  const expected = { error: mediaBlockedMessage, code: "workspace-policy" };
  try {
    const routed = await request(app, "POST", "/api/route", { workspaceId: "company", prompt: "이미지 생성해줘", cwd: directory });
    assert.deepEqual(routed, { status: 400, body: expected });

    const created = await request(app, "POST", "/api/sessions", {
      workspaceId: "company", prompt: "광고 영상을 만들어줘", cwd: directory, agent: "claude", workers: ["grok"],
    });
    assert.deepEqual(created, { status: 400, body: expected });

    const before = structuredClone(orchestra.get(companySession.id));
    const continued = await request(app, "POST", `/api/sessions/${companySession.id}/messages`, { prompt: "render asset" });
    assert.deepEqual(continued, { status: 400, body: expected });
    assert.deepEqual(orchestra.get(companySession.id), before, "rejection must precede session mutation");
    assert.equal(orchestra.list().length, 1, "rejection must not create a session");
    assert.equal(launches, 0, "rejection must precede planner or agent launch");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("notifications API isolates workspaces, validates reports and supports read and clear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-notification-api-"));
  await seedLegacyWorkspaces(directory);
  const { app, websocket, notifications } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("fixture"); } });
  try {
    const created = await request(app, "POST", "/api/notifications", { workspace: "personal", type: "error", title: "터미널 오류", body: "실패", key: "terminal:load" });
    assert.equal(created.status, 201);
    await notifications.add({ workspaceId: "company", type: "info", title: "회사", body: "" });
    assert.equal((await request(app, "GET", "/api/notifications?workspace=personal")).body.length, 1);
    assert.equal((await request(app, "POST", "/api/notifications/read", { workspace: "personal", ids: [created.body.id] })).body[0].read, true);
    assert.equal((await request(app, "POST", "/api/notifications", { type: "invalid", title: "오류" })).status, 400);
    assert.equal((await request(app, "GET", "/api/notifications?workspace=invalid")).status, 400);
    assert.equal((await request(app, "POST", "/api/notifications", { type: "info", title: "오류" }, "https://evil.example")).status, 403);
    assert.equal((await request(app, "DELETE", "/api/notifications?workspace=personal")).status, 204);
    assert.equal((await request(app, "GET", "/api/notifications?workspace=personal")).body.length, 0);
    assert.equal((await request(app, "GET", "/api/notifications?workspace=company")).body.length, 1);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("auth notifications resolve after login and focus refresh is throttled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-auth-notifications-"));
  await seedLegacyWorkspaces(directory);
  let loggedIn = false;
  let calls = 0;
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["grok"], authDiscovery: { sleep: async () => {} }, modelRunner: async (command) => {
    if (command === "grok") { calls++; return { stdout: loggedIn ? "You are logged in with grok.com." : "You are not authenticated" }; }
    return { stdout: "" };
  } });
  try {
    await request(app, "GET", "/api/settings");
    const initial = await request(app, "GET", "/api/notifications?workspace=personal");
    assert.equal(initial.body[0].action.command, "grok");
    assert.equal(calls, 2);
    loggedIn = true;
    await request(app, "POST", "/api/settings/models/refresh", { reason: "focus" });
    await request(app, "POST", "/api/settings/models/refresh", { reason: "focus" });
    assert.equal(calls, 3);
    assert.deepEqual((await request(app, "GET", "/api/notifications?workspace=personal")).body, []);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});
