// A team that names an agent the workspace does not allow (a lead saved with Grok, an older chat, an
// outside caller's pick) runs with an allowed agent and model instead of asking the user to turn the
// agent back on (v1.7.2). Shaped like the report: lead agent "grok", workspace allows Claude only,
// default team Claude opus/high, and a worker saved as {agent: "claude", id: "grok"}.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import type { RunCliOptions } from "./cli.js";
import type { Steward, WorkspaceDefaults } from "./types.js";
import { loadSessions, loadStewards, loadWorkspaceState } from "./store.js";
import { normalizeWorkerConfigs, renameSessionWorkers } from "./workers.js";

const claudeOnly = () => ["claude"] as const;
const defaults: WorkspaceDefaults = { agent: "claude", model: "opus", reasoningEffort: "high", workers: ["claude"], allowedAgents: ["claude"] };

async function settle(session: { status: string }) {
  for (let i = 0; i < 1_500 && session.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

function setup() {
  const calls: Pick<RunCliOptions, "agent" | "model" | "reasoningEffort" | "usageContext">[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push({ agent: options.agent, model: options.model, reasoningEffort: options.reasoningEffort, usageContext: options.usageContext });
    return { exitCode: 0, finalText: "끝" };
  }, undefined, undefined, undefined, claudeOnly);
  orchestra.workspaceDefaults = () => defaults;
  return { orchestra, calls };
}

async function grokLead(orchestra: Orchestra): Promise<Steward> {
  const cwd = await mkdtemp(join(tmpdir(), "fallback-lead-"));
  const lead: Steward = {
    id: "fec7e6a7-lead", name: "Siot", agent: "grok", skills: [], systemPrompt: "", mergePolicy: "ask", cwds: [cwd],
    workers: [{ agent: "claude", id: "grok", label: "Claude" }], workspaceId: "personal", createdAt: new Date().toISOString(),
  };
  orchestra.restore([], [lead]);
  return lead;
}

test("a lead saved with Grok runs its new chat with the Claude model the user picked, not a refusal", async () => {
  const { orchestra, calls } = setup();
  const lead = await grokLead(orchestra);
  // What the app sends: the composer's team (Claude opus/high) and the lead's id.
  const session = await orchestra.create({ prompt: "웹 UI 분석해줘", agent: "claude", model: "opus", reasoningEffort: "high", workers: ["claude"], cwd: "", steward: { id: lead.id } });
  await settle(session);
  assert.equal(session.status, "done");
  assert.equal(session.agent, "claude");
  assert.equal(session.model, "opus");
  assert.equal(session.reasoningEffort, "high");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.agent === "claude"), JSON.stringify(calls));
  assert.deepEqual(calls[0], { agent: "claude", model: "opus", reasoningEffort: "high", usageContext: calls[0].usageContext });
  assert.ok(session.events.some((event) => event.type === "status" && /Grok Build 사용이 꺼져 있어 총괄은 Claude로\(opus · high\) 진행합니다/u.test(event.text)), session.events.map((e) => e.text).join("\n"));
  assert.ok(!session.events.some((event) => /설정 › 작업 공간에서 허용/u.test(event.text)));
  // The worker saved as id "grok" runs Claude and is no longer called "grok".
  assert.deepEqual(session.workerConfigs?.map(({ id, agent }) => ({ id, agent })), [{ id: "claude", agent: "claude" }]);
});

test("an outside caller (lead_id only, or lead_id with Grok) gets the workspace's default agent and model", async () => {
  const { orchestra, calls } = setup();
  const lead = await grokLead(orchestra);
  const bare = await orchestra.create({ prompt: "", agent: undefined as never, workers: [], cwd: "", steward: { id: lead.id } });
  assert.equal(bare.agent, "claude");
  assert.equal(bare.model, "opus");
  assert.equal(bare.reasoningEffort, "high");
  assert.ok(bare.events.some((event) => /Grok Build 사용이 꺼져 있어/u.test(event.text)));
  const asked = await orchestra.create({ prompt: "해줘", agent: "grok", workers: [], cwd: "", steward: { id: lead.id, agent: "grok" } });
  await settle(asked);
  assert.equal(asked.status, "done");
  assert.equal(asked.agent, "claude");
  assert.ok(calls.every((call) => call.agent === "claude"));
});

test("an existing chat of the lead carries on after the workspace turned Grok off", async () => {
  const calls: string[] = [];
  let allowed: ("claude" | "grok")[] = ["claude", "grok"];
  const orchestra = new Orchestra(undefined, async (options) => { calls.push(options.agent); return { exitCode: 0, finalText: "끝" }; }, undefined, undefined, undefined, () => allowed);
  orchestra.workspaceDefaults = () => defaults;
  const lead = await grokLead(orchestra);
  const session = await orchestra.create({ prompt: "첫 요청", agent: "claude", workers: ["claude"], cwd: "", steward: { id: lead.id } });
  await settle(session);
  assert.equal(session.agent, "grok");
  allowed = ["claude"];
  await orchestra.followup(session.id, "두 번째 요청");
  await settle(session);
  assert.equal(session.status, "done");
  assert.equal(session.agent, "claude");
  assert.equal(session.model, "opus");
  assert.deepEqual(calls, ["grok", "claude"]);
  // Changing the lead's team to Grok again does not break its chats either.
  orchestra.patchSteward(lead.id, { agent: "grok" });
  assert.equal(session.agent, "claude");
});

test("worker ids that name another CLI are renamed with every reference in the chat", () => {
  assert.deepEqual(normalizeWorkerConfigs(["claude"], [{ agent: "claude", id: "grok", label: "Claude" }]), [{ agent: "claude", id: "claude", label: "Claude" }]);
  // Ids that are not CLI names keep the worker's identity, as before.
  assert.equal(normalizeWorkerConfigs(["codex"], [{ agent: "codex", id: "one" }])[0].id, "one");
  const session = {
    workerConfigs: [{ agent: "claude" as const, id: "grok", label: "Claude" }, { agent: "grok" as const, id: "claude", label: "Grok Build" }],
    workerSessionIds: { grok: "claude-conversation", claude: "grok-conversation" },
    worktrees: [{ workerId: "grok" }],
    events: [{ workerId: "grok" }, { workerId: "claude" }, { metadata: { targetWorkerId: "grok" } }],
  };
  assert.equal(renameSessionWorkers(session), true);
  const ids = session.workerConfigs.map((config) => `${config.agent}:${config.id}`);
  assert.deepEqual(ids, ["claude:claude", "grok:grok"]);
  assert.deepEqual(session.workerSessionIds, { claude: "claude-conversation", grok: "grok-conversation" });
  assert.deepEqual(session.worktrees, [{ workerId: "claude" }]);
  assert.deepEqual(session.events, [{ workerId: "claude" }, { workerId: "grok" }, { metadata: { targetWorkerId: "claude" } }]);
  assert.equal(renameSessionWorkers(session), false, "a second pass changes nothing");
});

test("saved leads, workspace defaults and chats are migrated once on load, keeping their data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fallback-migrate-"));
  await writeFile(join(directory, "stewards.json"), JSON.stringify([{ id: "l1", name: "Golfzone", agent: "claude", model: "opus", workers: [{ agent: "claude", id: "grok", label: "Claude", model: "opus", reasoningEffort: "high" }], skills: [], systemPrompt: "", mergePolicy: "ask", cwds: ["/x"], createdAt: "2026-11-23" }]));
  await writeFile(join(directory, "workspaces.json"), JSON.stringify({ currentWorkspaceId: "company", workspaces: [{ id: "company", name: "회사" }], settings: { company: {} },
    defaults: { company: { agent: "claude", model: "opus", reasoningEffort: "high", allowedAgents: ["claude"], workers: ["claude"], workerConfigs: [{ agent: "claude", id: "grok", label: "Claude", model: "opus" }] } } }));
  const backup = `${directory}-copy`;
  await cp(directory, backup, { recursive: true });
  const [lead] = await loadStewards(directory);
  assert.deepEqual(lead.workers, [{ agent: "claude", id: "claude", label: "Claude", model: "opus", reasoningEffort: "high" }]);
  assert.equal(JSON.parse(await readFile(join(directory, "stewards.json"), "utf8"))[0].workers[0].id, "claude", "written back");
  const state = await loadWorkspaceState(directory);
  assert.equal(state.defaults.company.workerConfigs?.[0].id, "claude");
  assert.equal(state.defaults.company.model, "opus");
  assert.deepEqual(state.defaults.company.allowedAgents, ["claude"]);
  assert.equal(JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")).defaults.company.workerConfigs[0].id, "claude");
  // The copy taken before is untouched (the real data is only ever checked on a copy).
  assert.equal(JSON.parse(await readFile(join(backup, "stewards.json"), "utf8"))[0].workers[0].id, "grok");
  assert.equal((await loadSessions(directory)).length, 0);
});
