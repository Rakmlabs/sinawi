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

test("built-in rules distinguish planning, coding, and research", () => {
  assert.equal(classifyTask("서비스 아키텍처를 설계해줘", [])?.agent, "claude");
  assert.equal(classifyTask("로그인 버그를 수정해줘", [])?.agent, "codex");
  assert.equal(classifyTask("공식 문서를 조사하고 비교해줘", [])?.agent, "grok");
  assert.equal(classifyTask("설계하고 구현해줘", []), undefined);
  assert.equal(classifyTask("설계하고 구현해줘", defaultRoutingSettings.rules), undefined);
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

test("company automatic routing never selects media requests or media rule ids", async () => {
  const config = settings();
  config.rules.push({ id: "image", label: "image", keywords: ["render-pack"], orchestrator: "grok", workers: ["codex", "grok"], reason: "media" });
  let calls = 0;
  const runner: PlannerRunner = async () => {
    calls += 1;
    return { exitCode: 0, finalText: '{"agent":"grok","confidence":0.99,"reason":"media"}' };
  };
  const context: UsageContext = { workspaceId: "company", sessionId: "company-media", role: "router" };

  assert.equal(await recommendAutoSwitch("로고 이미지를 만들어줘", process.cwd(), config, ["claude", "grok"], runner, undefined, context), undefined);
  assert.equal(await recommendAutoSwitch("render-pack", process.cwd(), config, ["claude", "grok"], runner, undefined, context), undefined);
  assert.equal(calls, 0);
});

test("ordinary company image and video terminology is not treated as media generation", () => {
  const cases = [
    ["Docker image 버그 수정", "codex"],
    ["CSS clip-path 디자인", "claude"],
    ["photo storage metadata 조사", "grok"],
    ["video player 구현", "codex"],
  ] as const;

  for (const [prompt, expectedAgent] of cases) {
    assert.equal(mediaRouteRequired(prompt, defaultRoutingSettings.rules), false, prompt);
    assert.equal(classifyTask(prompt, defaultRoutingSettings.rules, "company")?.agent, expectedAgent, prompt);
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
  assert.equal(classifyTask("React UI를 구현해줘", defaultRoutingSettings.rules)?.agent, "claude");
  assert.equal(classifyTask("문서를 작성해줘", defaultRoutingSettings.rules)?.agent, "claude");
  assert.equal(classifyTask("코드를 검토해줘", defaultRoutingSettings.rules)?.agent, "claude");
  assert.equal(classifyTask("디자인 리뷰", defaultRoutingSettings.rules)?.agent, "claude");
  assert.equal(classifyTask("로고 목업", defaultRoutingSettings.rules)?.agent, "grok");
  assert.equal(classifyTask("React", defaultRoutingSettings.rules), undefined);
  assert.equal(classifyTask("build a reaction", defaultRoutingSettings.rules), undefined);
});

test("clear rules avoid fallback while unmatched input defaults to Claude", async () => {
  const config = settings();
  let calls = 0;
  const runner: PlannerRunner = async (options) => {
    calls += 1;
    assert.equal(options.agent, "claude");
    assert.equal(options.model, "haiku");
    assert.equal(options.reasoningEffort, undefined);
    assert.equal(options.readOnly, true);
    return { exitCode: 0, finalText: '{"agent":"codex","confidence":0.91,"reason":"구현 후속 작업"}' };
  };
  assert.equal((await recommendAutoSwitch("버그를 수정해줘", process.cwd(), config, ["codex", "claude", "grok"], runner))?.agent, "codex");
  assert.equal(calls, 0);
  const unmatched = await recommendAutoSwitch("다음 단계로 진행해줘", process.cwd(), config, ["codex", "claude", "grok"], runner);
  assert.equal(unmatched?.agent, "claude");
  assert.match(unmatched?.reason ?? "", /기본 오케스트레이터 Claude/);
  assert.equal(calls, 0);
});

test("unmatched automatic routing falls back from unavailable Claude to Codex then Grok", async () => {
  const config = settings();
  assert.equal((await recommendAutoSwitch("계속해줘", process.cwd(), config, ["claude", "codex"]))?.agent, "claude");
  assert.equal((await recommendAutoSwitch("계속해줘", process.cwd(), config, ["codex"]))?.agent, "codex");
  assert.equal((await recommendAutoSwitch("계속해줘", process.cwd(), config, ["grok"]))?.agent, "grok");
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
  const result = await recommendAutoSwitch("로그인 버그를 수정해줘", process.cwd(), config, ["codex", "claude", "grok"], async () => { throw new Error("rule should avoid planner"); });
  assert.equal(result?.agent, "codex");
});
