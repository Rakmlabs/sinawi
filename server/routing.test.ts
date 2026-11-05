import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routingInput } from "./server.js";
import { mutateToolSettings, workspaceToolSettings } from "./store.js";
import { defaultWorkspacePolicy, mediaBlockedMessage, WorkspacePolicyError } from "./workspace-policy.js";
import {
  defaultRoutingSettings, discoverLocalModels, loadRoutingSettings, RoutingService, saveRoutingSettings, validateRoutingSettings,
  type PlannerRunner,
} from "./routing.js";

const fixtureSkills = [
  { id: "react-skill", name: "React", source: "Test", description: "React UI component implementation" },
  { id: "docs-skill", name: "문서 작성", source: "Test", description: "기술 문서를 작성합니다" },
];

test("routing settings are validated and persisted in the selected data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-routing-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.planner.model = "sonnet";
  settings.rules[0].keywords.push("component");
  await saveRoutingSettings(settings, directory);
  assert.deepEqual(await loadRoutingSettings(directory), settings);
  assert.equal(JSON.parse(await readFile(join(directory, "routing-settings.json"), "utf8")).planner.model, "sonnet");
  assert.throws(() => validateRoutingSettings({ ...settings, planner: { agent: "unknown" } }), /지원하지 않는 에이전트/);
});

test("stale persisted authentication state is ignored when settings load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-routing-auth-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.modelOptions.grok.authStatus = "unauthenticated";
  settings.modelOptions.grok.authDetail = "stale startup failure";
  await writeFile(join(directory, "routing-settings.json"), `${JSON.stringify(settings)}\n`);

  const loaded = await loadRoutingSettings(directory);

  assert.equal(loaded.modelOptions.grok.authStatus, undefined);
  assert.equal(loaded.modelOptions.grok.authDetail, undefined);
});

test("personal media defaults put video, text images, then visual images before generic rules", () => {
  assert.deepEqual(defaultRoutingSettings.rules.slice(0, 3).map((rule) => rule.id), ["video", "image-text", "image-visual"]);
  assert.deepEqual(defaultRoutingSettings.rules[0]?.workers, ["grok", "codex"]);
  assert.deepEqual(defaultRoutingSettings.rules[1]?.workers, ["codex", "grok"]);
  assert.deepEqual(defaultRoutingSettings.rules[2]?.workers, ["grok", "codex"]);
  assert.match(defaultRoutingSettings.rules[1]?.reason ?? "", /Codex 내장 이미지 생성\(GPT image\)/);
  assert.match(defaultRoutingSettings.rules[2]?.reason ?? "", /Grok Imagine\(image_gen\/edit\/image_to_video\)/);
  // Shipped defaults name no third-party tool.
  assert.ok(defaultRoutingSettings.rules.every((rule) => !/bbanana/i.test(rule.reason)));
});

test("saved settings replace the shipped image rule with the ordered smart media rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next22-migration-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules = [
    { id: "image", label: "이미지 생성", keywords: ["generate image", "create image", "edit image", "generate photo", "edit photo", "image generation", "image editing"], orchestrator: "grok", workers: ["codex", "grok"], reason: "bbanana MCP와 Grok Imagine으로 이미지를 생성·편집합니다." },
    { id: "custom", label: "custom", keywords: ["custom"], orchestrator: "claude", workers: ["claude"], reason: "custom" },
  ];
  await writeFile(join(directory, "routing-settings.json"), `${JSON.stringify(settings)}\n`);

  const loaded = await loadRoutingSettings(directory);
  assert.deepEqual(loaded.rules.map((rule) => rule.id), ["video", "image-text", "image-visual", "custom"]);
  assert.equal(loaded.rules.find((rule) => rule.id === "image"), undefined);
});

test("saved custom image rules are preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next23-custom-image-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules = [{ id: "image", label: "custom image", keywords: ["render-pack"], orchestrator: "claude", workers: ["claude"], reason: "custom" }];
  await writeFile(join(directory, "routing-settings.json"), `${JSON.stringify(settings)}\n`);
  assert.deepEqual((await loadRoutingSettings(directory)).rules, settings.rules);
});

test("migration preserves legacy-shaped image rules with customized keywords and Grok-only media rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next23-customized-legacy-"));
  const settings = structuredClone(defaultRoutingSettings);
  const customImage = {
    id: "image", label: "이미지 생성",
    keywords: ["generate image", "create image", "edit image", "generate photo", "edit photo", "image generation", "image editing", "brand-asset"],
    orchestrator: "grok" as const, workers: ["codex", "grok"] as ("codex" | "grok")[],
    reason: "bbanana MCP와 Grok Imagine으로 이미지를 생성·편집합니다.",
  };
  const customVideo = { id: "video", label: "custom video", keywords: ["cinematic"], orchestrator: "grok" as const, workers: ["grok"] as "grok"[], reason: "custom" };
  settings.rules = [customImage, customVideo];
  await writeFile(join(directory, "routing-settings.json"), `${JSON.stringify(settings)}\n`);

  const loaded = await loadRoutingSettings(directory);
  assert.deepEqual(loaded.rules, settings.rules);
});

test("legacy image migration preserves unrelated customized media rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next23-mixed-media-"));
  const settings = structuredClone(defaultRoutingSettings);
  const legacyImage = {
    id: "image", label: "이미지 생성",
    keywords: ["generate image", "create image", "edit image", "generate photo", "edit photo", "image generation", "image editing"],
    orchestrator: "grok" as const, workers: ["codex", "grok"] as ("codex" | "grok")[],
    reason: "bbanana MCP와 Grok Imagine으로 이미지를 생성·편집합니다.",
  };
  const customVideo = { id: "video", label: "custom video", keywords: ["cinematic"], orchestrator: "grok" as const, workers: ["grok"] as "grok"[], reason: "custom" };
  settings.rules = [legacyImage, customVideo, { id: "custom", label: "custom", keywords: ["custom"], orchestrator: "claude", workers: ["claude"], reason: "custom" }];
  await writeFile(join(directory, "routing-settings.json"), `${JSON.stringify(settings)}\n`);

  const loaded = await loadRoutingSettings(directory);
  assert.deepEqual(loaded.rules.slice(0, 3).map((rule) => rule.id), ["video", "image-text", "image-visual"]);
  assert.deepEqual(loaded.rules[0], customVideo);
  assert.equal(loaded.rules.at(-1)?.id, "custom");
});

test("routing rejects media requests and media rule matches when the workspace turns media off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next22-company-media-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules.find((rule) => rule.id === "video")!.keywords = ["cinematic"];
  await saveRoutingSettings(settings, directory);
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [], runner: async () => { throw new Error("must not run"); } });
  const usageContext = { workspaceId: "team", sessionId: "team-session", role: "router" as const };
  const policy = { ...defaultWorkspacePolicy(), mediaGeneration: false };

  for (const prompt of ["로고 이미지를 만들어줘", "cinematic campaign"]) {
    await assert.rejects(
      () => service.recommend(prompt, directory, [], ["claude", "grok"], usageContext, ["claude", "grok"], policy),
      (error: unknown) => error instanceof WorkspacePolicyError && error.message === mediaBlockedMessage,
    );
  }
});

test("personal media routing preserves customized media workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next22-custom-media-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules.find((rule) => rule.id === "image-text")!.workers = ["claude"];
  await saveRoutingSettings(settings, directory);
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [] });

  const recommendation = await service.recommend("로고 이미지를 만들어줘", directory, [], ["claude", "grok"]);
  assert.deepEqual(recommendation.workers.map((worker) => worker.agent), ["claude"]);
});

test("routing rules accept same-agent and repeated worker slots but still require a worker", () => {
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules = [{
    id: "same-agent", label: "동일 에이전트", keywords: ["solo"], orchestrator: "codex",
    workers: ["codex", "codex"], reason: "독립 Codex 세션 두 개",
  }];
  assert.deepEqual(validateRoutingSettings(settings).rules[0].workers, ["codex", "codex"]);
  settings.rules[0].workers = [];
  assert.throws(() => validateRoutingSettings(settings), /작업자가 한 명 이상/);
});

test("initial settings discover bounded model identifiers from local CLI config and cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-model-home-"));
  const data = await mkdtemp(join(tmpdir(), "orchestra-model-data-"));
  await Promise.all([mkdir(join(home, ".codex")), mkdir(join(home, ".claude")), mkdir(join(home, ".grok"))]);
  await writeFile(join(home, ".codex", "config.toml"), 'model = "configured-codex"\napi_key = "must-not-be-read"\n');
  await writeFile(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "cache-codex", secret: "ignored" }, { slug: "configured-codex" }, { slug: "bad model id" }] }));
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-local", env: { ANTHROPIC_MODEL: "claude-env", API_KEY: "ignored" } }));
  await writeFile(join(home, ".grok", "config.json"), JSON.stringify({ model: "grok-local", token: "ignored" }));

  const settings = await loadRoutingSettings(data, home);
  assert.deepEqual(settings.modelOptions.codex.models.slice(0, 2), ["configured-codex", "cache-codex"]);
  assert.deepEqual(settings.modelOptions.claude.models.slice(0, 2), ["claude-local", "claude-env"]);
  assert.equal(settings.modelOptions.grok.models[0], "grok-local");
  assert.equal(settings.planner.model, "claude-local");
  assert.equal(settings.modelOptions.codex.source, "cli");
  assert.match(settings.modelOptions.codex.sourceDetail, /전체 카탈로그를 보장하지 않습니다/);

  settings.modelOptions.codex.models = ["user-preserved"];
  settings.modelOptions.codex.source = "preset";
  settings.modelOptions.codex.sourceDetail = "사용자가 저장한 목록";
  await saveRoutingSettings(settings, data);
  await writeFile(join(home, ".codex", "config.toml"), 'model = "later-config"\n');
  assert.deepEqual((await loadRoutingSettings(data, home)).modelOptions.codex.models, ["user-preserved"]);
});

test("oversized or malformed discovery inputs fall back to editable presets", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-model-invalid-"));
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex", "models_cache.json"), "x".repeat(1_000_001));
  const settings = await discoverLocalModels(home);
  assert.equal(settings.modelOptions.codex.source, "preset");
  assert.deepEqual(settings.modelOptions.grok.reasoningEfforts, []);
});

test("a corrupt saved settings file surfaces an error instead of replacing user configuration", async () => {
  const data = await mkdtemp(join(tmpdir(), "orchestra-corrupt-settings-"));
  await writeFile(join(data, "routing-settings.json"), "{ not valid json");
  await assert.rejects(() => loadRoutingSettings(data), /저장된 라우팅 설정을 읽을 수 없습니다/);
});

test("planner JSON is kept when no user rule matches and automatic and explicit skills are retained", async () => {
  let plannerAgent = "";
  let plannerEffort = "";
  let plannerReadOnly = false;
  const runner: PlannerRunner = async (options) => {
    plannerAgent = options.agent;
    plannerEffort = options.reasoningEffort ?? "";
    plannerReadOnly = options.readOnly ?? false;
    return {
      exitCode: 0,
      finalText: "```json\n" + JSON.stringify({
        planner: { agent: "codex", model: "gpt-5", reasoningEffort: "high", reason: "구현 계획에 적합" },
        orchestrator: { agent: "codex", model: "not-configured", reasoningEffort: "high", reason: "구현 중심" },
        workers: [{ agent: "claude", model: "opus", reasoningEffort: "high", reason: "UI 검토" }],
        skills: [], reason: "코드와 UI를 함께 다룹니다.",
      }) + "\n```",
    };
  };
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const service = new RoutingService({ runner, homeDir: home, skillLoader: async () => fixtureSkills });
  const recommendation = await service.recommend("React 화면을 구현해줘", process.cwd(), ["react-skill", "missing"]);
  assert.equal(plannerAgent, "claude");
  assert.equal(plannerEffort, "high");
  assert.equal(plannerReadOnly, true);
  assert.equal(recommendation.source, "planner");
  assert.equal(recommendation.planner.agent, "codex");
  assert.equal(recommendation.planner.model, undefined);
  // No shipped keyword rule overrides the planner: its own choice stands.
  assert.equal(recommendation.orchestrator.agent, "codex");
  assert.deepEqual(recommendation.workers.map((worker) => worker.agent), ["claude"]);
  assert.deepEqual(recommendation.skills, ["react-skill"]);
});

test("planner failures surface a warning and fall back to editable routing rules and skill matching", async () => {
  const runner: PlannerRunner = async () => { throw new Error("planner unavailable"); };
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const service = new RoutingService({ runner, homeDir: home, skillLoader: async () => fixtureSkills });
  const recommendation = await service.recommend("React UI 디자인을 개선해줘", process.cwd());
  assert.equal(recommendation.source, "fallback");
  assert.deepEqual(recommendation.skills, ["react-skill"]);
  assert.match(recommendation.reason, /일치하는 규칙이 없어/);
  assert.match(recommendation.warning ?? "", /planner unavailable/);
});

test("planner execution is bounded by the configured timeout", async () => {
  let aborted = false;
  const runner: PlannerRunner = (options) => new Promise(() => {
    options.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
  });
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const service = new RoutingService({ runner, homeDir: home, skillLoader: async () => [], timeoutMs: 10 });
  const started = Date.now();
  const recommendation = await service.recommend("평범한 요청", process.cwd());
  assert.ok(Date.now() - started < 500, "recommend() should settle even if the runner ignores abort");
  assert.equal(aborted, true);
  assert.equal(recommendation.source, "fallback");
  assert.match(recommendation.warning ?? "", /시간이 초과/);
});

test("routing loads project skills for the requested cwd and normalizes stale planner models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-routing-cwd-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.planner.model = "removed-model";
  await saveRoutingSettings(settings, directory);
  let loadedCwd = "";
  let invokedModel: string | undefined;
  const service = new RoutingService({
    dataDir: directory,
    skillLoader: async (cwd) => { loadedCwd = cwd ?? ""; return fixtureSkills; },
    runner: async (options) => {
      invokedModel = options.model;
      return { exitCode: 1, finalText: "" };
    },
  });
  const recommendation = await service.recommend("문서를 작성해줘", directory);
  assert.equal(loadedCwd, directory);
  assert.equal(invokedModel, "opus");
  assert.match(recommendation.reason, /일치하는 규칙이 없어/);
});

test("latin routing keywords use word boundaries and skill matching ignores common words", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const runner: PlannerRunner = async () => { throw new Error("fallback"); };
  const skills = [{ id: "generic", name: "Helper", source: "Test", description: "For the user with an agent skill" }];
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-latin-rules-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules.push({ id: "frontend", label: "프론트엔드 UI", keywords: ["프론트", "ui", "ux", "react", "css"], orchestrator: "claude", workers: ["codex"], reason: "사용자 규칙" });
  await saveRoutingSettings(settings, dataDir);
  const service = new RoutingService({ runner, homeDir: home, dataDir, skillLoader: async () => skills });
  const ordinary = await service.recommend("build backend suite with data", process.cwd());
  assert.equal(ordinary.reason, "일치하는 규칙이 없어 기본 구성을 추천했습니다.");
  assert.deepEqual(ordinary.skills, []);
  const frontend = await service.recommend("React UI를 구현해줘", process.cwd());
  assert.equal(frontend.orchestrator.agent, "claude");
  assert.match(frontend.reason, /프론트엔드 UI 규칙/);
});

test("successful planner output preserves repeated workers that match its orchestrator", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const runner: PlannerRunner = async () => ({
    exitCode: 0,
    finalText: JSON.stringify({ orchestrator: { agent: "codex", reason: "구현" }, workers: [
      { id: "codex-primary", label: "Codex 1", agent: "codex", reason: "첫 번째 구현 세션" },
      { id: "codex-review", label: "Codex 2", agent: "codex", reason: "두 번째 구현 세션" },
    ], skills: [], reason: "추천" }),
  });
  const service = new RoutingService({ runner, homeDir: home, skillLoader: async () => [] });
  const recommendation = await service.recommend("backend endpoint 구현", process.cwd());
  assert.equal(recommendation.source, "planner");
  assert.deepEqual(recommendation.workers.map((worker) => worker.agent), ["codex", "codex"]);
  assert.deepEqual(recommendation.workers.map((worker) => worker.id), ["codex-primary", "codex-review"]);
  assert.deepEqual(recommendation.workers.map((worker) => worker.label), ["Codex 1", "Codex 2"]);
  assert.deepEqual(recommendation.workers.map((worker) => worker.reason), ["첫 번째 구현 세션", "두 번째 구현 세션"]);
});

test("routing fallback works when one CLI fills orchestrator and worker roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-solo-routing-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.planner = { agent: "codex" };
  settings.rules = [{ id: "solo", label: "Solo", keywords: ["solo"], orchestrator: "codex", workers: ["codex"], reason: "한 CLI" }];
  await saveRoutingSettings(settings, directory);
  const service = new RoutingService({ dataDir: directory, runner: async () => { throw new Error("fallback"); }, skillLoader: async () => [] });
  const recommendation = await service.recommend("solo", process.cwd(), [], ["codex"]);
  assert.equal(recommendation.orchestrator.agent, "codex");
  assert.deepEqual(recommendation.workers.map((worker) => worker.agent), ["codex"]);
});

test("availability constrains planner output and reports unavailable configured rules and routers", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestra-empty-home-"));
  const runner: PlannerRunner = async () => ({
    exitCode: 0,
    finalText: JSON.stringify({ planner: { agent: "grok", reason: "계획" }, orchestrator: { agent: "grok", reason: "실행" }, workers: [{ agent: "codex", reason: "작업" }], skills: [], reason: "추천" }),
  });
  const service = new RoutingService({ runner, homeDir: home, skillLoader: async () => [] });
  const recovered = await service.recommend("backend endpoint 구현", process.cwd(), [], ["claude", "codex"]);
  assert.equal(recovered.source, "fallback");
  assert.equal(recovered.orchestrator.agent, "claude");
  assert.deepEqual(recovered.workers.map((worker) => worker.agent), ["codex"]);
  assert.match(recovered.warning ?? "", /설치되지 않은 에이전트/);

  const mediaFallback = await service.recommend("로고를 만들어줘", process.cwd(), [], ["claude", "grok"]);
  assert.deepEqual(mediaFallback.workers.map((worker) => worker.agent), ["grok"]);
  await assert.rejects(
    () => service.recommend("backend endpoint 구현", process.cwd(), [], ["codex", "grok"]),
    /설정된 라우터 claude CLI를 사용할 수 없습니다/,
  );
});

test("routing API input requires prompt and cwd and deduplicates explicit skills", () => {
  assert.throws(() => routingInput({ cwd: process.cwd() }), /문자열 값/);
  assert.throws(() => routingInput({ prompt: "요청", cwd: process.cwd(), skills: "react-skill" }), /목록 값/);
  const input = routingInput({ prompt: " React UI ", cwd: ".", skills: ["react-skill", "react-skill"] });
  assert.equal(input.prompt, "React UI");
  assert.equal(input.cwd, process.cwd());
  assert.deepEqual(input.skills, ["react-skill"]);
});


test("explicit slash skills take priority when automatic selections reach the skill limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-routing-explicit-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  const skills = Array.from({ length: 21 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`, source: "test", description: "" }));
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => skills, runner: async () => ({ exitCode: 0, finalText: JSON.stringify({
    orchestrator: { agent: "claude", reason: "총괄" }, workers: [{ agent: "codex", reason: "구현" }],
    skills: skills.slice(0, 20).map((skill) => skill.id), reason: "추천",
  }) }) });
  const recommendation = await service.recommend("기능 구현", directory, ["skill-20"]);
  assert.equal(recommendation.skills.length, 20);
  assert.equal(recommendation.skills[0], "skill-20");
});

test("unmatched recommendations prefer Claude and respect permitted fallback order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-default-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [], runner: async () => { throw new Error("offline"); } });
  for (const [available, expected] of [
    [["codex", "claude", "grok"], "claude"], [["codex", "claude"], "claude"], [["codex"], "codex"], [["grok"], "grok"],
  ] as const) {
    const result = await service.recommend("평범한 요청", directory, [], [...available], undefined, [...available]);
    assert.equal(result.orchestrator.agent, expected);
    if (expected === "claude") assert.equal(result.orchestrator.model, "opus");
    if (expected === "grok") assert.equal(result.orchestrator.model, "grok-4.7");
  }
});

test("media routing overrides saved rules and planner output and attaches the discovered shorts skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-media-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules = [{ id: "custom", label: "custom", keywords: ["영상", "디자인"], orchestrator: "codex", workers: ["claude"], reason: "custom" }];
  await saveRoutingSettings(settings, directory);
  let calls = 0;
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [{ id: "hashed-shorts", name: "marketing-shorts", source: "Test", description: "" }], runner: async () => { calls++; return { exitCode: 0, finalText: JSON.stringify({ orchestrator: { agent: "claude" }, workers: [{ agent: "codex" }], reason: "설계" }) }; } });
  for (const prompt of ["이미지", "그림", "일러스트", "썸네일", "로고 시안 디자인", "사진 편집", "영상", "동영상", "쇼츠", "릴스", "광고 영상", "애니메이션 영상", "마케팅 영상"]) {
    const result = await service.recommend(prompt, directory, [], ["grok"]);
    assert.equal(result.orchestrator.agent, "grok", prompt);
    assert.deepEqual(result.workers.map((worker) => worker.agent), ["grok"], prompt);
    if (/쇼츠|릴스|마케팅 영상/.test(prompt)) assert.ok(result.skills.includes("hashed-shorts"), prompt);
  }
  assert.equal(calls, 0, "built-in media capability needs no paid classification");
  await assert.rejects(() => service.recommend("쇼츠 만들어줘", directory, [], ["codex", "claude"], undefined, ["codex", "claude"]), /Grok 조정자를 사용할 수 없습니다/);
});

test("smart media routing applies the first matching ordered rule with its worker priority and reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next23-smart-media-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [] });
  for (const [prompt, id, workers] of [
    ["로고 한글 글자를 정확히 수정해줘", "image-text", ["codex", "grok"]],
    ["시네마틱 인물 사진을 만들어줘", "image-visual", ["grok", "codex"]],
    ["image to video 광고 영상 만들어줘", "video", ["grok", "codex"]],
  ] as const) {
    const result = await service.recommend(prompt, directory, [], ["codex", "grok"]);
    assert.deepEqual(result.workers.map((worker) => worker.agent), workers, prompt);
    assert.match(result.reason, new RegExp(defaultRoutingSettings.rules.find((rule) => rule.id === id)!.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("routing excludes workspace-disabled skills from automatic and explicit attachment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next23-disabled-routing-skill-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledSkills = ["marketing-shorts"]; }, directory);
  const skill = { id: "hashed-shorts", name: "marketing-shorts", source: "Test", description: "쇼츠 영상" };
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [skill] });
  const usageContext = { workspaceId: "personal" as const, sessionId: "route", role: "router" as const };

  const automatic = await service.recommend("쇼츠 만들어줘", directory, [], ["grok"], usageContext);
  assert.equal(automatic.skills.includes(skill.id), false);
  const explicit = await service.recommend("쇼츠 만들어줘", directory, [skill.id], ["grok"], usageContext);
  assert.equal(explicit.skills.includes(skill.id), false);
});

test("successful unmatched planner recommendations keep the planner's own orchestrator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-planner-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  const service = new RoutingService({ dataDir: directory, skillLoader: async () => [], runner: async () => ({ exitCode: 0, finalText: JSON.stringify({ orchestrator: { agent: "grok", model: "grok-4.7" }, workers: [{ agent: "codex" }], reason: "추천" }) }) });
  const result = await service.recommend("평범한 요청", directory);
  assert.equal(result.orchestrator.agent, "grok");
  assert.equal(result.orchestrator.model, "grok-4.7");
});

test("known logged-out providers are skipped by the Grok-first default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-next21-auth-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), directory);
  const service = new RoutingService({
    dataDir: directory,
    skillLoader: async () => [],
    runner: async () => { throw new Error("offline"); },
    modelRunner: async (command) => command === "grok" ? { stdout: "You are not logged in." } : { stdout: "Logged in" },
    authDiscovery: { sleep: async () => undefined },
  });
  await service.refreshModels();
  const result = await service.recommend("평범한 요청", directory, [], ["grok", "claude", "codex"], undefined, ["grok", "claude", "codex"]);
  assert.equal(result.orchestrator.agent, "claude");
});

test("unedited keyword rules from older versions are dropped on load, edited ones stay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-legacy-rules-"));
  const settings = structuredClone(defaultRoutingSettings);
  settings.rules.push(
    { id: "frontend", label: "프론트엔드 UI", keywords: ["프론트", "ui", "ux", "디자인", "react", "css"], orchestrator: "claude", workers: ["codex"], reason: "화면 설계와 사용성 판단이 중심인 작업" },
    { id: "research", label: "빠른 조사", keywords: ["조사"], orchestrator: "grok", workers: ["claude"], reason: "내가 고친 규칙" },
  );
  await writeFile(join(directory, "routing-settings.json"), JSON.stringify(settings));
  const loaded = await loadRoutingSettings(directory);
  assert.equal(loaded.rules.some((rule) => rule.id === "frontend"), false);
  assert.equal(loaded.rules.find((rule) => rule.id === "research")?.reason, "내가 고친 규칙");
});
