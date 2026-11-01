import { resolve } from "node:path";
import { isArray, readJsonFile, writeJsonFile } from "./json-file.js";
import type { AgentId, WorkspaceId } from "./types.js";
import { defaultDataDir } from "./runtime.js";

export type UsageRole = "orchestrator" | "worker" | "planner" | "router" | "status";
export type UsageStatus = "completed" | "failed" | "aborted";

export interface UsageTokens {
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
}

export interface UsageRun {
  id: string;
  agent: AgentId;
  model: string;
  workspaceId: WorkspaceId;
  sessionId: string;
  role: UsageRole;
  tokens?: UsageTokens;
  costUsd?: number;
  durationMs: number;
  status: UsageStatus;
  timestamp: string;
  planLimits?: Record<string, unknown>;
}

export interface CliUsageSnapshot {
  tokens?: UsageTokens;
  costUsd?: number;
  model?: string;
  planLimits?: Record<string, unknown>;
}

export interface UsageContext {
  workspaceId: WorkspaceId;
  sessionId: string;
  role: UsageRole;
  dataDir?: string;
}

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function number(...values: unknown[]): number | undefined {
  const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
  return value as number | undefined;
}

function modelFrom(data: Record<string, any>, usage: Record<string, any>): string | undefined {
  const explicit = data.model ?? data.model_id ?? data.modelId ?? data.primaryModelId ?? usage.model ?? usage.modelId;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const modelUsage = object(data.modelUsage) ?? object(data.modelUsages) ?? object(data.model_usage)
    ?? object(usage.modelUsage) ?? object(usage.modelUsages) ?? object(usage.model_usage);
  const models = modelUsage ? Object.keys(modelUsage) : [];
  return models.length === 1 ? models[0] : undefined;
}

/** Extracts only usage values actually reported by the CLI's machine-readable stream. */
export function parseCliUsage(agent: AgentId, rawLine: string): CliUsageSnapshot | undefined {
  let data: Record<string, any> | undefined;
  try { data = object(JSON.parse(rawLine)); } catch { return; }
  if (!data) return;
  const planLimits = object(data.rate_limits) ?? object(data.rateLimits) ?? object(data.plan_limits) ?? object(data.planLimits);
  const reportedModel = modelFrom(data, object(data.usage) ?? {});
  const reportedCostUsd = agent === "claude" ? number(data.total_cost_usd, data.totalCostUsd, data.usage?.total_cost_usd) : undefined;
  if (agent === "codex" && data.type !== "turn.completed" && !planLimits && !reportedModel) return;
  if (agent === "claude" && data.type !== "result" && !planLimits && !reportedModel) return;

  const update = object(data.params?.update) ?? object(data.update);
  const standaloneGrokUsage = agent === "grok" && [data.inputTokens, data.outputTokens, data.cacheReadInputTokens, data.reasoningTokens]
    .some((value) => typeof value === "number") ? data : undefined;
  const usage = object(data.usage) ?? object(update?.usage) ?? object(data.promptUsage) ?? standaloneGrokUsage;
  if (!usage && !planLimits && reportedCostUsd === undefined && !reportedModel) return;

  const tokens: UsageTokens = {};
  const input = number(usage?.input_tokens, usage?.inputTokens);
  const cached = number(usage?.cached_input_tokens, usage?.cache_read_input_tokens, usage?.cacheReadInputTokens, usage?.cachedReadTokens);
  const output = number(usage?.output_tokens, usage?.outputTokens);
  const reasoning = number(usage?.reasoning_output_tokens, usage?.reasoning_tokens, usage?.reasoningTokens, usage?.thoughtTokens);
  if (input !== undefined) tokens.input = input;
  if (cached !== undefined) tokens.cached = cached;
  if (output !== undefined) tokens.output = output;
  if (reasoning !== undefined) tokens.reasoning = reasoning;

  const snapshot: CliUsageSnapshot = {};
  if (Object.keys(tokens).length) snapshot.tokens = tokens;
  if (reportedCostUsd !== undefined) snapshot.costUsd = reportedCostUsd;
  if (reportedModel) snapshot.model = reportedModel;
  if (planLimits) snapshot.planLimits = structuredClone(planLimits);
  return Object.keys(snapshot).length ? snapshot : undefined;
}

const queues = new Map<string, Promise<void>>();

async function readUsage(directory: string): Promise<UsageRun[]> {
  return (await readJsonFile(resolve(directory, "usage.json"), isArray) as UsageRun[] | undefined) ?? [];
}

export function loadUsage(directory = defaultDataDir): Promise<UsageRun[]> {
  return (queues.get(directory) ?? Promise.resolve()).then(() => readUsage(directory));
}

export function appendUsage(record: UsageRun, directory = defaultDataDir): Promise<void> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const records = await readUsage(directory);
    records.push(structuredClone(record));
    await writeJsonFile(resolve(directory, "usage.json"), records, 2);
  });
  queues.set(directory, operation.catch(() => undefined));
  return operation;
}
