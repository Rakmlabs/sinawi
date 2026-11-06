import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESIGN_BRIEF, Orchestra } from "./orchestra.js";

test("design briefs only require local skills selected in the worker brief", () => {
  assert.match(DESIGN_BRIEF, /브리프.*선택.*로컬 디자인 스킬/);
  assert.match(DESIGN_BRIEF, /선택한 스킬이 없으면.*프로젝트.*패턴/);
});
import type { RunCliOptions } from "./cli.js";

for (const exitCode of [0, 1]) test(`Claude design failures reach the user and lead even with exit code ${exitCode}`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-invocation-"));
  const leadPrompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      options.onLine({ type: "tool", text: 'Skill: {"skill":"design"}' });
      options.onLine({ type: "tool", text: "Claude Design access denied: run /design consent first" });
      return { exitCode, finalText: "Cannot complete design" };
    }
    leadPrompts.push(options.prompt);
    return { exitCode: 0, finalText: leadPrompts.length === 1 ? '<<DELEGATE to="claude">>Use /design to create an artboard<</DELEGATE>>' : "Reported blocker" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "Create design", agent: "grok", workers: ["claude"], cwd });
  for (let attempt = 0; session.status === "running" && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
  assert.ok(session.events.some((event) => event.type === "warning" && event.role === "worker" && /선택 사항/.test(event.text)));
  assert.match(leadPrompts[1], /access denied.*\/design consent/);
});

test("missing skill invocation evidence is included in worker results for the lead", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-invocation-"));
  const leadPrompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "Done" };
    leadPrompts.push(options.prompt);
    return { exitCode: 0, finalText: leadPrompts.length === 1 ? '<<DELEGATE to="claude">>스킬: frontend-design\nBuild the page<</DELEGATE>>' : "Reported gap" };
  };
  const session = await new Orchestra(undefined, runner).create({ prompt: "Build page", agent: "grok", workers: ["claude"], cwd });
  for (let attempt = 0; session.status === "running" && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
  assert.ok(session.events.some((event) => event.type === "warning" && /Skill.*확인할 수 없/.test(event.text)));
  assert.match(leadPrompts[1], /Skill.*확인할 수 없/);
});

for (const exitCode of [0, 1]) test(`tool delegation infers design skills and preserves failure status (${exitCode})`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-invocation-"));
  const skillDir = join(cwd, ".claude", "skills", "fixture-design");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: fixture-design\ndescription: Visual fixture\n---\nUse Skill for this design task.\n");
  let chatId = "";
  let workerPrompt = "";
  let collected: any;
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerPrompt = options.prompt;
      return { exitCode, finalText: exitCode ? "Claude Design access denied: run /design consent first" : "Done" };
    }
    if (options.readOnly) return { exitCode: 0, finalText: "Review" };
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "Create the visual", skills: ["fixture-design"] });
    collected = await orchestra.leadToolCall(chatId, "collect_results", {});
    return { exitCode: 0, finalText: "Reported result" };
  });
  orchestra.stewardDataDir = join(cwd, "data");
  const session = await orchestra.create({ prompt: "Build page", agent: "codex", workers: ["claude"], cwd, steward: { name: "Design" } });
  chatId = session.id;
  for (let attempt = 0; session.status === "running" && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
  assert.match(workerPrompt, /스크린샷 절대 경로/);
  assert.equal(collected.results[0].status, exitCode ? "error" : "done");
  assert.doesNotMatch(collected.results[0].result, /Skill.*확인할 수 없/);
  if (exitCode) assert.match(collected.results[0].result, /access denied.*\/design consent/);
});

for (const toolBased of [false, true]) test(`blocked /design does not fail a finished local mockup (${toolBased ? "tool" : "tag"})`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-local-design-"));
  let chatId = "";
  const blockedSkillDir = join(cwd, ".claude", "skills", "design");
  await mkdir(blockedSkillDir, { recursive: true });
  await writeFile(join(blockedSkillDir, "SKILL.md"), "---\nname: design\ndescription: Claude Design\n---\nRUN_HEADLESS_DESIGN_FIRST\n");
  let workerCalls = 0;
  let leadCalls = 0;
  let collected: any;
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerCalls++;
      assert.ok(options.prompt.includes(DESIGN_BRIEF));
      assert.match(options.prompt, /disable-model-invocation/);
      assert.match(options.prompt, /사용자가 선택한 로컬 디자인 스킬/);
      assert.doesNotMatch(options.prompt, /RUN_HEADLESS_DESIGN_FIRST/);
      options.onLine({ type: "tool", text: "Skill design cannot be used with Skill tool due to disable-model-invocation" });
      options.onLine({ type: "tool", text: "Write: /tmp/mockup.html" });
      return { exitCode: 0, finalText: "Created /tmp/mockup.html with local design skills" };
    }
    if (options.readOnly) return { exitCode: 0, finalText: "Review" };
    leadCalls++;
    if (toolBased) {
      await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "Use /design to create a mockup", kind: "design", skills: ["design"] });
      collected = await orchestra.leadToolCall(chatId, "collect_results", {});
    } else if (leadCalls === 1) {
      return { exitCode: 0, finalText: '<<DELEGATE to="claude" kind="design">>Use /design to create a mockup<</DELEGATE>>' };
    } else {
      assert.match(options.prompt, /mockup.html/);
      assert.doesNotMatch(options.prompt, /결과 — 실패/);
    }
    return { exitCode: 0, finalText: "Finished local mockup" };
  });
  orchestra.stewardDataDir = join(cwd, "data");
  const session = await orchestra.create({ prompt: "Create a mockup", agent: "codex", workers: ["claude"], cwd, ...(toolBased ? { steward: { name: "Design" } } : {}) });
  chatId = session.id;
  for (let attempt = 0; session.status === "running" && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
  assert.equal(workerCalls, 1);
  assert.ok(session.events.some((event) => event.role === "worker" && event.taskStatus === "done"));
  assert.ok(!session.events.some((event) => event.role === "worker" && event.taskStatus === "error"));
  if (toolBased) assert.equal(collected.results[0].status, "done");
});

for (const toolBased of [false, true]) test(`cross-CLI attached skills do not require a native trace (${toolBased ? "tool" : "tag"})`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sinawi-attached-skill-"));
  const directory = join(cwd, ".claude", "skills", "fixture-review");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: fixture-review\ndescription: Review fixture\n---\nATTACHED_REVIEW_INSTRUCTIONS");
  let workerPrompt = "";
  let chatId = "";
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerPrompt = options.prompt;
      return { exitCode: 0, finalText: "상태: 완료\n검토 완료" };
    }
    if (toolBased && !options.readOnly) {
      await orchestra.leadToolCall(chatId, "delegate_task", { worker: "codex", brief: "Review files", skills: ["fixture-review"] });
      await orchestra.leadToolCall(chatId, "collect_results", {});
      return { exitCode: 0, finalText: "검토 완료" };
    }
    return { exitCode: 0, finalText: options.readOnly ? "검증 완료" : '<<DELEGATE to="codex">>스킬: fixture-review\nReview files<</DELEGATE>>' };
  });
  orchestra.stewardDataDir = join(cwd, "data");
  const session = await orchestra.create({ prompt: "fixture-review로 검토", agent: "claude", workers: ["codex"], cwd, ...(toolBased ? { steward: { name: "Test" } } : {}) });
  chatId = session.id;
  for (let attempt = 0; session.status === "running" && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
  assert.match(workerPrompt, /ATTACHED_REVIEW_INSTRUCTIONS/);
  assert.ok(!session.events.some((event) => event.type === "warning" && /SKILL\.md 읽기/.test(event.text)));
});
