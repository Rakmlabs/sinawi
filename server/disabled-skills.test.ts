import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import { publicSkills } from "./skills.js";
import { mutateToolSettings } from "./store.js";
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
  await mutateToolSettings((settings) => { settings.personal.disabledSkills = [skill.name]; }, cwd);
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
  await mutateToolSettings((settings) => { settings.personal.disabledSkills = [skill.name]; }, cwd);
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
  await mutateToolSettings((settings) => { settings.personal.disabledSkills = [skill.name]; }, cwd);
  const bot = { name: "Fixture", agent: "codex" as const, skills: [skill.id], systemPrompt: "", createdAt: new Date().toISOString() };
  const session = await orchestra.conversation({ botA: "a", botB: "b", prompt: "Discuss code", turns: 2, cwd }, [{ ...bot, id: "a" }, { ...bot, id: "b" }]);
  await settled(session);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => !prompt.includes("SECRET_SKILL_INSTRUCTIONS")));
});

test("disabled legacy media attachments do not block company creates, restored followups or bots", async () => {
  const { cwd, orchestra } = await fixture();
  await mutateToolSettings((settings) => { settings.company.disabledSkills = ["marketing-shorts"]; }, cwd);
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
