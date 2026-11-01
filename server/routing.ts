import { cliChildEnv } from "./supervision.js";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { runCli, type RunCliOptions } from "./cli.js";
import { filterEnabledSkills, publicSkills } from "./skills.js";
import { loadToolSettings } from "./store.js";
import type { AgentId, AgentSelection, SkillInfo } from "./types.js";
import { defaultDataDir, envVar } from "./runtime.js";
import { companyMediaUnavailableMessage, imageTextKeywords, imageVisualKeywords, isMediaRule, mediaGenerationRequired, mediaRouteRequired, mediaSkills, mediaUnavailableMessage, stripPreviewAttachments, videoKeywords } from "./media-routing.js";

const agentIds = new Set<AgentId>(["codex", "claude", "grok"]);
const execFileAsync = promisify(execFile);
const currentGrokModels = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RoutingSource = "planner" | "fallback";

export interface AgentChoice extends AgentSelection {}

export interface ModelOptions {
  models: string[];
  reasoningEfforts: ReasoningEffort[];
  source: "preset" | "cli";
  sourceDetail: string;
  authStatus?: "authenticated" | "unauthenticated" | "unknown";
  authDetail?: string;
}

export interface ModelCommandResult { stdout: string; stderr?: string; }
export type ModelCommandRunner = (command: string, args: string[]) => Promise<ModelCommandResult>;
export interface AuthDiscoveryOptions { sleep?: (milliseconds: number) => Promise<void>; }

export interface RoutingRule {
  id: string;
  label: string;
  keywords: string[];
  orchestrator: AgentId;
  workers: AgentId[];
  reason: string;
}

export interface RoutingSettings {
  planner: Omit<AgentChoice, "reason">;
  modelOptions: Record<AgentId, ModelOptions>;
  rules: RoutingRule[];
}

export interface RouteRecommendation {
  planner: AgentChoice;
  orchestrator: AgentChoice;
  workers: AgentChoice[];
  skills: string[];
  reason: string;
  source: RoutingSource;
  warning?: string;
}

export type RoutingRecommendation = RouteRecommendation;

export type PlannerRunner = typeof runCli;

const smartMediaRules: RoutingRule[] = [
  {
    id: "video", label: "영상/쇼츠/광고", keywords: [...videoKeywords], orchestrator: "grok", workers: ["grok", "codex"],
    reason: "Grok Imagine의 영상 생성·image_to_video와 Codex의 기획·ffmpeg 조립을 함께 사용합니다.",
  },
  {
    id: "image-text", label: "텍스트/디자인 이미지", keywords: [...imageTextKeywords], orchestrator: "grok", workers: ["codex", "grok"],
    reason: "Codex 내장 이미지 생성(GPT image)·bbanana GPT Image가 글자·레이아웃·정확한 편집에 강함",
  },
  {
    id: "image-visual", label: "실사/분위기 이미지", keywords: [...imageVisualKeywords], orchestrator: "grok", workers: ["grok", "codex"],
    reason: "Grok Imagine(image_gen/edit/image_to_video)·bbanana가 실사·인물·분위기, 영상 연계, 빠른 변형에 강함",
  },
];

const legacyImageRule: RoutingRule = {
  id: "image", label: "이미지 생성",
  keywords: ["generate image", "create image", "edit image", "generate photo", "edit photo", "image generation", "image editing"],
  orchestrator: "grok", workers: ["codex", "grok"],
  reason: "bbanana MCP와 Grok Imagine으로 이미지를 생성·편집합니다.",
};

const legacyVideoRule: RoutingRule = {
  id: "video", label: "영상 생성",
  keywords: ["generate video", "create video", "edit video", "video generation", "video editing"],
  orchestrator: "grok", workers: ["codex", "grok"],
  reason: "bbanana MCP와 Grok Imagine으로 영상을 생성합니다.",
};

function sameRule(left: RoutingRule, right: RoutingRule): boolean {
  return left.id === right.id && left.label === right.label && left.orchestrator === right.orchestrator
    && left.reason === right.reason && left.keywords.length === right.keywords.length
    && left.keywords.every((keyword, index) => keyword === right.keywords[index])
    && left.workers.length === right.workers.length
    && left.workers.every((worker, index) => worker === right.workers[index]);
}

export const defaultRoutingSettings: RoutingSettings = {
  planner: { agent: "claude", model: "opus", reasoningEffort: "high" },
  modelOptions: {
    claude: { models: ["opus", "sonnet", "haiku"], reasoningEfforts: ["medium", "high"], source: "preset", sourceDetail: "CLI가 모델 목록을 제공하지 않아 편집 가능한 기본값을 사용합니다." },
    codex: { models: [], reasoningEfforts: ["low", "medium", "high", "xhigh"], source: "preset", sourceDetail: "로컬 CLI에서 모델을 찾지 못하면 직접 입력할 수 있습니다." },
    grok: { models: currentGrokModels, reasoningEfforts: [], source: "preset", sourceDetail: "Grok의 편집 가능한 최신 모델 프리셋입니다." },
  },
  rules: [
    ...smartMediaRules,
    { id: "docs-review", label: "문서·디자인·리뷰", keywords: ["문서", "리뷰", "code review", "검토", "디자인 리뷰"], orchestrator: "claude", workers: ["codex"], reason: "문서 작성, 디자인 정리, 코드 리뷰는 Claude가 맡습니다." },
    { id: "frontend", label: "프론트엔드 UI", keywords: ["프론트", "ui", "ux", "디자인", "react", "css"], orchestrator: "claude", workers: ["codex"], reason: "화면 설계와 사용성 판단이 중심인 작업" },
    { id: "refactor", label: "대규모 리팩터·테스트", keywords: ["리팩터", "refactor", "테스트", "마이그레이션", "성능"], orchestrator: "codex", workers: ["claude"], reason: "코드 변경과 검증 비중이 큰 작업" },
    { id: "research", label: "빠른 조사", keywords: ["조사", "검색", "research", "찾아", "비교"], orchestrator: "grok", workers: ["claude"], reason: "빠른 정보 탐색이 중심인 작업" },
  ],
};

function cloneDefaults(): RoutingSettings { return structuredClone(defaultRoutingSettings); }

function cleanString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return value.trim();
}

function cleanAgent(value: unknown): AgentId {
  if (!agentIds.has(value as AgentId)) throw new Error("지원하지 않는 에이전트입니다.");
  return value as AgentId;
}

function cleanStringArray(value: unknown, label: string, max = 30): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} 목록이 올바르지 않습니다.`);
  return [...new Set(value.map((item) => item.trim()))];
}

function cleanAgentArray(value: unknown, label: string, max = 3): AgentId[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 목록이 올바르지 않습니다.`);
  return value.map(cleanAgent);
}

function cleanEffort(value: unknown): ReasoningEffort | undefined {
  if (value == null || value === "") return undefined;
  if (!["low", "medium", "high", "xhigh", "max"].includes(String(value))) throw new Error("추론 강도가 올바르지 않습니다.");
  return value as ReasoningEffort;
}

function isStaleGrokModel(model: string) {
  return model === "grok-code-fast-1" || /^grok-1(?:$|[._-])/.test(model);
}

export function validateRoutingSettings(value: unknown): RoutingSettings {
  if (!value || typeof value !== "object") throw new Error("라우팅 설정이 올바르지 않습니다.");
  const input = value as any;
  const plannerAgent = cleanAgent(input.planner?.agent);
  const result: RoutingSettings = { planner: { agent: plannerAgent }, modelOptions: {} as RoutingSettings["modelOptions"], rules: [] };
  if (input.planner?.model) result.planner.model = cleanString(input.planner.model, "플래너 모델", 200);
  const plannerEffort = cleanEffort(input.planner?.reasoningEffort);
  if (plannerEffort) result.planner.reasoningEffort = plannerEffort;
  for (const id of ["codex", "claude", "grok"] as const) {
    const option = input.modelOptions?.[id];
    const efforts = cleanStringArray(option?.reasoningEfforts, `${id} 추론 강도`, 5).map(cleanEffort) as ReasoningEffort[];
    const configuredModels = cleanStringArray(option?.models, `${id} 모델`);
    const models = id === "grok" ? configuredModels.filter((model) => !isStaleGrokModel(model)) : configuredModels;
    result.modelOptions[id] = {
      models: id === "grok" && !models.length && configuredModels.length ? [...currentGrokModels] : models, reasoningEfforts: efforts,
      source: option?.source === "cli" ? "cli" : "preset",
      sourceDetail: cleanString(option?.sourceDetail ?? "사용자 편집 모델 목록", "모델 출처", 500),
    };
  }
  if (!Array.isArray(input.rules) || input.rules.length > 50) throw new Error("라우팅 규칙 목록이 올바르지 않습니다.");
  result.rules = input.rules.map((rule: any) => {
    const orchestrator = cleanAgent(rule?.orchestrator);
    const workers = cleanAgentArray(rule?.workers ?? [], "워커");
    if (!workers.length) throw new Error("라우팅 규칙에는 작업자가 한 명 이상 필요합니다.");
    return {
      id: cleanString(rule?.id, "규칙 ID", 100), label: cleanString(rule?.label, "규칙 이름", 100),
      keywords: cleanStringArray(rule?.keywords, "규칙 키워드"), orchestrator, workers, reason: cleanString(rule?.reason, "규칙 이유"),
    };
  });
  if (new Set(result.rules.map((rule) => rule.id)).size !== result.rules.length) throw new Error("라우팅 규칙 ID는 중복될 수 없습니다.");
  return result;
}

function settingsPath(directory: string) { return resolve(directory, "routing-settings.json"); }

const modelIdPattern = /^[\p{L}\p{N}._:/-]{1,200}$/u;

function addModel(target: string[], value: unknown) {
  if (typeof value !== "string") return;
  const model = value.trim();
  if (modelIdPattern.test(model) && !target.includes(model) && target.length < 30) target.push(model);
}

async function boundedText(file: string, maxBytes = 1_000_000): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(file, "utf8");
  } catch { return undefined; }
}

async function jsonConfig(file: string): Promise<Record<string, any> | undefined> {
  const text = await boundedText(file);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

/** Reads only model identifiers from bounded, known local CLI configuration shapes. */
export async function discoverLocalModels(homeDirectory = homedir()): Promise<RoutingSettings> {
  const settings = cloneDefaults();
  const discovered: Record<AgentId, string[]> = { codex: [], claude: [], grok: [] };

  const codexConfig = await boundedText(resolve(homeDirectory, ".codex", "config.toml"), 256_000);
  if (codexConfig) addModel(discovered.codex, codexConfig.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]);
  const codexCache = await jsonConfig(resolve(homeDirectory, ".codex", "models_cache.json"));
  if (Array.isArray(codexCache?.models)) {
    for (const entry of codexCache.models.slice(0, 100)) addModel(discovered.codex, entry && typeof entry === "object" ? entry.slug : undefined);
  }

  const claude = await jsonConfig(resolve(homeDirectory, ".claude", "settings.json"));
  addModel(discovered.claude, claude?.model);
  addModel(discovered.claude, claude?.env?.ANTHROPIC_MODEL);

  for (const name of ["config.json", "settings.json"]) {
    const grok = await jsonConfig(resolve(homeDirectory, ".grok", name));
    addModel(discovered.grok, grok?.model);
    addModel(discovered.grok, grok?.env?.GROK_MODEL);
  }
  discovered.grok = discovered.grok.filter((model) => !isStaleGrokModel(model));

  for (const agent of ["codex", "claude", "grok"] as const) {
    if (!discovered[agent].length) continue;
    const preset = settings.modelOptions[agent].models;
    settings.modelOptions[agent].models = [...discovered[agent], ...preset.filter((model) => !discovered[agent].includes(model))].slice(0, 30);
    settings.modelOptions[agent].source = "cli";
    settings.modelOptions[agent].sourceDetail = "로컬 CLI 구성/캐시에서 발견한 모델 후보입니다. 계정에서 사용 가능한 전체 카탈로그를 보장하지 않습니다.";
  }
  if (settings.planner.agent === "claude" && discovered.claude[0]) settings.planner.model = discovered.claude[0];
  return settings;
}

function modelCommand(agent: AgentId): string {
  return ({
    codex: envVar("CODEX_BIN"),
    claude: envVar("CLAUDE_BIN"),
    grok: envVar("GROK_BIN"),
  })[agent] || agent;
}

const defaultModelRunner: ModelCommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 10_000,
      maxBuffer: 256_000,
      env: cliChildEnv(process.env, { CI: "1" }),
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (failure.stdout || failure.stderr) return { stdout: failure.stdout ?? "", stderr: failure.stderr };
    throw error;
  }
};

function output(result: ModelCommandResult): string {
  return stripVTControlCharacters(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).trim();
}

export function parseGrokModels(text: string): string[] {
  const models: string[] = [];
  for (const match of stripVTControlCharacters(text).matchAll(/^\s*[*-]\s+([\p{L}\p{N}._:/-]+)(?:\s+\(default\))?\s*$/gmu)) addModel(models, match[1]);
  return models;
}

function setAuth(option: ModelOptions, agent: AgentId, status: ModelOptions["authStatus"]) {
  const name = agent === "codex" ? "Codex" : agent === "claude" ? "Claude" : "Grok";
  const loginCommand = agent === "claude" ? "claude auth login" : `${agent} login`;
  option.authStatus = status;
  option.authDetail = status === "authenticated"
    ? `${name} 로그인됨`
    : status === "unauthenticated"
      ? `${name} 로그인 필요: 터미널에서 ${loginCommand}`
      : `${name} 로그인 상태를 확인할 수 없습니다.`;
}

function isAuthenticated(text: string) {
  if (/you are logged in/i.test(text)) return true;
  return !/not authenticated|not (?:logged|signed) in|unauthenticated/i.test(text)
    && /logged in|authenticated/i.test(text);
}

function isUnauthenticated(text: string) {
  return !/you are logged in/i.test(text)
    && /not authenticated|not (?:logged|signed) in|unauthenticated/i.test(text);
}

async function commandResult(runner: ModelCommandRunner, agent: AgentId, args: string[]): Promise<ModelCommandResult | undefined> {
  try { return await runner(modelCommand(agent), args); }
  catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof failure.stdout === "string" ? failure.stdout.slice(0, 256_000) : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr.slice(0, 256_000) : "";
    return stdout || stderr ? { stdout, stderr } : undefined;
  }
}

/** Refreshes model catalogs and cheap CLI authentication status without persisting derived values. */
export async function discoverCliModels(
  base: RoutingSettings,
  homeDirectory = homedir(),
  runner: ModelCommandRunner = defaultModelRunner,
  options: AuthDiscoveryOptions = {},
): Promise<RoutingSettings> {
  const settings = structuredClone(base);
  settings.modelOptions.grok.models = settings.modelOptions.grok.models.filter((model) => !isStaleGrokModel(model));
  if (!settings.modelOptions.grok.models.length) settings.modelOptions.grok.models = [...currentGrokModels];
  const local = await discoverLocalModels(homeDirectory);

  for (const agent of ["codex", "claude", "grok"] as const) {
    if (local.modelOptions[agent].source !== "cli") continue;
    const localModels = local.modelOptions[agent].models;
    settings.modelOptions[agent].models = [...localModels, ...settings.modelOptions[agent].models.filter((model) => !localModels.includes(model))].slice(0, 30);
    settings.modelOptions[agent].source = "cli";
    settings.modelOptions[agent].sourceDetail = local.modelOptions[agent].sourceDetail;
  }

  let [grokResult, codexResult, claudeResult] = await Promise.all([
    commandResult(runner, "grok", ["models"]),
    commandResult(runner, "codex", ["login", "status"]),
    commandResult(runner, "claude", ["auth", "status"]),
  ]);

  const grokUnauthenticated = grokResult ? isUnauthenticated(output(grokResult)) : false;
  const codexUnauthenticated = codexResult ? isUnauthenticated(output(codexResult)) : false;
  let claudeUnauthenticated = false;
  if (claudeResult) {
    try { claudeUnauthenticated = JSON.parse(claudeResult.stdout).loggedIn === false; }
    catch { claudeUnauthenticated = isUnauthenticated(output(claudeResult)); }
  }
  if (grokUnauthenticated || codexUnauthenticated || claudeUnauthenticated) {
    await (options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(5_000);
    const retried = await Promise.all([
      grokUnauthenticated ? commandResult(runner, "grok", ["models"]) : Promise.resolve(grokResult),
      codexUnauthenticated ? commandResult(runner, "codex", ["login", "status"]) : Promise.resolve(codexResult),
      claudeUnauthenticated ? commandResult(runner, "claude", ["auth", "status"]) : Promise.resolve(claudeResult),
    ]);
    [grokResult, codexResult, claudeResult] = retried;
  }

  if (grokResult) {
    const text = output(grokResult);
    if (isUnauthenticated(text)) {
      setAuth(settings.modelOptions.grok, "grok", "unauthenticated");
    } else {
      const models = parseGrokModels(text);
      if (models.length) {
        settings.modelOptions.grok.models = models;
        settings.modelOptions.grok.source = "cli";
        settings.modelOptions.grok.sourceDetail = "grok models 명령에서 현재 계정의 모델 목록을 발견했습니다.";
        setAuth(settings.modelOptions.grok, "grok", "authenticated");
      } else setAuth(settings.modelOptions.grok, "grok", isAuthenticated(text) ? "authenticated" : "unknown");
    }
  } else setAuth(settings.modelOptions.grok, "grok", "unknown");

  if (codexResult) {
    const text = output(codexResult);
    setAuth(settings.modelOptions.codex, "codex", isUnauthenticated(text) ? "unauthenticated" : isAuthenticated(text) ? "authenticated" : "unknown");
  } else setAuth(settings.modelOptions.codex, "codex", "unknown");

  if (claudeResult) {
    const text = output(claudeResult);
    let loggedIn: boolean | undefined;
    try { loggedIn = JSON.parse(claudeResult.stdout).loggedIn; } catch { /* Some Claude versions return plain text. */ }
    const loggedOut = loggedIn === false || isUnauthenticated(text);
    setAuth(settings.modelOptions.claude, "claude", loggedOut ? "unauthenticated"
      : loggedIn === true || isAuthenticated(text) ? "authenticated" : "unknown");
  } else setAuth(settings.modelOptions.claude, "claude", "unknown");

  return settings;
}

export async function loadRoutingSettings(directory = defaultDataDir, homeDirectory = homedir()): Promise<RoutingSettings> {
  try {
    const settings = validateRoutingSettings(JSON.parse(await readFile(settingsPath(directory), "utf8")));
    const legacyImageIndex = settings.rules.findIndex((rule) => sameRule(rule, legacyImageRule));
    if (legacyImageIndex >= 0) {
      const remaining = settings.rules.filter((rule, index) => index !== legacyImageIndex && !sameRule(rule, legacyVideoRule));
      const smartIds = new Set(smartMediaRules.map((rule) => rule.id));
      const replacements = smartMediaRules.map((fallback) => remaining.find((rule) => rule.id === fallback.id) ?? structuredClone(fallback));
      settings.rules = [...replacements, ...remaining.filter((rule) => !smartIds.has(rule.id))];
    }
    return settings;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return discoverLocalModels(homeDirectory);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`저장된 라우팅 설정을 읽을 수 없습니다: ${detail}`, { cause: error });
  }
}

export async function saveRoutingSettings(settings: RoutingSettings, directory = defaultDataDir): Promise<RoutingSettings> {
  const valid = validateRoutingSettings(settings);
  await mkdir(directory, { recursive: true });
  const file = settingsPath(directory);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return valid;
}

function matchedSkills(prompt: string, skills: SkillInfo[]): string[] {
  const text = stripPreviewAttachments(prompt).toLocaleLowerCase();
  const ignored = new Set(["the", "and", "for", "with", "from", "this", "that", "use", "user", "using", "into", "your", "agent", "skill"]);
  return skills.filter((skill) => {
    const terms = `${skill.name} ${skill.description}`.toLocaleLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((term) => term.length >= 3);
    return terms.some((term) => !ignored.has(term) && matchesTerm(text, term));
  }).slice(0, 8).map((skill) => skill.id);
}

function matchesTerm(text: string, term: string): boolean {
  if (!/^[a-z0-9._:/-]+$/i.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

function matchedRule(prompt: string, settings: RoutingSettings): RoutingRule | undefined {
  const lowered = stripPreviewAttachments(prompt).toLocaleLowerCase();
  return settings.rules.find((candidate) => candidate.keywords.some((keyword) => matchesTerm(lowered, keyword.toLocaleLowerCase())));
}

function choice(settings: RoutingSettings, agent: AgentId, reason: string, proposed: any = {}): AgentChoice {
  const options = settings.modelOptions[agent];
  const requestedModel = typeof proposed.model === "string" ? proposed.model : undefined;
  const requestedEffort = cleanEffort(proposed.reasoningEffort);
  const id = typeof proposed.id === "string" && proposed.id.trim() ? proposed.id.trim().slice(0, 100) : undefined;
  const label = typeof proposed.label === "string" && proposed.label.trim() ? proposed.label.trim().slice(0, 100) : undefined;
  return {
    ...(id ? { id } : {}), ...(label ? { label } : {}),
    agent, model: requestedModel && options.models.includes(requestedModel) ? requestedModel : agent === "grok" && options.models.includes("grok-4.7") ? "grok-4.7" : options.models[0],
    reasoningEffort: requestedEffort && options.reasoningEfforts.includes(requestedEffort) ? requestedEffort : options.reasoningEfforts[0],
    reason: typeof proposed.reason === "string" && proposed.reason.trim() ? proposed.reason.trim().slice(0, 500) : reason,
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("플래너가 JSON 추천을 반환하지 않았습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeRecommendation(raw: unknown, settings: RoutingSettings, skills: SkillInfo[], prompt: string, availableAgents?: AgentId[]): RouteRecommendation {
  if (!raw || typeof raw !== "object") throw new Error("플래너 추천 형식이 올바르지 않습니다.");
  const value = raw as any;
  const knownSkills = new Set(skills.map((skill) => skill.id));
  const plannedBy = value.planner
    ? choice(settings, cleanAgent(value.planner.agent), "플래너가 선택한 계획 전문 에이전트", value.planner)
    : choice(settings, settings.planner.agent, "요청 분류와 실행 계획에 적합한 기본 플래너", settings.planner);
  const rule = matchedRule(prompt, settings);
  const orchestratorAgent = rule?.orchestrator ?? defaultOrchestrator(availableAgents);
  const proposedWorkers = Array.isArray(value.workers) ? value.workers.slice(0, 3).map((worker: any) => choice(settings, cleanAgent(worker?.agent), "플래너가 선택한 작업자", worker)) : [];
  const workers = rule ? rule.workers.map((agent) => choice(settings, agent, `${rule.label} 규칙이 선택한 작업자`)) : proposedWorkers;
  if (!workers.length) {
    workers.push(choice(settings, orchestratorAgent, "실행 가능한 구성을 위해 추가한 기본 작업자"));
  }
  return {
    planner: plannedBy,
    orchestrator: choice(settings, orchestratorAgent, rule?.reason ?? "범용 작업에 적합한 기본 오케스트레이터"),
    workers,
    skills: [...new Set([...cleanStringArray(value.skills ?? [], "스킬", 20).filter((id) => knownSkills.has(id)), ...matchedSkills(prompt, skills)])].slice(0, 20),
    reason: rule ? `${rule.label} 규칙: ${rule.reason}` : cleanString(value.reason, "추천 이유", 1_000), source: "planner",
  };
}

function defaultOrchestrator(availableAgents: AgentId[] = ["claude", "codex", "grok"]): AgentId {
  const agent = (["claude", "codex", "grok"] as AgentId[]).find((id) => availableAgents.includes(id));
  if (!agent) throw new Error("사용할 수 있는 에이전트가 없습니다.");
  return agent;
}

function fallbackRecommendation(prompt: string, settings: RoutingSettings, skills: SkillInfo[], warning?: string, availableAgents?: AgentId[]): RouteRecommendation {
  const rule = matchedRule(prompt, settings);
  const available = availableAgents ?? (["codex", "claude", "grok"] as AgentId[]);
  const orchestrator = rule?.orchestrator ?? defaultOrchestrator(available);
  const workers = rule?.workers ?? [available.find((agent) => agent !== orchestrator) ?? orchestrator];
  return {
    planner: choice(settings, settings.planner.agent, "요청 분류와 실행 계획을 담당하는 설정된 플래너", settings.planner),
    orchestrator: choice(settings, orchestrator, rule?.reason ?? "범용 작업에 적합한 기본 오케스트레이터"),
    workers: workers.map((agent) => choice(settings, agent, `${rule?.label ?? "범용 작업"} 보조 작업자`)),
    skills: matchedSkills(prompt, skills), reason: rule ? `${rule.label} 규칙: ${rule.reason}` : "일치하는 규칙이 없어 기본 구성을 추천했습니다.",
    source: "fallback", ...(warning ? { warning } : {}),
  };
}

function assertAvailability(settings: RoutingSettings, prompt: string, availableAgents?: AgentId[]) {
  if (!availableAgents) return;
  const available = new Set(availableAgents);
  if (!available.size) throw new Error("실행하려면 사용할 수 있는 에이전트 CLI가 한 개 이상 필요합니다. 설정 후 다시 시도하세요.");
  if (!available.has(settings.planner.agent)) throw new Error(`설정된 라우터 ${settings.planner.agent} CLI를 사용할 수 없습니다. 설정에서 설치된 라우터를 선택하세요.`);
  const rule = matchedRule(prompt, settings);
  const missing = rule ? [rule.orchestrator, ...rule.workers].filter((agent) => !available.has(agent)) : [];
  if (missing.length) throw new Error(`${rule!.label} 규칙에 사용할 수 없는 에이전트(${[...new Set(missing)].join(", ")})가 있습니다. 라우팅 규칙을 수정하세요.`);
}

function recommendationIsAvailable(recommendation: RouteRecommendation, availableAgents?: AgentId[]): boolean {
  if (!availableAgents) return true;
  const available = new Set(availableAgents);
  return [recommendation.planner, recommendation.orchestrator, ...recommendation.workers].every((choice) => available.has(choice.agent));
}

function plannerPrompt(prompt: string, settings: RoutingSettings, skills: SkillInfo[]): string {
  return `당신은 Sinawi 라우터입니다. 도구를 사용하거나 작업을 실행하지 말고 사용자 요청을 분석해 JSON 하나만 반환하세요.\n` +
    `형식: {"planner":{"agent":"codex|claude|grok","model":"...","reasoningEffort":"low|medium|high|xhigh|max","reason":"계획 담당 이유"},"orchestrator":{동일 형식},"workers":[{"id":"worker-1","label":"Codex 1","agent":"codex|claude|grok","model":"...","reasoningEffort":"...","reason":"작업자 이유"}],"skills":["skill id"],"reason":"전체 이유 한 줄"}\n` +
    `일치하는 규칙이 없으면 Claude를 기본 오케스트레이터로 선택하세요. 이미지/영상 생성은 Grok이 오케스트레이션하고 Codex와 Grok을 워커로 선택하세요. 쇼츠/릴스/마케팅 영상은 marketing-shorts 스킬을 첨부하세요. 설정과 라우팅 규칙을 반드시 존중하세요. 목록에 있는 모델과 스킬만 선택하세요. 워커는 최대 3명이며 오케스트레이터와 같은 에이전트 또는 같은 에이전트의 여러 독립 워커를 선택할 수 있습니다. 각 워커에는 고유 id와 구분 가능한 label을 지정하세요.\n` +
    `설정: ${JSON.stringify(settings)}\n사용 가능한 스킬: ${JSON.stringify(skills.slice(0, 300).map(({ id, name, description }) => ({ id, name, description: description.slice(0, 500) })))}\n사용자 요청: ${prompt}`;
}

export class RoutingService {
  private discoveredModelOptions?: RoutingSettings["modelOptions"];
  private modelMutation = Promise.resolve();

  constructor(private options: { dataDir?: string; homeDir?: string; runner?: PlannerRunner; modelRunner?: ModelCommandRunner; authDiscovery?: AuthDiscoveryOptions; skillLoader?: (cwd?: string) => Promise<SkillInfo[]>; timeoutMs?: number } = {}) {}

  async loadSettings() {
    const settings = await loadRoutingSettings(this.options.dataDir, this.options.homeDir);
    if (this.discoveredModelOptions) settings.modelOptions = structuredClone(this.discoveredModelOptions);
    return settings;
  }

  async saveSettings(settings: unknown) {
    return this.withModelMutation(async () => {
      const previous = this.discoveredModelOptions;
      const saved = await saveRoutingSettings(validateRoutingSettings(settings), this.options.dataDir);
      for (const agent of ["codex", "claude", "grok"] as const) {
        if (!saved.modelOptions[agent].authStatus && previous?.[agent].authStatus) {
          saved.modelOptions[agent].authStatus = previous[agent].authStatus;
          saved.modelOptions[agent].authDetail = previous[agent].authDetail;
        }
      }
      this.discoveredModelOptions = structuredClone(saved.modelOptions);
      return saved;
    });
  }

  async refreshModels() {
    return this.withModelMutation(async () => {
      const settings = await loadRoutingSettings(this.options.dataDir, this.options.homeDir);
      const refreshed = await discoverCliModels(settings, this.options.homeDir, this.options.modelRunner, this.options.authDiscovery);
      this.discoveredModelOptions = structuredClone(refreshed.modelOptions);
      return refreshed;
    });
  }

  private async withModelMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.modelMutation;
    let release!: () => void;
    this.modelMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async recommend(prompt: string, cwd: string, explicitSkills: string[] = [], availableAgents?: AgentId[], usageContext?: RunCliOptions["usageContext"], allowedAgents?: AgentId[]): Promise<RouteRecommendation> {
    let settings = await this.loadSettings();
    const workspaceId = usageContext?.workspaceId ?? "personal";
    const loadEnabledSkills = async () => {
      const disabled = (await loadToolSettings(this.options.dataDir))[workspaceId].disabledSkills;
      return filterEnabledSkills(await (this.options.skillLoader ?? publicSkills)(cwd), disabled);
    };
    const media = mediaRouteRequired(prompt, settings.rules);
    if (usageContext?.workspaceId === "company" && mediaRouteRequired(prompt, settings.rules)) {
      throw new Error(companyMediaUnavailableMessage);
    }
    if (usageContext?.workspaceId === "company") {
      settings = { ...settings, rules: settings.rules.filter((rule) => !isMediaRule(rule.id)) };
    }
    if (media && (availableAgents && !availableAgents.includes("grok") || allowedAgents && !allowedAgents.includes("grok") || settings.modelOptions.grok.authStatus === "unauthenticated")) {
      throw new Error(mediaUnavailableMessage);
    }
    if ([...agentIds].some((id) => settings.modelOptions[id].authStatus === "unauthenticated")) {
      availableAgents = (availableAgents ?? [...agentIds]).filter((id) => settings.modelOptions[id].authStatus !== "unauthenticated");
    }
    if (allowedAgents) {
      const permitted = (availableAgents ?? [...agentIds]).filter((id) => allowedAgents.includes(id));
      if (!permitted.length) throw new Error("이 작업 공간에서 사용할 수 있는 에이전트가 없습니다.");
      settings = { ...settings, planner: permitted.includes(settings.planner.agent) ? settings.planner : { agent: permitted[0] },
        rules: settings.rules.filter((rule) => permitted.includes(rule.orchestrator)).map((rule) => ({ ...rule, workers: rule.workers.filter((id) => permitted.includes(id)) })).filter((rule) => rule.workers.length > 0) };
      availableAgents = permitted;
    }
    const available = availableAgents ? [...new Set(availableAgents)] : undefined;
    if (media) {
      const skills = await loadEnabledSkills();
      const configuredMediaRule = matchedRule(prompt, { ...settings, rules: settings.rules.filter((rule) => isMediaRule(rule.id)) });
      const reason = configuredMediaRule?.reason ?? "이미지·영상 생성은 bbanana MCP와 Grok Imagine을 사용합니다.";
      const mediaWorkers = (configuredMediaRule?.workers ?? ["codex", "grok"]).filter((agent) => !available || available.includes(agent));
      return withExplicitSkills({
        planner: choice(settings, "grok", "미디어 생성 도구를 지원하는 Grok으로 직접 분류했습니다."),
        orchestrator: choice(settings, "grok", reason),
        workers: mediaWorkers.map((agent) => choice(settings, agent, reason)),
        skills: [...new Set([...mediaSkills(prompt, skills), ...matchedSkills(prompt, skills)])],
        reason: configuredMediaRule ? `${configuredMediaRule.label} 규칙: ${reason}` : reason, source: "fallback",
      }, [...mediaSkills(prompt, skills), ...explicitSkills], skills);
    }
    assertAvailability(settings, prompt, available);
    const skills = await loadEnabledSkills();
    const fallback = (warning?: string) => fallbackRecommendation(prompt, settings, skills, warning, available);
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? 30_000);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("플래너 응답 시간이 초과되었습니다."));
      }, timeoutMs);
    });
    timer?.unref();
    try {
      const planner = choice(settings, settings.planner.agent, "설정된 라우팅 플래너", settings.planner);
      const invocation = Promise.resolve().then(() => (this.options.runner ?? runCli)({
        agent: planner.agent, model: planner.model, reasoningEffort: planner.reasoningEffort,
        cwd, prompt: plannerPrompt(prompt, settings, skills), readOnly: true,
        signal: controller.signal, onLine: () => undefined, usageContext,
      }));
      const result = await Promise.race([invocation, timeout]);
      if (result.exitCode !== 0) return withExplicitSkills(fallback(`플래너가 종료 코드 ${result.exitCode}로 끝나 규칙 기반 추천을 사용했습니다.`), explicitSkills, skills);
      const recommendation = normalizeRecommendation(extractJson(result.finalText), settings, skills, prompt, available);
      if (!recommendationIsAvailable(recommendation, available)) throw new Error("플래너가 설치되지 않은 에이전트를 추천했습니다.");
      return withExplicitSkills(recommendation, explicitSkills, skills);
    } catch (error) {
      const detail = controller.signal.aborted ? "플래너 응답 시간이 초과되었습니다." : error instanceof Error ? error.message : String(error);
      return withExplicitSkills(fallback(`${detail} 규칙 기반 추천을 사용했습니다.`), explicitSkills, skills);
    } finally { if (timer) clearTimeout(timer); }
  }
}

function withExplicitSkills(recommendation: RouteRecommendation, explicit: string[], skills: SkillInfo[]): RouteRecommendation {
  const known = new Set(skills.map((skill) => skill.id));
  recommendation.skills = [...new Set([...explicit.filter((id) => known.has(id)), ...recommendation.skills])].slice(0, 20);
  return recommendation;
}
