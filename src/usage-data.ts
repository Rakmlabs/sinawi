import type { UsageRun } from "../server/usage";
import type { WorkspaceId } from "../server/types";

export type UsagePeriod = "today" | "7d" | "30d";
export type UsageWorkspace = WorkspaceId | "all";
export type UsageRunRecord = UsageRun;

type UsageTotals = {
  runs: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  durationMs: number;
  costUsd: number;
  hasTokens: boolean;
  hasInput: boolean;
  hasCached: boolean;
  hasOutput: boolean;
  hasReasoning: boolean;
  hasCost: boolean;
};
export type UsageRow = UsageTotals & { key: string; totalTokens?: number };

function calendarStart(now: Date, days: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

export function filterUsageRuns(runs: UsageRunRecord[], period: UsagePeriod, workspace: UsageWorkspace, now = new Date()): UsageRunRecord[] {
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const start = calendarStart(now, days);
  return runs.filter((run) => {
    const timestamp = Date.parse(run.timestamp);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= now.getTime() && (workspace === "all" || run.workspaceId === workspace);
  });
}

function totalsFor(runs: UsageRunRecord[]): UsageTotals {
  const totals: UsageTotals = { runs: runs.length, input: 0, cached: 0, output: 0, reasoning: 0, durationMs: 0, costUsd: 0, hasTokens: false, hasInput: false, hasCached: false, hasOutput: false, hasReasoning: false, hasCost: false };
  for (const run of runs) {
    totals.durationMs += Number.isFinite(run.durationMs) ? Math.max(0, run.durationMs) : 0;
    if (run.tokens) {
      if (run.tokens.input !== undefined) { totals.hasInput = true; totals.input += run.tokens.input; }
      if (run.tokens.cached !== undefined) { totals.hasCached = true; totals.cached += run.tokens.cached; }
      if (run.tokens.output !== undefined) { totals.hasOutput = true; totals.output += run.tokens.output; }
      if (run.tokens.reasoning !== undefined) { totals.hasReasoning = true; totals.reasoning += run.tokens.reasoning; }
      totals.hasTokens = totals.hasInput || totals.hasCached || totals.hasOutput || totals.hasReasoning;
    }
    if (typeof run.costUsd === "number" && Number.isFinite(run.costUsd)) {
      totals.hasCost = true;
      totals.costUsd += run.costUsd;
    }
  }
  return totals;
}

function groupUsage(runs: UsageRunRecord[], keyOf: (run: UsageRunRecord) => string): UsageRow[] {
  const groups = new Map<string, UsageRunRecord[]>();
  for (const run of runs) {
    const key = keyOf(run) || "CLI 기본 모델";
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups].map(([key, values]) => {
    const totals = totalsFor(values);
    const hasTotalTokens = totals.hasInput || totals.hasOutput;
    return { key, ...totals, totalTokens: hasTotalTokens ? totals.input + totals.output : undefined };
  }).sort((left, right) => (right.totalTokens ?? -1) - (left.totalTokens ?? -1) || right.runs - left.runs || left.key.localeCompare(right.key));
}

export function aggregateUsage(runs: UsageRunRecord[]) {
  return {
    totals: totalsFor(runs),
    byModel: groupUsage(runs, (run) => run.model),
    byAgent: groupUsage(runs, (run) => run.agent),
  };
}

export function usageBarWidth(totalTokens: number | undefined, maximum: number): number {
  if (!totalTokens || maximum <= 0) return 0;
  return Math.max(3, totalTokens / maximum * 100);
}
