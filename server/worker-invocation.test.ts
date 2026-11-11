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

test("an HTML artifact does not waive injected non-design skill instructions", () => {
  const warnings = workerInvocationWarnings({ agent: "codex", brief: "Create a report", skills: "selected security-review instructions", tools: "Write: report.html", output: "Created report.html" });
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
    assert.match(warnings[0], /선택한 로컬 스킬.*없으면.*프로젝트.*패턴/);
    assert.doesNotMatch(warnings[0], /consent를 실행|확인해야 합니다/);
  }
});

test("ordinary unbriefed work does not warn", () => {
  assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief: "Fix tests", skills: "", tools: "Read: app.tsx", output: "Done" }), []);
});

test("attached skills do not waive invocation evidence for another native skill", () => {
  const warnings = workerInvocationWarnings({ agent: "codex", brief: "스킬: vendor-review, native-review", skills: "", attachedSkills: ["vendor-review"], tools: "", output: "Done" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /확인할 수 없/);
});

test("a 403 in file content or a tap coordinate is not /design being blocked", () => {
  const brief = "스킬: impeccable\n## 목표\n상세 화면을 고친다. /design은 쓰지 않는다.";
  const tools = [
    "스킬 불러옴: impeccable",
    "도구 결과: 402\t    </View>\n403\t      <Text size={15} weight=\"bold\">{value}</Text>\n404\t    </View>",
    "도구 결과: Button \"a, 11명 · 1층, 바로 사용 가능 · 19:00까지\" 탭 201 403",
    "도구 결과: 403\t};",
  ].join("\n");
  assert.deepEqual(workerInvocationWarnings({ agent: "claude", brief, skills: "impeccable", tools, output: "상태: 완료" }), []);
});
