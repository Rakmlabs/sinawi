import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceSaver, searchWorkspace, inWorkspace, normalizeWorkspaces, runningByWorkspace, workspaceName, workspaceShortcut } from "./workspaces";
import { setLang, getLang } from "./i18n";

const list = [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }];

test("workspace lists exclude the other workspace; legacy records belong to the first workspace", () => {
  const records = [{ id: "old" }, { id: "mine", workspaceId: "personal" as const }, { id: "work", workspaceId: "company" as const }];
  assert.deepEqual(inWorkspace(records, "personal", "personal").map((item) => item.id), ["old", "mine"]);
  assert.deepEqual(inWorkspace(records, "company", "personal").map((item) => item.id), ["work"]);
  assert.deepEqual(inWorkspace(records, "company").map((item) => item.id), ["work"]);
});

test("user-defined workspaces: normalized list, running counts and the localized default name", () => {
  const state = normalizeWorkspaces({ currentWorkspaceId: "gone", defaults: { a: { cwd: "/a" } }, workspaces: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], runningByWorkspace: { b: 2 } });
  assert.equal(state.currentWorkspaceId, "a");
  assert.deepEqual(state.defaults.b, {});
  assert.deepEqual(state.runningByWorkspace, { b: 2 });
  assert.deepEqual(normalizeWorkspaces({ currentWorkspaceId: "x", defaults: { x: {} } }).workspaces, [{ id: "x", name: "x" }]);
  assert.deepEqual(runningByWorkspace([{ workspaceId: "a", status: "running" }, { workspaceId: "a", status: "done" }, { workspaceId: "b", status: "running" }]), { a: 1, b: 1 });
  const before = getLang();
  try {
    setLang("en");
    assert.equal(workspaceName([{ id: "default", name: "기본" }], "default"), "Default");
    assert.equal(workspaceName([{ id: "default", name: "Lab" }], "default"), "Lab");
    assert.equal(workspaceName(list, "company"), "회사");
  } finally { setLang(before); }
});

test("F1/F2 pick the first and second workspace while IME composition and modified shortcuts are left alone", () => {
  assert.equal(workspaceShortcut({ key: "F1" }), 0);
  assert.equal(workspaceShortcut({ key: "F2" }), 1);
  for (const event of [{ key: "F2", isComposing: true }, { key: "F1", keyCode: 229 }, { key: "F2", metaKey: true }, { key: "F2", ctrlKey: true }, { key: "F1", altKey: true }, { key: "F3" }]) {
    assert.equal(workspaceShortcut(event), undefined);
  }
});

test("preference saves serialize snapshots of one workspace's defaults and a later save recovers a failed switch", async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const save = createWorkspaceSaver(async (body) => {
    calls.push(body);
    if (calls.length === 1) { await gate; throw new Error("offline"); }
  });
  const state = { currentWorkspaceId: "personal", workspaces: list, defaults: { personal: { cwd: "/home" }, company: { cwd: "/work" } } };
  const first = save(state);
  state.defaults.personal.cwd = "/changed";
  const second = save({ ...state, currentWorkspaceId: "company" });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { currentWorkspaceId: "personal", workspaceId: "personal", defaults: { cwd: "/home" } });
  const failed = assert.rejects(first, /offline/);
  release();
  await failed;
  await second;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { currentWorkspaceId: "company", workspaceId: "company", defaults: { cwd: "/work" } });
  await save(state, false, "company");
  assert.deepEqual(calls[2], { currentWorkspaceId: "personal", workspaceId: "company", defaults: { cwd: "/work" } });
});

test("closing flush sends latest defaults immediately and skips stale queued saves", async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const save = createWorkspaceSaver(async (body) => { calls.push(body); if (calls.length === 1) await gate; });
  const initial = { currentWorkspaceId: "personal", workspaces: list, defaults: { personal: { cwd: "/first" }, company: {} } as Record<string, { cwd?: string }> };
  const first = save(initial);
  await Promise.resolve();
  const stale = save({ ...initial, defaults: { ...initial.defaults, personal: { cwd: "/stale" } } });
  const closing = save({ ...initial, defaults: { personal: { cwd: "/latest" }, company: {} } }, true);
  try { assert.equal(calls.length, 2); } finally { release(); }
  await Promise.all([first, stale, closing]);
  assert.deepEqual(calls.map((call) => call.defaults.cwd), ["/first", "/latest"]);
});

test("chat and project search scopes content before matching and retains project membership", () => {
  const base = { agent: "codex" as const, workers: ["claude" as const], cwd: "/repo", status: "done" as const, createdAt: "2026-01-01", events: [], workspaceId: "personal" as const };
  const sessions = [
    { ...base, id: "personal", title: "검토", groupId: "home" },
    { ...base, id: "content", title: "다른 채팅", events: [{ id: "e", sessionId: "content", agent: "user" as const, type: "message" as const, time: "2026-01-01", text: "검색할 내용" }] },
    { ...base, id: "company", title: "검토", workspaceId: "company" as const, groupId: "work" },
  ];
  const groups = [{ id: "home", name: "내 프로젝트", createdAt: "2026-01-01", workspaceId: "personal" as const }, { id: "work", name: "회사 프로젝트", createdAt: "2026-01-01", workspaceId: "company" as const }];
  const titles = searchWorkspace(sessions, groups, "personal", "검토");
  assert.deepEqual(titles.sessions.map((session) => session.id), ["personal"]);
  assert.deepEqual(titles.groups.map((group) => group.id), ["home"]);
  assert.deepEqual(searchWorkspace(sessions, groups, "personal", "내 프로젝트").sessions.map((session) => session.id), ["personal"]);
  assert.deepEqual(searchWorkspace(sessions, groups, "personal", "검색할 내용").sessions.map((session) => session.id), ["content"]);
  assert.deepEqual(searchWorkspace(sessions, groups, "personal", "회사 프로젝트"), { sessions: [], groups: [] });
  assert.deepEqual(searchWorkspace(sessions, groups, "company", "  ").sessions.map((session) => session.id), ["company"]);
});

test("new teams replace saved prohibited agents without retaining their model or worker configuration", async () => {
  const { workspaceTeamDefaults } = await import("./workspaces");
  const team = workspaceTeamDefaults("company", { agent: "codex", model: "codex-only", reasoningEffort: "xhigh", workers: ["codex"], workerConfigs: [{ agent: "codex", model: "gpt" }] });
  assert.equal(team.agent, "claude");
  assert.equal(team.model, undefined);
  assert.equal(team.reasoningEffort, undefined);
  assert.deepEqual(team.workers, ["grok"]);
  assert.deepEqual(team.workerConfigs, []);
  assert.deepEqual(workspaceTeamDefaults("personal", { agent: "grok", model: "grok-model", allowedAgents: ["grok", "claude"] }).workers, ["claude"]);
});

test("new chats default to Claude and fall back through allowed orchestrators", async () => {
  const { workspaceTeamDefaults } = await import("./workspaces");
  assert.deepEqual(
    workspaceTeamDefaults("personal", {}),
    { agent: "claude", model: undefined, reasoningEffort: undefined, workers: ["codex"], workerConfigs: [] },
  );
  assert.equal(workspaceTeamDefaults("personal", { allowedAgents: ["claude", "codex"] }).agent, "claude");
  assert.equal(workspaceTeamDefaults("personal", { allowedAgents: ["codex"] }).agent, "codex");
});

test("automatic chat defaults skip only agents with known exhausted quota", async () => {
  const { automaticTeamDefaults } = await import("./workspaces");
  const now = Date.parse("2026-10-30T12:00:00Z");
  const quota = (agent: "grok" | "claude" | "codex", remainingPercent: number, updatedAt = "2026-10-30T11:00:00Z") => ({
    agent, updatedAt, windows: [{ key: "current", label: "현재", remainingPercent }],
  });
  assert.equal(automaticTeamDefaults("personal", ["grok", "claude", "codex"], [quota("grok", 0), quota("claude", 50)], true, 3, now).agent, "claude");
  assert.equal(automaticTeamDefaults("personal", ["grok", "claude", "codex"], [quota("grok", 0), quota("claude", 2)], true, 3, now).agent, "codex");
  assert.equal(automaticTeamDefaults("personal", ["grok", "claude"], [quota("grok", 0)], false, 3, now).agent, "claude");
  assert.equal(automaticTeamDefaults("personal", ["claude", "codex"], [quota("claude", 0)], false, 3, now).agent, "claude");
  assert.equal(automaticTeamDefaults("personal", ["claude", "codex"], [quota("claude", 0, "2026-10-28T00:00:00Z")], true, 3, now).agent, "claude");
});

test("automatic chat defaults exclude known unauthenticated providers", async () => {
  const { automaticTeamDefaults } = await import("./workspaces");
  const agents = ["grok", "claude", "codex"] as const;
  assert.equal(automaticTeamDefaults("personal", [...agents], [], true, 3, Date.now(), {
    grok: "unauthenticated", claude: "authenticated", codex: "unknown",
  }).agent, "claude");
  assert.equal(automaticTeamDefaults("personal", [...agents], [], true, 3, Date.now(), {
    claude: "unauthenticated", codex: "unauthenticated", grok: "unknown",
  }).agent, "grok");
});

test("an empty policy keeps disabled team controls renderable without inventing a permitted worker", async () => {
  const { workspaceTeamDefaults } = await import("./workspaces");
  const team = workspaceTeamDefaults("company", { allowedAgents: [] });
  assert.equal(team.agent, "claude");
  assert.deepEqual(team.workers, []);
});

test("workspace defaults preserve same-agent workers with independent configurations", async () => {
  const { workspaceTeamDefaults } = await import("./workspaces");
  const team = workspaceTeamDefaults("personal", { agent: "codex", workers: ["codex", "codex"], workerConfigs: [{ id: "one", agent: "codex", model: "a" }, { id: "two", agent: "codex", model: "b" }], allowedAgents: ["codex"] });
  assert.deepEqual(team.workers, ["codex", "codex"]);
  assert.deepEqual(team.workerConfigs.map((config) => [config.id, config.model]), [["one", "a"], ["two", "b"]]);
  assert.deepEqual(workspaceTeamDefaults("personal", { agent: "codex", allowedAgents: ["codex"] }).workers, ["codex"]);
});
