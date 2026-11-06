import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearSkillsCache, filterEnabledSkills, formatSkillInstructions, formatSkillPrompt, loadSkills, scanClaudePlugins, scanProjectSkills, scanSkillRoot } from "./skills.js";

test("disabled skill names are excluded from discovery and prompt injection", () => {
  const records = [{ id: "one", name: "Review", source: "Test", description: "", agents: ["codex" as const], content: "SECRET" }];
  assert.deepEqual(filterEnabledSkills(records, ["review"]), []);
  assert.equal(formatSkillPrompt(records, ["one"], ["Review"]), "");
});

test("skill discovery uses inherited CLI account roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-inherited-skills-"));
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-inherited-project-"));
  const previous = process.env.CODEX_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    clearSkillsCache();
    await Promise.all([root, cwd].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const skill = join(root, "skills", "inherited-codex");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: inherited-codex\ndescription: Inherited account skill\n---\n");
  process.env.CODEX_HOME = root;

  const skills = await loadSkills(cwd, true);

  assert.ok(skills.some((item) => item.name === "inherited-codex" && item.agents.includes("codex")));
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

test("project discovery scans all supported roots without merging distinct files", async () => {
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
  assert.deepEqual(skills.map(({ name }) => name).sort(), ["agents", "claude", "shared", "shared"]);
  const shared = skills.filter(({ name }) => name === "shared");
  assert.equal(new Set(shared.map(({ id }) => id)).size, shared.length);
});

test("project discovery deduplicates the same skill file by realpath and merges agent badges", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-project-symlinked-skills-"));
  const target = await mkdtemp(join(tmpdir(), "orchestra-shared-skill-"));
  const accounts = Object.fromEntries(await Promise.all(["claude", "codex", "grok"].map(async (agent) => {
    const root = await mkdtemp(join(tmpdir(), `orchestra-${agent}-account-`));
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(target, join(root, "skills", "shared-realpath"));
    return [agent, root];
  }))) as { claude: string; codex: string; grok: string };
  await writeFile(join(target, "SKILL.md"), "---\nname: shared-realpath\ndescription: One physical skill\n---\n");

  const skills = (await loadSkills(cwd, true, accounts)).filter(({ name }) => name === "shared-realpath");

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "shared-realpath");
  assert.deepEqual(skills[0].agents.sort(), ["claude", "codex", "grok"]);
});

test("skill metadata parses literal, folded, and plain YAML descriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-skill-metadata-"));
  const fixtures = {
    literal: "description: |\n  Good reason\n  with detail",
    folded: "description: >\n  Folded reason\n  with detail",
    plain: "description: Plain reason",
  };
  for (const [name, description] of Object.entries(fixtures)) {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\n${description}\n---\n`);
  }

  const skills = await scanSkillRoot(root, "Test");

  assert.equal(skills.find(({ name }) => name === "literal")?.description, "Good reason\nwith detail");
  assert.equal(skills.find(({ name }) => name === "folded")?.description, "Folded reason with detail");
  assert.equal(skills.find(({ name }) => name === "plain")?.description, "Plain reason");
});

test("skill prompt injection stays within a bounded argv budget", () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    id: `skill-${index}`, name: `Skill ${index}`, source: "Test", description: "fixture", agents: ["codex" as const], content: "x".repeat(32_000),
  }));
  const prompt = formatSkillPrompt(records, records.map((record) => record.id));
  assert.ok(prompt.length <= 60_100, `prompt was ${prompt.length} characters`);
  assert.match(prompt, /Skill 0/);
});

test("explicit attachment metadata excludes skills omitted by the prompt budget", () => {
  const records = [
    { id: "a", name: "large", description: "", agents: ["claude" as const], source: "Claude", content: "x".repeat(60_000) },
    { id: "b", name: "omitted", description: "", agents: ["claude" as const], source: "Claude", content: "OMITTED_BODY" },
  ];
  const result = formatSkillInstructions(records, ["a", "b"]);
  assert.deepEqual(result.attachedSkills, ["large"]);
  assert.doesNotMatch(result.text, /OMITTED_BODY/);
});
