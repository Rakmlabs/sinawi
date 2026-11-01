import { allowedAgentsForWorkspace } from "../server/workspace-policy";
import type { ProviderQuota } from "../server/quota";
import type { AgentId, Group, Session, WorkspaceId, WorkspaceState } from "../server/types";
import { remainingQuota } from "./quota-data";

export function inWorkspace<T extends { workspaceId?: WorkspaceId }>(items: T[], workspaceId: WorkspaceId): T[] {
  return items.filter((item) => (item.workspaceId ?? "personal") === workspaceId);
}

type WorkspaceKey = { key: string; isComposing?: boolean; keyCode?: number; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
export function workspaceShortcut(event: WorkspaceKey): WorkspaceId | undefined {
  if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return event.key === "F1" ? "personal" : event.key === "F2" ? "company" : undefined;
}

export function createWorkspaceSaver(request: (body: unknown) => Promise<unknown>) {
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  return (state: WorkspaceState, immediate = false): Promise<void> => {
    const body = structuredClone({ currentWorkspaceId: state.currentWorkspaceId, defaultsByWorkspace: state.defaults });
    if (immediate) {
      generation += 1;
      return request(body).then(() => undefined);
    }
    const scheduledGeneration = generation;
    const operation = queue.then(async () => {
      if (scheduledGeneration === generation) await request(body);
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
}

export function searchWorkspace(sessions: Session[], groups: Group[], workspaceId: WorkspaceId, query: string) {
  const scopedSessions = inWorkspace(sessions, workspaceId);
  const scopedGroups = inWorkspace(groups, workspaceId);
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { sessions: scopedSessions, groups: scopedGroups };
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  const matchedGroupIds = new Set(scopedGroups.filter((group) => matches(group.name)).map((group) => group.id));
  const matchedSessions = scopedSessions.filter((session) =>
    matches(session.title) || matches(session.cwd) ||
    (session.groupId && matchedGroupIds.has(session.groupId)) ||
    session.events.some((event) => event.type === "message" && matches(event.text)),
  );
  const visibleGroupIds = new Set([...matchedGroupIds, ...matchedSessions.map((session) => session.groupId)]);
  return { sessions: matchedSessions, groups: scopedGroups.filter((group) => visibleGroupIds.has(group.id)) };
}

/** Drop stale selections and model settings when a workspace prohibits their agent. */
export function workspaceTeamDefaults(workspaceId: WorkspaceId, defaults: import("../server/types").WorkspaceDefaults) {
  const allowed = allowedAgentsForWorkspace(workspaceId, defaults.allowedAgents);
  const preferredOrchestrator = (["claude", "codex", "grok"] as const).find((id) => allowed.includes(id));
  const agent = defaults.agent && allowed.includes(defaults.agent) ? defaults.agent : preferredOrchestrator ?? (workspaceId === "company" ? "claude" : "codex");
  const isSavedAgent = agent === defaults.agent;
  const workers = (defaults.workers ?? []).filter((id) => allowed.includes(id));
  return {
    agent,
    workers: workers.length ? workers : [...allowed.filter((id) => id !== agent), ...allowed.filter((id) => id === agent)].slice(0, 1),
    model: isSavedAgent ? defaults.model : agent === "grok" ? "grok-4.7" : undefined,
    reasoningEffort: isSavedAgent ? defaults.reasoningEffort : undefined,
    workerConfigs: (defaults.workerConfigs ?? []).filter((config) => allowed.includes(config.agent)),
  };
}

export function automaticTeamDefaults(
  workspaceId: WorkspaceId,
  agents: AgentId[],
  quotas: ProviderQuota[],
  quotaFallback = true,
  quotaThreshold = 3,
  now = Date.now(),
  authStatuses: Partial<Record<AgentId, "authenticated" | "unauthenticated" | "unknown">> = {},
) {
  const preferred = (["claude", "codex", "grok"] as const)
    .filter((agent) => agents.includes(agent));
  const authenticated = preferred.filter((agent) => authStatuses[agent] !== "unauthenticated");
  const candidates = authenticated.length ? authenticated : preferred;
  const eligible = quotaFallback ? candidates.filter((agent) => {
    const remaining = remainingQuota(quotas.find((provider) => provider.agent === agent), now);
    return remaining === undefined || remaining > quotaThreshold;
  }) : candidates;
  return workspaceTeamDefaults(workspaceId, { allowedAgents: eligible.length ? eligible : candidates });
}
