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
    const requestedId = rawRequestedId && workerIdPattern.test(rawRequestedId) ? rawRequestedId : undefined;
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
