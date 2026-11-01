import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceSaver, searchWorkspace, inWorkspace, workspaceShortcut } from "./workspaces";

test("workspace lists exclude the other workspace, including search candidates", () => {
  const records = [{ id: "old" }, { id: "mine", workspaceId: "personal" as const }, { id: "work", workspaceId: "company" as const }];
  assert.deepEqual(inWorkspace(records, "personal").map((item) => item.id), ["old", "mine"]);
  assert.deepEqual(inWorkspace(records, "company").map((item) => item.id), ["work"]);
});

test("F1/F2 switch workspaces while IME composition and modified shortcuts are left alone", () => {
  assert.equal(workspaceShortcut({ key: "F1" }), "personal");
  assert.equal(workspaceShortcut({ key: "F2" }), "company");
  for (const event of [{ key: "F2", isComposing: true }, { key: "F1", keyCode: 229 }, { key: "F2", metaKey: true }, { key: "F2", ctrlKey: true }, { key: "F1", altKey: true }, { key: "F3" }]) {
    assert.equal(workspaceShortcut(event), undefined);
  }
});

test("preference saves serialize snapshots and a later full save recovers a failed switch", async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const save = createWorkspaceSaver(async (body) => {
    calls.push(body);
    if (calls.length === 1) { await gate; throw new Error("offline"); }
  });
  const state = { currentWorkspaceId: "personal" as const, defaults: { personal: { cwd: "/home" }, company: { cwd: "/work" } } };
  const first = save(state);
  state.defaults.personal.cwd = "/changed";
  const second = save({ ...state, currentWorkspaceId: "company" });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].defaultsByWorkspace.personal.cwd, "/home");
  const failed = assert.rejects(first, /offline/);
  release();
  await failed;
  await second;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].currentWorkspaceId, "company");
  assert.deepEqual(calls[1].defaultsByWorkspace, { personal: { cwd: "/changed" }, company: { cwd: "/work" } });
});

test("closing flush sends latest defaults immediately and skips stale queued saves", async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const save = createWorkspaceSaver(async (body) => { calls.push(body); if (calls.length === 1) await gate; });
  const initial = { currentWorkspaceId: "personal" as const, defaults: { personal: { cwd: "/first" }, company: {} } };
  const first = save(initial);
  await Promise.resolve();
  const stale = save({ ...initial, defaults: { ...initial.defaults, personal: { cwd: "/stale" } } });
  const closing = save({ ...initial, currentWorkspaceId: "company", defaults: { personal: { cwd: "/latest" }, company: {} } }, true);
  try { assert.equal(calls.length, 2); } finally { release(); }
  await Promise.all([first, stale, closing]);
  assert.deepEqual(calls.map((call) => call.defaultsByWorkspace.personal.cwd), ["/first", "/latest"]);
  assert.equal(calls[1].currentWorkspaceId, "company");
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
