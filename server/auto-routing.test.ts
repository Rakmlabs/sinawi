import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask, recommendAutoSwitch } from "./auto-routing.js";
import { defaultRoutingSettings, type PlannerRunner, type RoutingRule } from "./routing.js";
import { mediaRouteRequired } from "./media-routing.js";
import type { UsageContext } from "./usage.js";

function settings() {
  const value = structuredClone(defaultRoutingSettings);
  for (const agent of ["codex", "claude", "grok"] as const) value.modelOptions[agent].authStatus = "authenticated";
  return value;
}

test("custom literal and regex rules are aggregated while invalid regex is ignored", () => {
  const rules: RoutingRule[] = [
    { id: "code", label: "코드", keywords: ["typescript", "/\\btsx?\\b/i", "/[/"], orchestrator: "codex", workers: ["claude"], reason: "코드 변경" },
    { id: "research", label: "조사", keywords: ["typescript"], orchestrator: "grok", workers: ["claude"], reason: "정보 조사" },
  ];
  assert.deepEqual(classifyTask("TypeScript TSX를 수정", rules), {
    agent: "codex", workers: ["claude"], confidence: 0.98, reason: "코드 규칙: 코드 변경",
  });
});

test("custom rules preserve same-agent duplicate worker slots", () => {
  const rules: RoutingRule[] = [
    { id: "parallel", label: "병렬", keywords: ["parallel"], orchestrator: "codex", workers: ["codex", "codex"], reason: "독립 세션" },
  ];
  assert.deepEqual(classifyTask("parallel", rules)?.workers, ["codex", "codex"]);
});

test("no built-in keyword rules: without a user rule the AI classifier decides", () => {
  for (const prompt of ["서비스 아키텍처를 설계해줘", "로그인 버그를 수정해줘", "공식 문서를 조사하고 비교해줘", "클로드 디자인으로 시안 만들어줘"]) {
    assert.equal(classifyTask(prompt, []), undefined, prompt);
    assert.equal(classifyTask(prompt, defaultRoutingSettings.rules, false), undefined, prompt);
  }
});

test("smart media rules keep video ahead of image matches and preserve worker priority", () => {
  assert.deepEqual(classifyTask("React로 광고 영상과 썸네일을 만들어줘", defaultRoutingSettings.rules), {
    agent: "grok", workers: ["grok", "codex"], confidence: 1,
    reason: `영상/쇼츠/광고 규칙: ${defaultRoutingSettings.rules[0]!.reason}`,
  });
  assert.deepEqual(classifyTask("사진 편집해줘", defaultRoutingSettings.rules), {
    agent: "grok", workers: ["grok", "codex"], confidence: 1,
    reason: `실사/분위기 이미지 규칙: ${defaultRoutingSettings.rules[2]!.reason}`,
  });
});

test("automatic routing never selects media requests or media rule ids when the workspace turns media off", async () => {
  const config = settings();
  config.rules.push({ id: "image", label: "image", keywords: ["render-pack"], orchestrator: "grok", workers: ["codex", "grok"], reason: "media" });
  let calls = 0;
  const runner: PlannerRunner = async () => {
    calls += 1;
    return { exitCode: 0, finalText: '{"agent":"grok","confidence":0.99,"reason":"media"}' };
  };
  const context: UsageContext = { workspaceId: "team", sessionId: "team-media", role: "router" };

  assert.equal(await recommendAutoSwitch("로고 이미지를 만들어줘", process.cwd(), config, ["claude", "grok"], runner, undefined, context, undefined, false), undefined);
  assert.equal(await recommendAutoSwitch("render-pack", process.cwd(), config, ["claude", "grok"], runner, undefined, context, undefined, false), undefined);
  assert.equal(calls, 0);
  // The same id in another workspace with media on is routed normally.
  assert.equal((await recommendAutoSwitch("render-pack", process.cwd(), config, ["claude", "grok"], runner, undefined, { ...context, workspaceId: "company" }))?.agent, "grok");
});

test("ordinary image and video terminology is not treated as media generation", () => {
  for (const prompt of ["Docker image 버그 수정", "CSS clip-path 디자인", "photo storage metadata 조사", "video player 구현"]) {
    assert.equal(mediaRouteRequired(prompt, defaultRoutingSettings.rules), false, prompt);
    assert.equal(classifyTask(prompt, defaultRoutingSettings.rules, false), undefined, prompt);
  }
});

test("media generation is not reassigned when Grok is unavailable", async () => {
  let calls = 0;
  const runner: PlannerRunner = async () => {
    calls += 1;
    return { exitCode: 0, finalText: '{"agent":"claude","confidence":0.99,"reason":"대체"}' };
  };
  assert.equal(await recommendAutoSwitch("로고 시안을 만들어줘", process.cwd(), settings(), ["claude", "codex"], runner), undefined);
  assert.equal(calls, 0);
});

test("a tied custom match is ambiguous", () => {
  const rules: RoutingRule[] = [
    { id: "a", label: "A", keywords: ["작업"], orchestrator: "codex", workers: ["claude"], reason: "A" },
    { id: "b", label: "B", keywords: ["작업"], orchestrator: "claude", workers: ["codex"], reason: "B" },
  ];
  assert.equal(classifyTask("작업", rules), undefined);
  assert.equal(classifyTask("UI looks okay", defaultRoutingSettings.rules), undefined);
  assert.equal(classifyTask("React UI를 구현해줘", defaultRoutingSettings.rules), undefined);
  assert.equal(classifyTask("로고 목업", defaultRoutingSettings.rules)?.agent, "grok");
  assert.equal(classifyTask("build a reaction", defaultRoutingSettings.rules), undefined);
});

const codeRule: RoutingRule = { id: "code", label: "코드", keywords: ["버그"], orchestrator: "codex", workers: ["claude"], reason: "사용자 규칙" };
test("a user rule avoids the classifier while unmatched input is classified by the AI", async () => {
  const config = settings();
  config.rules.push(codeRule);
  let calls = 0;
  let prompt = "";
  const runner: PlannerRunner = async (options) => {
    calls += 1;
    prompt = options.prompt;
    assert.equal(options.agent, "claude");
    assert.equal(options.model, "haiku");
    assert.equal(options.readOnly, true);
    return { exitCode: 0, finalText: '{"agent":"grok","confidence":0.91,"reason":"리서치"}' };
  };
  assert.equal((await recommendAutoSwitch("버그를 수정해줘", process.cwd(), config, ["codex", "claude", "grok"], runner))?.agent, "codex");
  assert.equal(calls, 0);
  const unmatched = await recommendAutoSwitch("다음 단계로 진행해줘", process.cwd(), config, ["codex", "claude", "grok"], runner);
  assert.equal(unmatched?.agent, "grok");
  assert.equal(calls, 1);
  // The classifier gets facts about each CLI, not a keyword table.
  assert.match(prompt, /Claude Design/);
  assert.doesNotMatch(prompt, /기획·설계는 claude/);
});

test("an unmatched request does not switch when the AI classifier fails", async () => {
  const failing: PlannerRunner = async () => ({ exitCode: 1, finalText: "" });
  assert.equal(await recommendAutoSwitch("계속해줘", process.cwd(), settings(), ["claude", "codex"], failing), undefined);
});

test("non-Claude fallback uses low effort", async () => {
  const config = settings();
  config.planner = { agent: "codex", model: "cheap-codex", reasoningEffort: "high" };
  const runner: PlannerRunner = async (options) => {
    assert.equal(options.model, "cheap-codex");
    assert.equal(options.reasoningEffort, "low");
    return { exitCode: 0, finalText: '{"agent":"claude","confidence":0.9,"reason":"설계"}' };
  };
  assert.equal((await recommendAutoSwitch("설계하고 구현해줘", process.cwd(), config, ["codex", "claude", "grok"], runner))?.agent, "claude");
});

test("automatic routing uses the orchestrator agent as worker when it is the only authenticated CLI", async () => {
  const config = settings();
  config.planner = { agent: "codex" };
  config.rules.push(codeRule);
  assert.deepEqual((await recommendAutoSwitch("버그를 수정해줘", process.cwd(), config, ["codex"]))?.workers, ["codex"]);
  let calls = 0;
  const runner: PlannerRunner = async () => {
    calls += 1;
    return { exitCode: 0, finalText: '{"agent":"codex","confidence":0.9,"reason":"구현"}' };
  };
  assert.deepEqual((await recommendAutoSwitch("설계하고 구현해줘", process.cwd(), config, ["codex"], runner))?.workers, ["codex"]);
  assert.equal(calls, 1);
});

test("fallback classifier records router usage against the app session", async () => {
  const context: UsageContext = { workspaceId: "company", sessionId: "app-session", role: "router", dataDir: "/tmp/router-usage" };
  let calls = 0;
  const runner: PlannerRunner = async (options) => {
    calls += 1;
    assert.deepEqual(options.usageContext, context);
    return { exitCode: 0, finalText: '{"agent":"grok","confidence":0.9,"reason":"조사"}' };
  };
  assert.equal((await recommendAutoSwitch("설계하고 구현해줘", process.cwd(), settings(), ["claude", "grok"], runner, undefined, context))?.agent, "grok");
  assert.equal(calls, 1);
});

test("fallback classifier remaps a prohibited configured router to an authenticated permitted agent", async () => {
  const config = settings();
  config.planner = { agent: "codex", model: "forbidden-model", reasoningEffort: "high" };
  let calls = 0;
  const runner: PlannerRunner = async (options) => {
    calls += 1;
    assert.equal(options.agent, "claude");
    assert.equal(options.model, "haiku");
    assert.equal(options.reasoningEffort, undefined);
    assert.match(options.prompt, /허용된 에이전트: claude, grok/);
    return { exitCode: 0, finalText: '{"agent":"grok","confidence":0.9,"reason":"조사"}' };
  };

  assert.equal((await recommendAutoSwitch("설계하고 구현해줘", process.cwd(), config, ["claude", "grok"], runner))?.agent, "grok");
  assert.equal(calls, 1);
});

test("fallback failures, low confidence, unavailable authentication, and timeout do not switch", async () => {
  const config = settings();
  const agents = ["codex", "claude", "grok"] as const;
  const ambiguous = "설계하고 구현해줘";
  const failed: PlannerRunner = async () => ({ exitCode: 1, finalText: "" });
  assert.equal(await recommendAutoSwitch(ambiguous, process.cwd(), config, [...agents], failed), undefined);
  const throwsSynchronously: PlannerRunner = (() => { throw new Error("classifier unavailable"); }) as PlannerRunner;
  assert.equal(await recommendAutoSwitch(ambiguous, process.cwd(), config, [...agents], throwsSynchronously), undefined);

  const weak: PlannerRunner = async () => ({ exitCode: 0, finalText: '{"agent":"codex","confidence":0.5,"reason":"애매"}' });
  assert.equal(await recommendAutoSwitch(ambiguous, process.cwd(), config, [...agents], weak), undefined);

  config.modelOptions.codex.authStatus = "unauthenticated";
  const recommendsCodex: PlannerRunner = async () => ({ exitCode: 0, finalText: '{"agent":"codex","confidence":0.99,"reason":"코딩"}' });
  assert.equal(await recommendAutoSwitch(ambiguous, process.cwd(), config, [...agents], recommendsCodex), undefined);
  assert.equal(await recommendAutoSwitch("구현해줘", process.cwd(), config, [...agents], recommendsCodex), undefined);

  const hanging: PlannerRunner = () => new Promise(() => undefined);
  const started = Date.now();
  assert.equal(await recommendAutoSwitch(ambiguous, process.cwd(), settings(), [...agents], hanging, undefined, undefined, 15), undefined);
  assert.ok(Date.now() - started < 250);

  const controller = new AbortController();
  const pending = recommendAutoSwitch(ambiguous, process.cwd(), settings(), [...agents], hanging, controller.signal, undefined, 1_000);
  controller.abort();
  assert.equal(await pending, undefined);
});

test("unknown authentication does not block automatic routing", async () => {
  const config = settings();
  for (const id of ["codex", "claude", "grok"] as const) config.modelOptions[id].authStatus = "unknown";
  config.rules.push(codeRule);
  const result = await recommendAutoSwitch("로그인 버그를 수정해줘", process.cwd(), config, ["codex", "claude", "grok"], async () => { throw new Error("rule should avoid planner"); });
  assert.equal(result?.agent, "codex");
});
