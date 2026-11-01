import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyMediaPrompt, loadBots, loadGroups, loadSessions, loadToolSettings, loadWorkspaceState, mutateBots, mutateGroups, mutateToolSettings, saveSessions, saveWorkspaceState, workspaceToolSettings } from "./store.js";
import { defaultWorkspacePolicy } from "./workspace-policy.js";
import type { Session } from "./types.js";

test("tool settings persist disabled skills and MCP tools per workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-tool-settings-"));
  await mutateToolSettings((settings) => {
    workspaceToolSettings(settings, "personal").disabledSkills.push("review");
    workspaceToolSettings(settings, "company").disabledMcp.push("claude:docs");
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

test("a fresh install starts with a single default workspace and persists it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-"));
  const initial = await loadWorkspaceState(directory);
  // Everything is allowed in a fresh install.
  assert.deepEqual(initial, { currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }], defaults: { default: {} }, settings: { default: defaultWorkspacePolicy() } });
  // Persisted, so data created later cannot flip the install to the legacy pair.
  assert.deepEqual(JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")), initial);
  await saveSessions([{ id: "s", title: "S", agent: "codex", workers: [], cwd: directory, status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "default" }], directory);
  assert.deepEqual(await loadWorkspaceState(directory), initial);
});

test("an old workspaces file migrates to the personal/company pair keeping its ids and defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-legacy-"));
  await writeFile(join(directory, "workspaces.json"), JSON.stringify({ currentWorkspaceId: "company", defaults: { personal: { cwd: "/p" }, company: { cwd: "/c", allowedAgents: ["claude"] } } }));
  const migrated = await loadWorkspaceState(directory);
  assert.deepEqual(migrated, {
    currentWorkspaceId: "company",
    workspaces: [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }],
    defaults: { personal: { cwd: "/p" }, company: { cwd: "/c", allowedAgents: ["claude"] } },
    settings: {
      personal: { mediaGeneration: true, computerUse: false, grokMcp: true, blockedTools: ["claude:bbanana"], authAlertTools: ["bbanana"], mediaPrompt: legacyMediaPrompt },
      company: { mediaGeneration: false, computerUse: false, grokMcp: true, blockedTools: ["bbanana"], authAlertTools: ["bbanana"] },
    },
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")), migrated);
});

test("the exact legacy personal/company pair gets its old hard-coded rules written once as settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-policy-migration-"));
  await writeFile(join(directory, "workspaces.json"), JSON.stringify({
    currentWorkspaceId: "personal",
    workspaces: [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }],
    defaults: { personal: {}, company: { allowedAgents: ["codex", "claude"] } },
  }));
  const migrated = await loadWorkspaceState(directory);
  // Codex was filtered out of the configured list, so the setting now says exactly that.
  assert.deepEqual(migrated.defaults.company.allowedAgents, ["claude"]);
  assert.equal(migrated.settings?.company.mediaGeneration, false);
  assert.deepEqual(migrated.settings?.company.blockedTools, ["bbanana"]);
  assert.equal(migrated.settings?.personal.mediaPrompt, legacyMediaPrompt);

  // Without an allowed-agents setting only Claude and Grok ran there.
  await writeFile(join(directory, "workspaces.json"), JSON.stringify({ currentWorkspaceId: "personal", workspaces: [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }], defaults: {} }));
  assert.deepEqual((await loadWorkspaceState(directory)).defaults.company.allowedAgents, ["claude", "grok"]);

  // Once written, the settings are the user's: unblocking media and allowing Codex sticks.
  const state = await loadWorkspaceState(directory);
  state.settings!.company = { ...state.settings!.company, mediaGeneration: true, blockedTools: [] };
  state.defaults.company.allowedAgents = ["codex", "claude", "grok"];
  await saveWorkspaceState(state, directory);
  const reloaded = await loadWorkspaceState(directory);
  assert.equal(reloaded.settings?.company.mediaGeneration, true);
  assert.deepEqual(reloaded.settings?.company.blockedTools, []);
  assert.deepEqual(reloaded.defaults.company.allowedAgents, ["codex", "claude", "grok"]);
});

test("a workspace list that merely contains an id company is an ordinary install with everything allowed", async () => {
  for (const workspaces of [
    [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }, { id: "side", name: "사이드" }],
    [{ id: "company", name: "회사" }],
    [{ id: "personal", name: "Me" }, { id: "company", name: "Work" }],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-policy-other-"));
    await writeFile(join(directory, "workspaces.json"), JSON.stringify({ currentWorkspaceId: workspaces[0].id, workspaces, defaults: { company: { allowedAgents: ["codex", "claude"] } } }));
    const state = await loadWorkspaceState(directory);
    for (const { id } of workspaces) assert.deepEqual(state.settings?.[id], defaultWorkspacePolicy());
    assert.deepEqual(state.defaults.company.allowedAgents, ["codex", "claude"]);
  }
});

test("an install without a company workspace migrates to settings with everything allowed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-policy-plain-"));
  await writeFile(join(directory, "workspaces.json"), JSON.stringify({
    currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }, { id: "work", name: "Work" }], defaults: { default: { allowedAgents: ["claude"] } },
  }));
  const state = await loadWorkspaceState(directory);
  assert.deepEqual(state.settings, { default: defaultWorkspacePolicy(), work: defaultWorkspacePolicy() });
  assert.deepEqual(state.defaults, { default: { allowedAgents: ["claude"] }, work: {} });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")).settings, state.settings);
});

test("data from before workspaces.json existed keeps the legacy pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-nofile-"));
  await mutateGroups((groups) => { groups.push({ id: "g", name: "G", createdAt: "2026-01-01T00:00:00.000Z", workspaceId: "personal" }); }, directory);
  const state = await loadWorkspaceState(directory);
  assert.deepEqual(state.workspaces.map((item) => item.id), ["personal", "company"]);
  assert.equal(state.currentWorkspaceId, "personal");
});

test("workspace selection, list and defaults persist; invalid entries are dropped on load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-workspaces-save-"));
  const initial = await loadWorkspaceState(directory);
  initial.workspaces.push({ id: "side-project", name: "사이드" });
  initial.currentWorkspaceId = "side-project";
  initial.defaults["side-project"] = { cwd: "/side", mode: "manual", agent: "claude", workers: ["codex"], autoSwitch: false };
  initial.settings!["side-project"] = { ...defaultWorkspacePolicy(), mediaGeneration: false, blockedTools: ["grok:media"] };
  await saveWorkspaceState(initial, directory);
  assert.deepEqual(await loadWorkspaceState(directory), initial);

  await writeFile(join(directory, "workspaces.json"), JSON.stringify({
    currentWorkspaceId: "gone",
    workspaces: [{ id: "a", name: "  A  " }, { id: "a", name: "dup" }, { id: "Bad Id", name: "x" }, { id: "b" }],
    defaults: { a: { cwd: "/a" }, stale: { cwd: "/stale" } },
    settings: { a: { mediaGeneration: "no", blockedTools: ["ok", "bad name"] }, stale: {} },
  }));
  assert.deepEqual(await loadWorkspaceState(directory), {
    currentWorkspaceId: "a",
    workspaces: [{ id: "a", name: "A" }, { id: "b", name: "b" }],
    defaults: { a: { cwd: "/a" }, b: {} },
    settings: { a: { ...defaultWorkspacePolicy(), blockedTools: ["ok"] }, b: defaultWorkspacePolicy() },
  });
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
