import { runCli } from "./cli.js";
import type { RoutingRule, RoutingSettings } from "./routing.js";
import type { AgentId, WorkspaceId } from "./types.js";
import type { UsageContext } from "./usage.js";
import { isMediaRule, mediaGenerationRequired, mediaRouteRequired, stripPreviewAttachments } from "./media-routing.js";

export interface AutoSwitchRecommendation {
  agent: AgentId;
  workers: AgentId[];
  confidence: number;
  reason: string;
}

interface SignalGroup {
  agent: AgentId;
  label: string;
  patterns: RegExp[];
  workers: AgentId[];
}

const builtInSignals: SignalGroup[] = [
  {
    agent: "claude",
    label: "기획·설계",
    patterns: [/기획/u, /설계/u, /아키텍처/u, /architecture/iu, /\bplan(?:ning)?\b/iu, /\bdesign(?:ing)?\b/iu],
    workers: ["codex"],
  },
  {
    agent: "codex",
    label: "코딩·수정",
    patterns: [/구현/u, /코딩/u, /수정/u, /고쳐/u, /버그/u, /리팩터/u, /\bimplement(?:ation)?\b/iu, /\bfix(?:es|ed|ing)?\b/iu, /\brefactor(?:ing)?\b/iu, /\bdebug(?:ging)?\b/iu],
    workers: ["claude"],
  },
  {
    agent: "grok",
    label: "리서치",
    patterns: [/리서치/u, /조사/u, /검색/u, /찾아/u, /비교/u, /\bresearch\b/iu, /\binvestigat(?:e|ion)\b/iu, /\bcompare\b/iu],
    workers: ["claude"],
  },
];

function keywordPattern(keyword: string): RegExp | undefined {
  const value = keyword.trim();
  if (!value) return;
  const regex = value.match(/^\/(.+)\/([dgimsuvy]*)$/u);
  if (!regex) return;
  try { return new RegExp(regex[1], regex[2].replace(/[gy]/gu, "")); }
  catch { return; }
}

const weakLiterals = new Set(["ui", "ux", "css", "react", "code", "test", "design", "compare"]);

function keywordScore(input: string, keyword: string): number {
  const prompt = stripPreviewAttachments(input);
  const pattern = keywordPattern(keyword);
  if (pattern) return pattern.test(prompt) ? 1 : 0;
  // A malformed slash-delimited expression is ignored instead of becoming a
  // surprising literal match.
  if (keyword.trim().startsWith("/")) return 0;
  const literal = keyword.trim().toLocaleLowerCase();
  if (!literal) return 0;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = /^[a-z0-9 ]+$/i.test(literal)
    ? new RegExp(`\\b${escaped}\\b`, "i").test(prompt)
    : prompt.toLocaleLowerCase().includes(literal);
  if (!matches) return 0;
  return weakLiterals.has(literal) ? 0.5 : 1;
}

/** Deterministic, side-effect-free first pass used before any CLI classifier. */
export function classifyTask(prompt: string, rules: RoutingRule[], workspaceId: WorkspaceId = "personal"): AutoSwitchRecommendation | undefined {
  const mediaRoute = mediaRouteRequired(prompt, rules);
  if (workspaceId === "company" && mediaRoute) return;
  const mediaRule = mediaRoute ? rules.find((rule) => isMediaRule(rule.id) && rule.keywords.some((keyword) => keywordScore(prompt, keyword) > 0)) : undefined;
  if (mediaRule) {
    return {
      agent: mediaRule.orchestrator,
      workers: [...mediaRule.workers],
      confidence: 1,
      reason: `${mediaRule.label} 규칙: ${mediaRule.reason}`,
    };
  }
  if (mediaRoute && mediaGenerationRequired(prompt)) {
    return {
      agent: "grok",
      workers: ["codex", "grok"],
      confidence: 1,
      reason: "이미지·영상 생성은 Grok Build의 미디어 도구가 필요합니다.",
    };
  }
  const custom = (mediaRoute ? rules : rules.filter((rule) => !isMediaRule(rule.id)))
    .map((rule) => ({ rule, score: rule.keywords.reduce((score, keyword) => score + keywordScore(prompt, keyword), 0) }))
    .filter(({ score }) => score > 0);

  if (custom.length) {
    const byAgent = new Map<AgentId, number>();
    for (const { rule, score } of custom) byAgent.set(rule.orchestrator, (byAgent.get(rule.orchestrator) ?? 0) + score);
    const ranked = [...byAgent].sort((left, right) => right[1] - left[1]);
    if (!ranked[0] || ranked[0][1] < 1 || ranked[0][1] === ranked[1]?.[1]) return;
    const [agent, score] = ranked[0];
    const strongest = custom
      .filter(({ rule }) => rule.orchestrator === agent)
      .sort((left, right) => right.score - left.score)[0]!;
    return {
      agent,
      workers: [...strongest.rule.workers],
      confidence: score > 1 ? 0.98 : 0.95,
      reason: `${strongest.rule.label} 규칙: ${strongest.rule.reason}`,
    };
  }

  const matched = builtInSignals
    .map((group) => ({ group, score: group.patterns.filter((pattern) => pattern.test(prompt)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  // Mixed task categories are intentionally delegated to the cheap classifier;
  // a keyword count alone is not enough to call one intent decisively primary.
  if (!matched[0] || matched.length > 1) return;
  const { group, score } = matched[0];
  return {
    agent: group.agent,
    workers: group.workers,
    confidence: score > 1 ? 0.94 : 0.9,
    reason: `${group.label} 표현이 명확하게 감지되었습니다.`,
  };
}

function hasClassificationSignal(prompt: string, rules: RoutingRule[]): boolean {
  if (rules.some((rule) => rule.keywords.some((keyword) => keywordScore(prompt, keyword) > 0))) return true;
  return builtInSignals.some((group) => group.patterns.some((pattern) => pattern.test(prompt)));
}

function authenticated(agent: AgentId, settings: RoutingSettings, available: Set<AgentId>): boolean {
  return available.has(agent) && settings.modelOptions[agent].authStatus !== "unauthenticated";
}

function fallbackWorkers(agent: AgentId, settings: RoutingSettings, available: Set<AgentId>): AgentId[] {
  const candidates = (["claude", "codex", "grok"] as AgentId[]).filter((candidate) => candidate !== agent);
  candidates.push(agent);
  return candidates
    .filter((candidate) => authenticated(candidate, settings, available))
    .slice(0, 1);
}

function parsePlannerResult(text: string): Omit<AutoSwitchRecommendation, "workers"> | undefined {
  let value: unknown;
  try { value = JSON.parse(text.trim()); }
  catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["agent", "confidence", "reason"].includes(key))) return;
  if (!["codex", "claude", "grok"].includes(String(record.agent))) return;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0.85 || record.confidence > 1) return;
  if (typeof record.reason !== "string" || !record.reason.trim() || record.reason.length > 500) return;
  return { agent: record.agent as AgentId, confidence: record.confidence, reason: record.reason.trim() };
}

export async function recommendAutoSwitch(
  prompt: string,
  cwd: string,
  settings: RoutingSettings,
  availableAgents: AgentId[],
  runner: typeof runCli = runCli,
  signal?: AbortSignal,
  usageContext?: UsageContext,
  timeoutMs = 3_000,
): Promise<AutoSwitchRecommendation | undefined> {
  const available = new Set(availableAgents);
  const workspaceId = usageContext?.workspaceId ?? "personal";
  if (workspaceId === "company" && mediaRouteRequired(prompt, settings.rules)) return;
  const routingRules = workspaceId === "company" ? settings.rules.filter((rule) => !isMediaRule(rule.id)) : settings.rules;
  const direct = classifyTask(prompt, routingRules, workspaceId);
  if (direct) {
    if (!authenticated(direct.agent, settings, available)) return;
    const workers = direct.workers.filter((worker) => authenticated(worker, settings, available));
    const usableWorkers = workers.length ? workers : fallbackWorkers(direct.agent, settings, available);
    return usableWorkers.length ? { ...direct, workers: usableWorkers } : undefined;
  }

  if (mediaGenerationRequired(prompt)) return;
  if (!hasClassificationSignal(prompt, routingRules)) {
    const agent = (["claude", "codex", "grok"] as AgentId[]).find((candidate) => authenticated(candidate, settings, available));
    if (!agent) return;
    const workers = fallbackWorkers(agent, settings, available);
    return workers.length ? {
      agent,
      workers,
      confidence: 0.9,
      reason: agent === "claude" ? "일치하는 규칙이 없어 기본 오케스트레이터 Claude를 추천합니다." : "Claude를 사용할 수 없어 기본 순서에 따라 대체 오케스트레이터를 추천합니다.",
    } : undefined;
  }

  const configuredPlanner = settings.planner.agent;
  const planner = authenticated(configuredPlanner, settings, available)
    ? configuredPlanner
    : availableAgents.find((agent) => authenticated(agent, settings, available));
  if (signal?.aborted || !planner) return;
  const controller = new AbortController();
  let resolveAbort!: (value: undefined) => void;
  const aborted = new Promise<undefined>((resolve) => { resolveAbort = resolve; });
  const abort = () => { controller.abort(); resolveAbort(undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined); }, Math.max(1, timeoutMs));
    timer.unref();
  });
  const invocation = Promise.resolve().then(() => runner({
    agent: planner,
    model: planner === "claude" ? "haiku" : planner === configuredPlanner ? settings.planner.model : undefined,
    reasoningEffort: planner === "claude" ? undefined : "low",
    cwd,
    readOnly: true,
    signal: controller.signal,
    usageContext,
    onLine: () => undefined,
    prompt: "사용자 요청의 주 작업에 가장 적합한 오케스트레이터를 짧게 분류하세요. 도구를 쓰지 말고 JSON만 반환하세요. " +
      '형식: {"agent":"codex|claude|grok","confidence":0.0,"reason":"한 줄 이유"}. ' +
      `허용된 에이전트: ${availableAgents.join(", ")}. 이 목록 안에서만 선택하세요. ` +
      "기획·설계는 claude, 코딩·수정은 codex, 리서치는 grok입니다. 애매하면 confidence를 낮추세요.\n\n사용자 요청:\n" + prompt,
  })).then((result) => {
    if (result.exitCode !== 0 || controller.signal.aborted) return undefined;
    const parsed = parsePlannerResult(result.finalText);
    if (!parsed || !authenticated(parsed.agent, settings, available)) return undefined;
    const workers = fallbackWorkers(parsed.agent, settings, available);
    return workers.length ? { ...parsed, workers } : undefined;
  }, () => undefined);

  try { return await Promise.race([invocation, timeout, aborted]); }
  finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
