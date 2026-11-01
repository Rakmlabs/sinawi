import { allowedAgentsForWorkspace } from "../server/workspace-policy";
import type { ProviderQuota } from "../server/quota";
import type { AgentId, Group, Session, WorkspaceId, WorkspaceState } from "../server/types";
import { remainingQuota } from "./quota-data";
import { t } from "./i18n";

/** A user-defined workspace as listed by `GET /api/workspaces`. */
export type WorkspaceSummary = { id: WorkspaceId; name: string };
/** Workspace state plus the ordered, user-defined workspace list. */
export type WorkspacesState = WorkspaceState & { workspaces: WorkspaceSummary[]; runningByWorkspace: Record<string, number> };

/**
 * Accepts the server payload and guarantees a usable list: every listed workspace has defaults and
 * the current id is one of them. An older server without `workspaces` lists its defaults keys.
 */
export function normalizeWorkspaces(raw: Omit<WorkspaceState, "workspaces"> & { workspaces?: unknown; runningByWorkspace?: unknown }): WorkspacesState {
  const defaults = { ...(raw.defaults ?? {}) } as Record<WorkspaceId, WorkspaceState["defaults"][WorkspaceId]>;
  const listed = Array.isArray(raw.workspaces)
    ? (raw.workspaces as unknown[]).filter((item): item is WorkspaceSummary => Boolean(item) && typeof (item as WorkspaceSummary).id === "string" && typeof (item as WorkspaceSummary).name === "string")
    : [];
  const workspaces = listed.length ? listed : (Object.keys(defaults) as WorkspaceId[]).map((id) => ({ id, name: id }));
  for (const workspace of workspaces) defaults[workspace.id] ??= {};
  const currentWorkspaceId = workspaces.some((workspace) => workspace.id === raw.currentWorkspaceId) ? raw.currentWorkspaceId : workspaces[0]?.id ?? raw.currentWorkspaceId;
  const running = raw.runningByWorkspace && typeof raw.runningByWorkspace === "object" ? raw.runningByWorkspace as Record<string, number> : {};
  return { ...raw, currentWorkspaceId, defaults, workspaces, runningByWorkspace: running };
}

/** Display name; the server's seeded `default` workspace keeps a localized name until renamed. */
export function displayWorkspaceName(workspace: WorkspaceSummary | undefined, fallbackId?: WorkspaceId): string {
  if (!workspace) return String(fallbackId ?? "");
  return workspace.id === "default" && workspace.name === "기본" ? t("workspace.default") : workspace.name;
}

export function workspaceName(workspaces: readonly WorkspaceSummary[], id: WorkspaceId | undefined): string {
  return displayWorkspaceName(workspaces.find((workspace) => workspace.id === id), id);
}

/** Running sessions per workspace id. */
export function runningByWorkspace(sessions: readonly Pick<Session, "workspaceId" | "status">[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) if (session.status === "running") counts[session.workspaceId] = (counts[session.workspaceId] ?? 0) + 1;
  return counts;
}

/** Items of one workspace. Legacy records without an id belong to `defaultWorkspaceId` (the first workspace). */
export function inWorkspace<T extends { workspaceId?: WorkspaceId }>(items: T[], workspaceId: WorkspaceId, defaultWorkspaceId?: WorkspaceId): T[] {
  return items.filter((item) => (item.workspaceId ?? defaultWorkspaceId) === workspaceId);
}

type WorkspaceKey = { key: string; isComposing?: boolean; keyCode?: number; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
/** F1/F2 pick the first/second workspace in list order; returns that index. */
export function workspaceShortcut(event: WorkspaceKey): number | undefined {
  if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return event.key === "F1" ? 0 : event.key === "F2" ? 1 : undefined;
}

/**
 * Serialized `PATCH /api/workspaces` saves. Each save carries the current workspace plus the
 * defaults of one workspace only, so a queued save can never resurrect a workspace deleted meanwhile.
 */
export function createWorkspaceSaver(request: (body: unknown) => Promise<unknown>) {
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  return (state: WorkspaceState, immediate = false, workspaceId: WorkspaceId = state.currentWorkspaceId): Promise<void> => {
    const body = structuredClone({ currentWorkspaceId: state.currentWorkspaceId, workspaceId, defaults: state.defaults[workspaceId] ?? {} });
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

/** Search chats and projects; with `workspaceId` the lists are scoped to it first (undefined: already scoped). */
export function searchWorkspace(sessions: Session[], groups: Group[], workspaceId: WorkspaceId | undefined, query: string) {
  const scopedSessions = workspaceId === undefined ? sessions : inWorkspace(sessions, workspaceId);
  const scopedGroups = workspaceId === undefined ? groups : inWorkspace(groups, workspaceId);
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
  const agent = defaults.agent && allowed.includes(defaults.agent) ? defaults.agent : preferredOrchestrator ?? "claude";
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
