import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import { publicSkills } from "./skills.js";
import { mutateToolSettings, workspaceToolSettings } from "./store.js";
import type { RunCliOptions } from "./cli.js";
import type { Session } from "./types.js";

async function settled(session: Session) {
  const deadline = Date.now() + 3000;
  while (session.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done", session.events.at(-1)?.text);
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "disabled-skill-"));
  const path = join(cwd, ".agents", "skills", "private-fixture");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: private-fixture\ndescription: Test fixture\n---\nSECRET_SKILL_INSTRUCTIONS");
  const skill = (await publicSkills(cwd)).find((item) => item.name === "private-fixture")!;
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    if (options.usageContext?.role === "orchestrator" && !options.prompt.includes("위임한 워커들의 결과")) {
      return { exitCode: 0, finalText: '<<DELEGATE to="grok">>Check implementation<</DELEGATE>>' };
    }
    return { exitCode: 0, finalText: "complete" };
  };
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, cwd);
  return { cwd, skill, prompts, orchestra };
}

test("disabled skills are excluded from explicit create, planner and worker injection", async () => {
  const { cwd, skill, prompts, orchestra } = await fixture();
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledSkills = [skill.name]; }, cwd);
  const session = await orchestra.create({ prompt: "Check code", agent: "codex", workers: ["grok"], planner: { agent: "codex" }, cwd, skills: [skill.id] });
  await settled(session);
  assert.ok(prompts.length >= 3);
  assert.ok(prompts.every((prompt) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
});

test("disabling a saved skill affects followups and remains scoped to its workspace", async () => {
  const { cwd, skill, prompts, orchestra } = await fixture();
  const session = await orchestra.create({ prompt: "Check code", agent: "codex", workers: ["grok"], cwd, skills: [skill.id] });
  await settled(session);
  assert.ok(prompts.some((prompt) => prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledSkills = [skill.name]; }, cwd);
  prompts.length = 0;
  await orchestra.followup(session.id, "Check again", [skill.id]);
  await settled(session);
  assert.ok(prompts.every((prompt) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
  prompts.length = 0;
  const company = await orchestra.create({ prompt: "Check code", agent: "grok", workers: ["claude"], workspaceId: "company", cwd, skills: [skill.id] });
  await settled(company);
  assert.ok(prompts.some((prompt) => prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
});

test("disabled bot skills never enter conversation prompts", async () => {
  const { cwd, skill, prompts, orchestra } = await fixture();
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledSkills = [skill.name]; }, cwd);
  const bot = { name: "Fixture", agent: "codex" as const, skills: [skill.id], systemPrompt: "", createdAt: new Date().toISOString() };
  const session = await orchestra.conversation({ botA: "a", botB: "b", prompt: "Discuss code", turns: 2, cwd }, [{ ...bot, id: "a" }, { ...bot, id: "b" }]);
  await settled(session);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
});

test("disabled legacy media attachments do not block company creates, restored followups or bots", async () => {
  const { cwd, orchestra } = await fixture();
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "company").disabledSkills = ["marketing-shorts"]; }, cwd);
  const session = await orchestra.create({ prompt: "Review code", agent: "claude", workers: ["grok"], cwd, workspaceId: "company", skills: ["marketing-shorts"] });
  await settled(session);
  assert.equal(session.agent, "claude");
  orchestra.restore([{ ...session, skills: ["marketing-shorts"] }]);
  const resumed = await orchestra.followup(session.id, "Review again");
  await settled(resumed);
  assert.equal(resumed.agent, "claude");
  const bot = { name: "Legacy", agent: "claude" as const, skills: ["marketing-shorts"], systemPrompt: "", createdAt: new Date().toISOString() };
  const conversation = await orchestra.conversation({ botA: "a", botB: "b", prompt: "Discuss code", turns: 2, cwd, workspaceId: "company" }, [{ ...bot, id: "a" }, { ...bot, id: "b" }]);
  await settled(conversation);
});

test("MCP skill listing and delegation respect workspace disabled skills", async () => {
  const { cwd, skill } = await fixture();
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledSkills = [skill.name]; }, cwd);
  let chatId = "";
  let listed: any;
  let delegated: any;
  const workerPrompts: string[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerPrompts.push(options.prompt);
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    if (options.readOnly) return { exitCode: 0, finalText: "검증 완료" };
    listed = await orchestra.leadToolCall(chatId, "list_skills", {});
    delegated = await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "Check code", skills: [skill.name] });
    await orchestra.leadToolCall(chatId, "collect_results", {});
    return { exitCode: 0, finalText: "완료" };
  }, undefined, undefined, undefined, undefined, cwd);
  orchestra.stewardDataDir = join(cwd, "steward-data");
  const session = await orchestra.create({ prompt: "Check code", agent: "codex", workers: ["claude"], cwd, steward: { name: "Test" } });
  chatId = session.id;
  await settled(session);
  assert.ok(workerPrompts.length);
  assert.ok(workerPrompts.every((prompt) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
  assert.ok(![...listed.lead, ...listed.others].some((item) => item.name === skill.name));
  assert.deepEqual(delegated.missing_skills, [skill.name]);
});

test("steward default preferences inform recommendations without injecting unchosen instructions", async () => {
  const { cwd, skill } = await fixture();
  const prompts: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    prompts.push(options);
    return { exitCode: 0, finalText: options.usageContext?.role === "worker" ? "상태: 완료" : '<<DELEGATE to="claude">>Check code without skills<</DELEGATE>>' };
  }, undefined, undefined, undefined, undefined, cwd);
  orchestra.stewardDataDir = join(cwd, "steward-data");
  const steward = orchestra.createSteward({ name: "Test", agent: "codex", skills: [skill.id], workers: [{ agent: "claude" }] });
  const session = await orchestra.create({ prompt: "스킬 없이 진행", agent: "codex", cwd, steward: { id: steward.id } });
  await settled(session);
  assert.ok(prompts.every(({ prompt }) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
  assert.match(prompts.find((options) => options.usageContext?.role === "orchestrator")!.prompt, /기본 선호 스킬.*private-fixture/);
  prompts.length = 0;
  // Restored threads may still contain the defaults injected by older versions.
  orchestra.restore([{ ...session, skills: [skill.id] }], [steward]);
  await orchestra.followup(session.id, "스킬 없이 계속");
  await settled(orchestra.get(session.id)!);
  assert.ok(prompts.every(({ prompt }) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
  prompts.length = 0;
  await orchestra.followup(session.id, "이 스킬을 사용", [skill.id]);
  await settled(orchestra.get(session.id)!);
  assert.ok(prompts.some(({ prompt }) => prompt.includes("SECRET_SKILL_INSTRUCTIONS")), "explicit per-message attachments still work");
});
