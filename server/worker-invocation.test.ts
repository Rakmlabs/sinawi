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

test("missing /design is optional and local design skills satisfy verification", () => {
  for (const tools of ["", 'Skill: {"skill":"frontend-design"}', "Read: /tmp/impeccable/SKILL.md"]) {
    assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "스킬: /design\nCreate a mockup", skills: "", tools, output: "Done" }), []);
  }
});

test("HTML mockup artifacts satisfy design verification without a visible skill trace", () => {
  for (const agent of ["claude", "codex"] as const) {
    assert.deepEqual(workerInvocationWarnings({ agent, brief: "스킬: frontend-design\nUse /design for a mockup", skills: "selected instructions", tools: "Write: /tmp/mockup.html", output: "Created /tmp/mockup.html" }), []);
  }
});

test("design artifacts do not waive unrelated explicitly requested skills", () => {
  const warnings = workerInvocationWarnings({ agent: "claude", brief: "스킬: frontend-design, security-review\nCreate a mockup", skills: "", tools: "Write: mockup.html", output: "Created mockup.html" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /확인할 수 없/);
});

test("blocked design reports one optional local fallback note without requiring consent", () => {
  for (const output of [
    'Skill design cannot be used with Skill tool due to disable-model-invocation',
    'Claude Design access denied (403)',
    '/design is not available for this account',
    'Claude Design\nYou do not have access to this feature',
  ]) {
    const warnings = workerInvocationWarnings({ agent: "claude", brief: "스킬: /design\nCreate a mockup", skills: "", tools: 'Skill: {"skill":"design"}', output });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /선택 사항/);
    assert.match(warnings[0], /로컬.*HTML/);
    assert.doesNotMatch(warnings[0], /consent를 실행|확인해야 합니다/);
  }
});

test("ordinary unbriefed work does not warn", () => {
  assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "Fix tests", skills: "", tools: "Read: app.tsx", output: "Done" }), []);
});
