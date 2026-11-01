import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBots, loadGroups, loadSessions, loadToolSettings, loadWorkspaceState, mutateBots, mutateGroups, mutateToolSettings, saveSessions, saveWorkspaceState } from "./store.js";
import type { Session } from "./types.js";

test("tool settings persist disabled skills and MCP tools per workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-tool-settings-"));
  await mutateToolSettings((settings) => {
    settings.personal.disabledSkills.push("review");
    settings.company.disabledMcp.push("claude:docs");
  }, directory);
  assert.deepEqual(await loadToolSettings(directory), {
    personal: { disabledSkills: ["review"], disabledMcp: [] },
    company: { disabledSkills: [], disabledMcp: ["claude:docs"] },
  });
});

test("groups and grouped session snapshots persist as JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-store-"));
  const group = { id: "group-1", name: "프로젝트 A", createdAt: "2026-01-01T00:00:00.000Z", workspaceId: "personal" as const };
  await mutateGroups((groups) => { groups.push(group); }, directory);

  const session: Session = {
    id: "session-1", title: "작업", agent: "codex", workers: ["claude"], cwd: directory,
    status: "running", createdAt: "2026-01-01T00:00:00.000Z", events: [], groupId: group.id,
    workerSessionIds: { claude: "worker-thread" }, workerConfigs: [{ agent: "claude", sessionMode: "resume" }],
    skills: ["review"], systemPrompt: "항상 간결하게", workspaceId: "personal",
  };
  await saveSessions([session], directory);

  assert.deepEqual(await loadGroups(directory), [group]);
  const restored = await loadSessions(directory);
  assert.equal(restored[0].groupId, group.id);
  assert.equal(restored[0].status, "running");
  assert.deepEqual(restored[0].skills, ["review"]);
  assert.equal(restored[0].systemPrompt, "항상 간결하게");
  assert.equal(restored[0].endedAt, undefined);
  assert.deepEqual(restored[0].workerSessionIds, { claude: "worker-thread" });
  assert.equal(restored[0].workerConfigs?.[0].sessionMode, "resume");
});

test("legacy groups and sessions migrate to the personal workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-store-migration-"));
  await writeFile(join(directory, "groups.json"), JSON.stringify([{ id: "g1", name: "Legacy", createdAt: "2026-01-01T00:00:00.000Z" }]));
  await writeFile(join(directory, "sessions.json"), JSON.stringify([{
    id: "s1", title: "Legacy", agent: "codex", workers: ["claude"], cwd: directory,
    status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [], groupId: "g1",
  }]));

  assert.equal((await loadGroups(directory))[0].workspaceId, "personal");
  assert.equal((await loadSessions(directory))[0].workspaceId, "personal");
  assert.equal(JSON.parse(await readFile(join(directory, "groups.json"), "utf8"))[0].workspaceId, "personal");
  assert.equal(JSON.parse(await readFile(join(directory, "sessions", "s1.json"), "utf8")).workspaceId, "personal");
  assert.equal(JSON.parse(await readFile(join(directory, "sessions.json.migrated"), "utf8"))[0].id, "s1");
  assert.equal((await loadSessions(directory)).length, 1);
});

test("concurrent legacy migration reads do not collide with each other or lose group mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-store-concurrent-migration-"));
  await writeFile(join(directory, "groups.json"), JSON.stringify([{ id: "legacy", name: "Legacy", createdAt: "2026-01-01T00:00:00.000Z" }]));
  await writeFile(join(directory, "sessions.json"), JSON.stringify([{
    id: "legacy-session", title: "Legacy", agent: "codex", workers: ["claude"], cwd: directory,
    status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [],
  }]));

  const [firstGroups, secondGroups, firstSessions, secondSessions] = await Promise.all([
    loadGroups(directory), loadGroups(directory), loadSessions(directory), loadSessions(directory),
    mutateGroups((groups) => { groups.push({ id: "new", name: "New", createdAt: "2026-01-02T00:00:00.000Z", workspaceId: "company" }); }, directory),
  ]);

  assert.equal(firstGroups[0].workspaceId, "personal");
  assert.equal(secondGroups[0].workspaceId, "personal");
  assert.equal(firstSessions[0].workspaceId, "personal");
  assert.equal(secondSessions[0].workspaceId, "personal");
  assert.deepEqual((await loadGroups(directory)).map((group) => group.id), ["legacy", "new"]);
});

test("workspace selection and defaults persist independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-"));
  const initial = await loadWorkspaceState(directory);
  assert.deepEqual(initial, { currentWorkspaceId: "personal", defaults: { personal: {}, company: {} } });

  initial.currentWorkspaceId = "company";
  initial.defaults.personal = { cwd: "/personal", mode: "auto", agent: "codex", workers: ["claude"], autoSwitch: true };
  initial.defaults.company = { cwd: "/company", mode: "manual", agent: "claude", workers: ["codex"], autoSwitch: false };
  await saveWorkspaceState(initial, directory);

  assert.deepEqual(await loadWorkspaceState(directory), initial);
});

test("sessions are stored one file each and only changed sessions are rewritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-store-split-"));
  const base = { agent: "codex" as const, workers: [], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal" as const };
  const a: Session = { ...base, id: "a", title: "A" };
  const b: Session = { ...base, id: "b/../x", title: "B" };
  await saveSessions([a, b], directory);
  assert.deepEqual((await readdir(join(directory, "sessions"))).sort(), ["a.json", "b%2F..%2Fx.json"]);

  a.title = "A2";
  b.title = "B2";
  await saveSessions([a, b], directory, ["a"]);
  const stored = Object.fromEntries((await loadSessions(directory)).map((session) => [session.id, session.title]));
  assert.deepEqual(stored, { a: "A2", "b/../x": "B" });

  await saveSessions([a], directory, []);
  assert.deepEqual(await readdir(join(directory, "sessions")), ["a.json"]);
});

test("an interrupted migration keeps split files and imports only missing legacy sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-store-resume-"));
  const base = { agent: "codex" as const, workers: [], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal" as const };
  await saveSessions([{ ...base, id: "a", title: "split copy" }], directory);
  await writeFile(join(directory, "sessions.json"), JSON.stringify([{ ...base, id: "a", title: "stale" }, { ...base, id: "b", title: "only legacy" }]));
  const stored = Object.fromEntries((await loadSessions(directory)).map((session) => [session.id, session.title]));
  assert.deepEqual(stored, { a: "split copy", b: "only legacy" });
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("sessions")).sort(), ["sessions", "sessions.json.migrated"]);
});

test("bots load and persist inside the configured data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-bots-"));
  assert.deepEqual(await loadBots(directory), []);
  const bot = { id: "bot-1", name: "Reviewer", agent: "codex" as const, skills: [], systemPrompt: "", createdAt: "2026-01-01T00:00:00.000Z" };
  await mutateBots((bots) => { bots.push(bot); }, directory);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "bots.json"), "utf8")), [bot]);
  assert.deepEqual(await loadBots(directory), [bot]);
});
