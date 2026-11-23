import type { AgentId, AgentSelection } from "./types.js";

const names: Record<AgentId, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const workerIdPattern = /^[A-Za-z0-9_.-]{1,100}$/;

export function normalizeWorkerConfigs(workers: AgentId[], configs: AgentSelection[] = []): AgentSelection[] {
  const totals = new Map<AgentId, number>();
  for (const agent of workers) totals.set(agent, (totals.get(agent) ?? 0) + 1);
  const occurrences = new Map<AgentId, number>();
  const unused = new Set(configs.map((_, index) => index));
  const usedIds = new Set<string>();
  const reservedIds = new Set(configs.flatMap((config) => {
    const id = config.id?.trim();
    return id && workerIdPattern.test(id) ? [id] : [];
  }));
  const usedLabels = new Set<string>();
  const reservedLabels = new Set(configs.flatMap((config) => {
    const label = config.label?.trim();
    return label && label !== names[config.agent] ? [label] : [];
  }));

  return workers.map((agent, position) => {
    const ordinal = (occurrences.get(agent) ?? 0) + 1;
    occurrences.set(agent, ordinal);
    let configIndex = unused.has(position) && configs[position]?.agent === agent ? position : configs.findIndex((config, index) => unused.has(index) && config.agent === agent);
    const config = configIndex >= 0 ? configs[configIndex] : undefined;
    if (configIndex >= 0) unused.delete(configIndex);
    const fallbackId = totals.get(agent) === 1 ? agent : `${agent}-${ordinal}`;
    const rawRequestedId = config?.id?.trim();
    // An id that names another CLI ("grok" on a Claude worker) reads as that CLI to the lead: never kept.
    const requestedId = rawRequestedId && workerIdPattern.test(rawRequestedId) && !namesOtherAgent(rawRequestedId, agent) ? rawRequestedId : undefined;
    const acceptedRequestedId = requestedId && !usedIds.has(requestedId);
    let id = acceptedRequestedId ? requestedId : fallbackId;
    if (!acceptedRequestedId) {
      let suffix = ordinal;
      while (usedIds.has(id) || reservedIds.has(id)) id = `${agent}-${++suffix}`;
    }
    usedIds.add(id);
    const configuredLabel = config?.label?.trim();
    const keepConfiguredLabel = configuredLabel && !(totals.get(agent)! > 1 && configuredLabel === names[agent]) && !usedLabels.has(configuredLabel);
    let label = keepConfiguredLabel ? configuredLabel : totals.get(agent) === 1 ? names[agent] : `${names[agent]} ${ordinal}`;
    if (!keepConfiguredLabel && totals.get(agent)! > 1) {
      let suffix = 1;
      while (usedLabels.has(label) || reservedLabels.has(label)) label = `${names[agent]} ${suffix++}`;
    }
    usedLabels.add(label);
    return { ...config, id, label, agent };
  });
}

export function workerLabel(worker: AgentSelection): string {
  return worker.label || names[worker.agent];
}

const isAgentName = (id: string): id is AgentId => Object.hasOwn(names, id);
/** `id` is "codex", "claude" or "grok" but the worker runs another CLI. */
export function namesOtherAgent(id: string | undefined, agent: AgentId): boolean {
  return Boolean(id && isAgentName(id) && id !== agent);
}

/**
 * Renames worker ids that name another CLI (left by changing a worker's CLI in versions before 1.7.2:
 * `{agent: "claude", id: "grok"}`). Returns the new configs and old id → new id; nothing else changes.
 */
export function renameAgentNamedWorkers(configs: readonly AgentSelection[] | undefined): { configs: AgentSelection[]; renamed: Map<string, string> } {
  const list = [...(configs ?? [])];
  const renamed = new Map<string, string>();
  if (!list.some((config) => namesOtherAgent(config.id, config.agent))) return { configs: list, renamed };
  const used = new Set(list.flatMap((config) => config.id && !namesOtherAgent(config.id, config.agent) ? [config.id] : []));
  return {
    renamed,
    configs: list.map((config) => {
      if (!config.id || !namesOtherAgent(config.id, config.agent)) return config;
      let id: string = config.agent;
      for (let n = 2; used.has(id); n++) id = `${config.agent}-${n}`;
      used.add(id);
      renamed.set(config.id, id);
      return { ...config, id };
    }),
  };
}

/** Minimal shape of a chat for renameSessionWorkers (server/types.ts Session). */
interface WorkerRefs {
  workerConfigs?: AgentSelection[];
  workerSessionIds?: Record<string, string>;
  workerSessionOrigins?: Record<string, unknown>;
  worktrees?: Array<{ workerId?: string }>;
  pendingInstructions?: Array<{ targetWorkerId?: string }>;
  events?: Array<{ workerId?: string; metadata?: { targetWorkerId?: string; previousConfig?: { workerConfigs?: AgentSelection[] } } }>;
}

/**
 * The same rename for a chat, with everything that points at a worker by id (its CLI conversation,
 * worktree, queued instructions and its lines in the chat), so the worker keeps its history.
 * True when something changed.
 */
export function renameSessionWorkers(session: WorkerRefs): boolean {
  const { configs, renamed } = renameAgentNamedWorkers(session.workerConfigs);
  if (!renamed.size) return false;
  const to = (id: string | undefined) => (id !== undefined && renamed.get(id)) || id;
  const rekey = <T>(record: Record<string, T> | undefined) => record && Object.fromEntries(Object.entries(record).map(([key, value]) => [to(key)!, value]));
  session.workerConfigs = configs;
  if (session.workerSessionIds) session.workerSessionIds = rekey(session.workerSessionIds);
  if (session.workerSessionOrigins) session.workerSessionOrigins = rekey(session.workerSessionOrigins);
  for (const worktree of session.worktrees ?? []) if (worktree.workerId) worktree.workerId = to(worktree.workerId);
  for (const item of session.pendingInstructions ?? []) if (item.targetWorkerId) item.targetWorkerId = to(item.targetWorkerId);
  for (const event of session.events ?? []) {
    if (event.workerId) event.workerId = to(event.workerId);
    if (event.metadata?.targetWorkerId) event.metadata.targetWorkerId = to(event.metadata.targetWorkerId);
    const previous = event.metadata?.previousConfig;
    if (previous?.workerConfigs) previous.workerConfigs = previous.workerConfigs.map((config) => config.id && renamed.has(config.id) && namesOtherAgent(config.id, config.agent) ? { ...config, id: renamed.get(config.id) } : config);
  }
  return true;
}
