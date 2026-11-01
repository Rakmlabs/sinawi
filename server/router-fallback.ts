import type { RunCliOptions } from "./cli.js";
import type { ProviderQuota } from "./quota.js";
import { equivalentFallbackModel, exhaustionFromQuota, isQuotaExhaustion, selectQuotaFallback } from "./quota-fallback.js";
import type { PlannerRunner } from "./routing.js";
import type { AgentId, WorkspaceId } from "./types.js";

export interface RouterFallbackContext {
  enabled: boolean;
  threshold: number;
  allowedAgents: AgentId[];
  authenticatedAgents: AgentId[];
  quotas: ProviderQuota[];
  order?: Partial<Record<AgentId, AgentId[]>>;
}

export type RouterFallbackResolver = (workspaceId: WorkspaceId) => RouterFallbackContext | Promise<RouterFallbackContext>;

const names: Record<AgentId, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };

function handoffPrompt(options: RunCliOptions, fallback: AgentId, evidence: string): string {
  const summary = evidence.replace(/\s+/gu, " ").trim().slice(-4_000);
  return `${options.prompt}\n\n[자동 한도 전환 인계]\n${names[options.agent]} 한도 소진으로 ${names[fallback]}가 같은 라우팅 작업을 이어받습니다.` +
    `${summary ? `\n이전 실행 로그 요약: ${summary}` : ""}\n원래 요청과 출력 형식을 그대로 지켜 작업을 완료하세요.`;
}

/** Adds one quota-aware retry to read-only router/planner CLI calls. */
export function createQuotaFallbackRunner(runner: PlannerRunner, resolveContext: RouterFallbackResolver): PlannerRunner {
  return async (options) => {
    const workspaceId = options.usageContext?.workspaceId ?? "personal";
    let context: RouterFallbackContext;
    try { context = await resolveContext(workspaceId); }
    catch {
      options.onLine({ type: "status", text: "한도 자동 전환 정보를 불러오지 못해 현재 에이전트로 계속합니다." });
      return runner(options);
    }
    if (!context.enabled || options.signal?.aborted) return runner(options);

    const pick = () => selectQuotaFallback(
      options.agent,
      context.allowedAgents,
      context.authenticatedAgents,
      context.quotas,
      context.order,
      workspaceId,
      context.threshold,
    );
    const runFallback = (fallback: AgentId, evidence: string) => {
      const tier = equivalentFallbackModel(options.agent, fallback, options.model, options.reasoningEffort);
      return runner({
        ...options,
        agent: fallback,
        model: tier.model,
        reasoningEffort: tier.reasoningEffort,
        resumeSessionId: undefined,
        prompt: handoffPrompt(options, fallback, evidence),
      });
    };

    const known = exhaustionFromQuota(context.quotas.find((quota) => quota.agent === options.agent), context.threshold);
    if (known.exhausted) {
      const fallback = pick();
      if (fallback) return runFallback(fallback, `남은 한도 ${known.remainingPercent ?? 0}%`);
    }

    const log: string[] = [];
    let quotaError = false;
    const trackedOptions: RunCliOptions = {
      ...options,
      onLine: (line) => {
        log.push(line.text);
        if (log.length > 40) log.shift();
        if (line.type === "error" && isQuotaExhaustion(line.text)) quotaError = true;
        options.onLine(line);
      },
    };
    try {
      const result = await runner(trackedOptions);
      const evidence = [...log, result.finalText].filter(Boolean).join("\n");
      if (!options.signal?.aborted && (quotaError || result.exitCode !== 0 && isQuotaExhaustion(evidence))) {
        const fallback = pick();
        if (fallback) return runFallback(fallback, evidence);
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted || !isQuotaExhaustion(`${error instanceof Error ? error.message : String(error)}\n${log.join("\n")}`)) throw error;
      const fallback = pick();
      if (!fallback) throw error;
      return runFallback(fallback, `${error instanceof Error ? error.message : String(error)}\n${log.join("\n")}`);
    }
  };
}
