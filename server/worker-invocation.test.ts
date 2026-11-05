import assert from "node:assert/strict";
import test from "node:test";
import { workerInvocationWarnings } from "./worker-invocation.js";

test("briefed skills without invocation evidence report the verification gap", () => {
  const warnings = workerInvocationWarnings({ agent: "claude", brief: "스킬: frontend-design\nBuild a page", skills: "", tools: "Read: app.tsx", output: "Done" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skill|스킬/);
  assert.match(warnings[0], /확인할 수 없/);
});

test("actual skill tool calls and skill file reads satisfy best-effort detection", () => {
  for (const tools of ['Skill: {"skill":"frontend-design"}', '스킬 불러옴: frontend-design', '파일 읽기: /tmp/skills/frontend-design/SKILL.md']) {
    assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "스킬: frontend-design", skills: "", tools, output: "Done" }), []);
  }
});

test("mentioning Skill or design in a report does not prove invocation", () => {
  const warnings = workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "selected instructions", tools: "", output: "I should use Skill and /design" });
  assert.equal(warnings.length, 2);
});

test("design invocation is detected from Skill and slash command traces", () => {
  for (const tools of ['Skill: {"skill":"design","args":"create"}', 'SlashCommand: /design create', '/design create']) {
    assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "", tools, output: "Done" }), []);
  }
  assert.equal(workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "", tools: 'Skill: {"skill":"frontend-design"}', output: "Done" }).length, 1);
});

test("Claude design consent and access errors include a concrete recovery reason", () => {
  for (const output of ['Claude Design requires consent. Run /design consent first.', 'Claude Design access denied (403)', '/design is not available for this account', 'Claude Design: authentication required']) {
    const warnings = workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "", tools: 'Skill: {"skill":"design"}', output });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /consent|access denied|not available|authentication required/);
    assert.match(warnings[0], /터미널.*\/design consent/);
  }
});

test("ordinary unbriefed work and successful consent mentions do not warn", () => {
  assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "Fix tests", skills: "", tools: "Read: app.tsx", output: "Done" }), []);
  assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "", tools: 'Skill: {"skill":"design"}', output: "Consent already granted; design completed" }), []);
});


test("design consent messages split across output lines still identify the blocker", () => {
  const warnings = workerInvocationWarnings({ agent: "claude", brief: "Use /design", skills: "", tools: 'Skill: {"skill":"design"}', output: "Claude Design\nYou do not have access to this feature" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /막혔습니다/);
});
