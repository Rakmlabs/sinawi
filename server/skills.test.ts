import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterEnabledSkills, formatSkillPrompt, scanClaudePlugins, scanProjectSkills, scanSkillRoot } from "./skills.js";

test("disabled skill names are excluded from discovery and prompt injection", () => {
  const records = [{ id: "one", name: "Review", source: "Test", description: "", agents: ["codex" as const], content: "SECRET" }];
  assert.deepEqual(filterEnabledSkills(records, ["review"]), []);
  assert.equal(formatSkillPrompt(records, ["one"], ["Review"]), "");
});

test("skill discovery follows symlinked skill directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-skills-root-"));
  const target = await mkdtemp(join(tmpdir(), "orchestra-skill-target-"));
  await mkdir(join(target, "nested"));
  await writeFile(join(target, "nested", "SKILL.md"), "---\nname: linked-skill\ndescription: Linked skill fixture\n---\nUse this skill.\n");
  await symlink(join(target, "nested"), join(root, "linked"));
  const skills = await scanSkillRoot(root, "Test");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "linked-skill");
  assert.equal(skills[0].source, "Test");
});

test("skill discovery finds nested skills through depth three and ignores supporting markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-nested-skills-"));
  const skillDir = join(root, "synced", "catalog-id", "deep-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: deep-skill\ndescription: Nested fixture\n---\n");
  await writeFile(join(skillDir, "README.md"), "supporting documentation");

  const skills = await scanSkillRoot(root, "Claude", ["claude"]);
  assert.deepEqual(skills.map(({ name }) => name), ["deep-skill"]);
  assert.deepEqual(skills[0].agents, ["claude"]);
});

test("Claude plugin discovery loads skills and commands using the plugin name as source", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-plugin-"));
  const installPath = join(root, "plugin");
  await mkdir(join(installPath, "skills", "autopilot"), { recursive: true });
  await mkdir(join(installPath, "commands"), { recursive: true });
  await writeFile(join(installPath, "skills", "autopilot", "SKILL.md"), "---\nname: omc-autopilot\ndescription: Automatic execution\n---\n");
  await writeFile(join(installPath, "commands", "team.md"), "---\ndescription: Team command\n---\n");
  const registry = join(root, "installed_plugins.json");
  await writeFile(registry, JSON.stringify({ plugins: { "oh-my-claudecode@omc": [{ installPath }] } }));

  const skills = await scanClaudePlugins(registry);
  assert.deepEqual(skills.map(({ name }) => name).sort(), ["autopilot", "team"]);
  assert.ok(skills.every(({ source }) => source === "oh-my-claudecode"));
  assert.ok(skills.every(({ agents }) => agents.length === 1 && agents[0] === "claude"));
});

test("project discovery scans all supported roots and deduplicates by name and source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-project-skills-"));
  for (const directory of [".claude", ".agents", ".codex"]) {
    const skill = join(cwd, directory, "skills", directory.slice(1));
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), `---\nname: ${directory === ".codex" ? "shared" : directory.slice(1)}\ndescription: Project fixture\n---\n`);
  }
  const duplicate = join(cwd, ".claude", "skills", "shared");
  await mkdir(duplicate, { recursive: true });
  await writeFile(join(duplicate, "SKILL.md"), "---\nname: shared\ndescription: Duplicate fixture\n---\n");

  const skills = await scanProjectSkills(cwd);
  assert.deepEqual(skills.map(({ name }) => name).sort(), ["agents", "claude", "shared"]);
  assert.deepEqual(skills.find(({ name }) => name === "shared")?.agents.sort(), ["claude", "codex"]);
});

test("skill prompt injection stays within a bounded argv budget", () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    id: `skill-${index}`, name: `Skill ${index}`, source: "Test", description: "fixture", agents: ["codex" as const], content: "x".repeat(32_000),
  }));
  const prompt = formatSkillPrompt(records, records.map((record) => record.id));
  assert.ok(prompt.length <= 60_100, `prompt was ${prompt.length} characters`);
  assert.match(prompt, /Skill 0/);
});
