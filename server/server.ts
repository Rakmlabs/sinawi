import { previewAssetsDir, registerPreviewRoutes } from "./preview.js";
import { registerSetupRoutes } from "./setup.js";
import { BrowserBridge, registerBrowserRoutes, watchQueue } from "./browser-bridge.js";
import { ComputerBridge, registerComputerRoutes, watchComputerQueue, type ComputerHint } from "./computer-bridge.js";
import { isComputerUseAllowed } from "./workspace-policy.js";
import { computerContextForToken, computerDir, pruneComputerTokens } from "./computer-tokens.js";
import { DevServerManager, devServerEnv } from "./dev-servers.js";
import { registerOpenExternalRoute } from "./open-external.js";
import { registerPermissionRoutes } from "./permission-prompts.js";
import { registerServeRoutes, watchServeQueue } from "./serve-tool.js";
import { registerSimRoutes, watchSimQueue } from "./sim-tool.js";
import { registerSimViewRoutes, SimScreen } from "./sim-view.js";
import { cliChildEnv } from "./supervision.js";
import { fullPath } from "./cli-path.js";
import { envVar } from "./runtime.js";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { NotificationStore } from "./notifications.js";
import { mcpAuthTitle, mcpDisplayName } from "./tools.js";
import { authNotification, sessionNotifications } from "./notification-sources.js";
import type { NotificationInput, NotificationType } from "./notification-types.js";
import { createTerminalService } from "./terminal.js";
import { appContentSecurityPolicy, isAllowedOrigin } from "./origin-policy.js";
import { commandAvailable, runCli } from "./cli.js";
import { recommendAutoSwitch } from "./auto-routing.js";
import { mediaRouteRequired, mediaUnavailableMessage } from "./media-routing.js";
import { allowedAgentsForWorkspace, assertMediaAllowed, blockedToolMessage, defaultWorkspacePolicy, isToolLocked, lockedToolsFor, normalizeWorkspacePolicy, policyDenyPatterns, WorkspacePolicyError, type WorkspacePolicyResolver } from "./workspace-policy.js";
import { loadUsage } from "./usage.js";
import { loadProviderQuotas } from "./quota.js";
import { exhaustionFromQuota } from "./quota-fallback.js";
import { createQuotaFallbackRunner } from "./router-fallback.js";
import { Orchestra } from "./orchestra.js";
import { discoverFiles } from "./files.js";
import { enabledPublicSkills, publicSkills } from "./skills.js";
import { RoutingService, type ModelCommandRunner, type PlannerRunner } from "./routing.js";
import { workspaceIdPattern, createCoalescedSaver, loadBots, loadGroups, loadSessions, loadToolSettings, loadWorkspaceState, workspaceToolSettings, mutateBots, mutateGroups, mutateToolSettings, mutateWorkspaceState, saveSessions } from "./store.js";
import { discoverMcpTools, updateMcpTool, type ToolCommandRunner } from "./tools.js";
import type { AgentId, AgentSelection, Bot, ConversationInput, ConversationSettings, Group, Session, SessionDraft, StartSessionInput, UpdateTeamInput, WorkspaceDefaults, WorkspaceId, WorkspaceState } from "./types.js";
import { randomUUID } from "node:crypto";
import { registerSessionFileRoutes } from "./session-files.js";
import { registerLinkPreviewRoute } from "./link-preview.js";
import { registerWorktreeRoutes } from "./worktree-routes.js";
import { cleanupSessionWorktrees } from "./worktrees.js";
import { readNotes, reportTime, STEWARD_ROLLOVER_TURNS, stewardName, transcriptPath } from "./steward.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const agentIds = new Set<AgentId>(["codex", "claude", "grok"]);
const execFileAsync = promisify(execFile);
type FolderRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;

export async function pickDirectory(runner: FolderRunner = (file, args) => execFileAsync(file, args, { timeout: 120_000, maxBuffer: 16_384 })) {
  try {
    const { stdout } = await runner("osascript", ["-e", "POSIX path of (choose folder)"]);
    const selected = stdout.trim();
    const path = selected.length > 1 ? selected.replace(/\/$/, "") : selected;
    if (!path) return null;
    if (!(await stat(path)).isDirectory()) throw new Error("선택한 폴더를 찾을 수 없습니다.");
    return path;
  } catch (error) {
    const detail = error instanceof Error ? `${error.message} ${"stderr" in error ? String(error.stderr) : ""}` : String(error);
    if (/user canceled|사용자가 취소|-128/i.test(detail)) return null;
    if (error instanceof Error && error.message === "선택한 폴더를 찾을 수 없습니다.") throw error;
    throw new Error("Finder 폴더 선택기를 열 수 없습니다.");
  }
}

export async function recoverStaleSessions(
  sessions: Session[],
  persist: (sessions: Session[]) => void | Promise<void>,
  now = new Date(),
): Promise<void> {
  const interrupted = sessions.filter((session) => session.status === "running" || (session.status as string) === "planning");
  if (!interrupted.length) return;
  const time = now.toISOString();
  for (const session of interrupted) {
    session.status = "error";
    session.endedAt = time;
    session.events.push({
      id: randomUUID(), sessionId: session.id, agent: session.agent, type: "error",
      text: "서버 재시작으로 작업이 중단되었습니다", time,
    });
  }
  await persist(sessions);
}

/** `full` forces a whole snapshot: the client merges incremental events by id, so it never learns about edits or removals. */
export function sessionStreamMessage(session: Session, lastEventId?: string, full = false) {
  const lastIndex = lastEventId && !full ? session.events.findIndex((event) => event.id === lastEventId) : -1;
  if (lastEventId && lastIndex >= 0) {
    return { type: "session" as const, incremental: true as const, session: { ...session, events: session.events.slice(lastIndex + 1) } };
  }
  return { type: "session" as const, session };
}

function isLoopbackHost(value: string | undefined) {
  const raw = (value ?? "").toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Requests without an Origin come from local non-browser clients (CLIs, curl).
// Browser requests must come from the app itself, not from any other loopback page.
export function isLocalOrigin(origin: string | undefined) {
  return !origin || isAllowedOrigin(origin);
}

function localGuard(req: Request, res: Response, next: NextFunction) {
  if (!isLoopbackHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    res.status(403).json({ error: "로컬 요청만 허용됩니다." });
    return;
  }
  next();
}

function string(value: unknown, max = 100_000): string {
  if (typeof value !== "string") throw new Error("문자열 값이 필요합니다.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error("입력 길이가 올바르지 않습니다.");
  return trimmed;
}

function optionalString(value: unknown, max = 10_000): string | undefined {
  if (value == null || value === "") return undefined;
  return string(value, max);
}

function optionalReasoningEffort(value: unknown): string | undefined {
  const effort = optionalString(value, 30);
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("추론 강도가 올바르지 않습니다.");
  return effort;
}

function agent(value: unknown): AgentId {
  if (!agentIds.has(value as AgentId)) throw new Error("지원하지 않는 에이전트입니다.");
  return value as AgentId;
}

/** Checks the id format only; existence is checked against the live workspace list. */
export function workspaceIdFormat(value: unknown): WorkspaceId {
  if (typeof value !== "string" || !workspaceIdPattern.test(value)) throw new Error("워크스페이스가 올바르지 않습니다.");
  return value;
}

export function workspaceName(value: unknown): string {
  if (typeof value !== "string") throw new Error("워크스페이스 이름이 필요합니다.");
  const name = value.trim();
  if (!name || name.length > 40) throw new Error("워크스페이스 이름은 1~40자여야 합니다.");
  return name;
}

/** Id for a new workspace: the slugified name, or `ws-<random>` when that is empty or taken. */
export function newWorkspaceId(name: string, taken: ReadonlySet<string>): WorkspaceId {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  if (slug && !taken.has(slug)) return slug;
  let id: string;
  do id = `ws-${randomUUID().slice(0, 8)}`; while (taken.has(id));
  return id;
}

type WorkspaceResolver = (value: unknown, fallback?: WorkspaceId) => WorkspaceId;

function ids(value: unknown, max = 20): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) throw new Error("목록 값이 올바르지 않습니다.");
  return [...new Set(value as string[])];
}

function agentSelection(value: unknown): AgentSelection {
  if (!value || typeof value !== "object") throw new Error("에이전트 설정이 올바르지 않습니다.");
  const input = value as Record<string, unknown>;
  if (input.sessionMode != null && input.sessionMode !== "new" && input.sessionMode !== "resume") throw new Error("작업자 세션 모드가 올바르지 않습니다.");
  return {
    agent: agent(input.agent),
    ...(input.id ? { id: string(input.id, 100) } : {}),
    ...(input.label ? { label: string(input.label, 100) } : {}),
    ...(input.sessionMode ? { sessionMode: input.sessionMode as "new" | "resume" } : {}),
    ...(input.model ? { model: string(input.model, 200) } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: optionalReasoningEffort(input.reasoningEffort) } : {}),
    ...(input.reason ? { reason: string(input.reason, 500) } : {}),
  };
}

function agentSelections(value: unknown, max = 3): AgentSelection[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error("에이전트 설정 목록이 올바르지 않습니다.");
  const selections = value.map(agentSelection);
  const explicitIds = selections.flatMap((selection) => selection.id ? [selection.id] : []);
  if (new Set(explicitIds).size !== explicitIds.length) throw new Error("작업자 ID는 중복될 수 없습니다.");
  return selections;
}

function agents(value: unknown, max = 20): AgentId[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error("목록 값이 올바르지 않습니다.");
  return value.map(agent);
}

function conversationSettings(body: any): ConversationSettings {
  if (body?.mode !== undefined && body.mode !== "auto" && body.mode !== "manual") throw new Error("배정 방식이 올바르지 않습니다.");
  if (body?.autoSwitch !== undefined && typeof body.autoSwitch !== "boolean") throw new Error("자동 전환 설정이 올바르지 않습니다.");
  if (body?.permissionMode !== undefined && !["plan", "auto", "full"].includes(body.permissionMode)) throw new Error("권한 모드가 올바르지 않습니다.");
  if (body?.autoRun !== undefined && typeof body.autoRun !== "boolean") throw new Error("끝까지 진행 설정이 올바르지 않습니다.");
  return { mode: body?.mode, autoSwitch: body?.autoSwitch, permissionMode: body?.permissionMode, autoRun: body?.autoRun };
}

function startInput(body: any, workspace: WorkspaceResolver, fallbackWorkspace: WorkspaceId): StartSessionInput {
  return {
    ...conversationSettings(body),
    prompt: string(body?.prompt), agent: agent(body?.agent),
    workers: agents(body?.workers, 3), cwd: string(body?.cwd, 4_096),
    model: optionalString(body?.model, 200), reasoningEffort: optionalReasoningEffort(body?.reasoningEffort),
    workerConfigs: agentSelections(body?.workerConfigs), planner: body?.planner == null ? undefined : agentSelection(body.planner),
    skills: ids(body?.skills),
    systemPrompt: optionalString(body?.systemPrompt, 50_000), resumeSessionId: optionalString(body?.resumeSessionId, 500),
    groupId: optionalString(body?.groupId, 500),
    workspaceId: workspace(body?.workspaceId, fallbackWorkspace),
    // A commander's goal sessions are started by the app (parentId), never from a request.
    ...(body?.commander === true ? { commander: true } : body?.goal === true ? { goal: true } : {}),
    ...(body?.steward === true || body?.steward && typeof body.steward === "object" ? { steward: { name: optionalString(body.steward?.name, 80) } } : {}),
  };
}

export function workspaceDefaults(value: unknown): WorkspaceDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("워크스페이스 기본 설정이 올바르지 않습니다.");
  const input = value as Record<string, unknown>;
  if (input.quotaFallback != null && typeof input.quotaFallback !== "boolean") throw new Error("자동 전환 설정이 올바르지 않습니다.");
  if (input.quotaThreshold != null && (typeof input.quotaThreshold !== "number" || !Number.isFinite(input.quotaThreshold) || input.quotaThreshold < 0 || input.quotaThreshold > 100)) throw new Error("한도 임계값은 0~100%여야 합니다.");
  let fallbackOrder: WorkspaceDefaults["fallbackOrder"];
  if (input.fallbackOrder != null) {
    if (typeof input.fallbackOrder !== "object" || Array.isArray(input.fallbackOrder)) throw new Error("전환 순서가 올바르지 않습니다.");
    fallbackOrder = {};
    for (const [source, targets] of Object.entries(input.fallbackOrder)) {
      const from = agent(source);
      fallbackOrder[from] = [...new Set(ids(targets, 3).map(agent))].filter((id) => id !== from);
    }
  }
  return {
    ...(input.quotaFallback == null ? {} : { quotaFallback: input.quotaFallback as boolean }),
    ...(input.quotaThreshold == null ? {} : { quotaThreshold: input.quotaThreshold as number }),
    ...(fallbackOrder == null ? {} : { fallbackOrder }),
    ...(input.allowedAgents == null ? {} : { allowedAgents: ids(input.allowedAgents, 3).map(agent) }),
    ...(input.cwd == null || input.cwd === "" ? {} : { cwd: string(input.cwd, 4_096) }),
    ...conversationSettings(input),
    ...(input.agent == null ? {} : { agent: agent(input.agent) }),
    ...(input.workers == null ? {} : { workers: agents(input.workers, 3) }),
    ...(input.model == null || input.model === "" ? {} : { model: string(input.model, 200) }),
    ...(input.reasoningEffort == null || input.reasoningEffort === "" ? {} : { reasoningEffort: optionalReasoningEffort(input.reasoningEffort) }),
    ...(input.workerConfigs == null ? {} : { workerConfigs: agentSelections(input.workerConfigs) }),
  };
}

function teamInput(body: any): UpdateTeamInput {
  const selection = agentSelection(body);
  return {
    ...selection,
    workers: agents(body?.workers, 3),
    workerConfigs: agentSelections(body?.workerConfigs),
  };
}

function errorResponse(res: Response, error: unknown, status = 400) {
  // Policy errors carry a code so the client can link to the workspace's settings.
  const code = error instanceof WorkspacePolicyError ? { code: error.code } : {};
  res.status(status).json({ error: error instanceof Error ? error.message : String(error), ...code });
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function routingInput(body: any): { prompt: string; cwd: string; skills: string[] } {
  return { prompt: string(body?.prompt, 20_000), cwd: resolve(string(body?.cwd, 4_096)), skills: ids(body?.skills) };
}

/** Applies the selected attempt agent's workspace MCP policy (disabled and locked tools) to every planner run. */
export function withWorkspaceMcpBlocks(runner: PlannerRunner, dataDir?: string, policyFor?: WorkspacePolicyResolver): PlannerRunner {
  return async (options) => {
    const workspaceId = options.usageContext?.workspaceId;
    const disabled = workspaceId ? workspaceToolSettings(await loadToolSettings(dataDir), workspaceId).disabledMcp : [];
    const policy = workspaceId ? policyFor?.(workspaceId) : undefined;
    const prefix = `${options.agent}:`;
    const blockedMcp = disabled
      .filter((key) => key.startsWith(prefix) && key.length > prefix.length)
      .map((key) => `mcp__${key.slice(prefix.length)}__*`);
    const locked = lockedToolsFor(policy, options.agent);
    return runner({
      ...options,
      blockedMcp: [...new Set([...(options.blockedMcp ?? []), ...blockedMcp, ...policyDenyPatterns(policy, options.agent)])],
      ...(locked.length ? { lockedMcp: [...new Set([...(options.lockedMcp ?? []), ...locked])] } : {}),
    });
  };
}

export function createServer(options: { staticDir?: string; folderRunner?: FolderRunner; dataDir?: string; routingRunner?: PlannerRunner; limitsRunner?: typeof runCli; routingSkillLoader?: typeof publicSkills; toolSkillLoader?: typeof publicSkills; toolRunner?: ToolCommandRunner; codexConfigPath?: string; availableAgents?: AgentId[]; availabilityLoader?: () => Promise<AgentId[]>; modelRunner?: ModelCommandRunner; modelHomeDir?: string; sessionSaver?: typeof saveSessions; sessionSaveDelayMs?: number; inactivityTimeoutMs?: number; worktrees?: boolean; authDiscovery?: { sleep?: (ms: number) => Promise<void> }; browserQueue?: boolean } = {}) {
  const app = express();
  app.disable("x-powered-by");
  const smallJson = express.json({ limit: "1mb" });
  const largeJson = express.json({ limit: "40mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/preview/assets/raw") { next(); return; }
    return ((req.path === "/api/preview/assets" || req.path === "/api/browser/result") ? largeJson : smallJson)(req, res, next);
  });
  const httpServer = createHttpServer(app);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  const deliveredEvents = new WeakMap<WebSocket, Map<string, string>>();

  const notifications = new NotificationStore(options.dataDir, (workspaceId) => {
    const message = JSON.stringify({ type: "notifications", workspaceId });
    for (const client of websocket.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  });
  const notify = (input: NotificationInput) => { void notifications.add(input).catch((error) => console.error("알림 저장 실패:", error.message)); };
  const terminal = createTerminalService({ onError: (message) => {
    notify({ workspaceId: workspaceState.currentWorkspaceId, key: "terminal:load", type: "error", title: "통합 터미널 시작 실패", body: message });
  } });
  const observedEvents = new Set<string>();
  const completedRuns = new Set<string>();
  const broadcast = (session: Session, publishOptions?: { full?: boolean }) => {
    for (const note of sessionNotifications(session)) {
      const seen = note.type === "run-finished" ? completedRuns : observedEvents;
      if (note.key && !seen.has(note.key)) {
        seen.add(note.key); notify(note);
        if (seen.size > 10000) seen.delete(seen.values().next().value!);
      }
    }
    for (const client of websocket.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      let delivered = deliveredEvents.get(client);
      if (!delivered) {
        delivered = new Map();
        deliveredEvents.set(client, delivered);
      }
      const message = sessionStreamMessage(session, delivered.get(session.id), publishOptions?.full);
      client.send(JSON.stringify(message));
      const latest = session.events.at(-1)?.id;
      if (latest) delivered.set(session.id, latest);
    }
  };
  const broadcastRemoval = (sessionId: string) => {
    for (const client of websocket.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(JSON.stringify({ type: "session_deleted", sessionId }));
      deliveredEvents.get(client)?.delete(sessionId);
    }
  };
  const broadcastGroups = (groups: Group[]) => {
    const message = JSON.stringify({ type: "groups", groups });
    for (const client of websocket.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  };
  // Run events schedule a coalesced save of the sessions they changed; API routes that
  // must report persistence failures flush immediately, which writes everything still
  // scheduled. `changed: undefined` rewrites every session (startup recovery, shutdown).
  type SessionWrite = { sessions: Session[]; changed?: Set<string> };
  const sessionWriter = createCoalescedSaver<SessionWrite>(
    ({ sessions, changed }: SessionWrite) => (options.sessionSaver ?? saveSessions)(sessions, options.dataDir, changed),
    options.sessionSaveDelayMs ?? 250,
    (pending: SessionWrite, next: SessionWrite) => ({ sessions: next.sessions, changed: pending.changed && next.changed ? new Set([...pending.changed, ...next.changed]) : undefined }),
  );
  const persistSessions = (sessions: Session[]) => sessionWriter.flush({ sessions, changed: new Set() });
  const persistAllSessions = (sessions: Session[]) => sessionWriter.flush({ sessions });
  const scheduleSessions = (sessions: Session[], changedIds: string[]) => sessionWriter.schedule({ sessions, changed: new Set(changedIds) });
  let workspaceState: WorkspaceState = { currentWorkspaceId: "default", workspaces: [{ id: "default", name: "기본" }], defaults: {}, settings: {} };
  const currentWorkspace = () => workspaceState.currentWorkspaceId;
  const workspace: WorkspaceResolver = (value, fallback) => {
    if (value == null && fallback) return fallback;
    const id = workspaceIdFormat(value);
    if (!workspaceState.workspaces.some((item) => item.id === id)) throw new Error("워크스페이스가 올바르지 않습니다.");
    return id;
  };
  const queryWorkspace = (value: unknown) => value == null ? undefined : workspace(value);
  const toolsWorkspace = (value: unknown) => workspace(value, currentWorkspace());
  const runningByWorkspace = () => {
    const counts: Record<string, number> = Object.fromEntries(workspaceState.workspaces.map((item) => [item.id, 0]));
    for (const session of orchestra.list()) if (session.status === "running") counts[session.workspaceId] = (counts[session.workspaceId] ?? 0) + 1;
    return counts;
  };
  /** Workspace route responses: the persisted state plus running-session counts per workspace. */
  const workspacesPayload = () => ({ ...workspaceState, runningByWorkspace: runningByWorkspace() });
  const allowedFor = (id: WorkspaceId) => allowedAgentsForWorkspace(id, workspaceState.defaults[id]?.allowedAgents);
  const policyFor: WorkspacePolicyResolver = (id) => workspaceState.settings?.[id] ?? defaultWorkspacePolicy();
  const quotaAwareAgents = async (agents: AgentId[], workspaceId: WorkspaceId) => {
    const defaults = workspaceState.defaults[workspaceId] ?? {};
    if (defaults.quotaFallback === false) return agents;
    const quotas = await loadProviderQuotas(options.dataDir, options.modelHomeDir);
    const eligible = agents.filter((id) => !exhaustionFromQuota(quotas.find((quota) => quota.agent === id), defaults.quotaThreshold ?? 3).exhausted);
    return eligible;
  };
  const fallbackContext = async (workspaceId: WorkspaceId) => {
    await modelsReady;
    const defaults = workspaceState.defaults[workspaceId] ?? {};
    const settings = await routing.loadSettings();
    const available = await getAvailableAgents();
    const authenticated = available.filter((id) => settings.modelOptions[id].authStatus !== "unauthenticated");
    return { enabled: defaults.quotaFallback !== false, threshold: defaults.quotaThreshold ?? 3,
      order: defaults.fallbackOrder, quotas: await loadProviderQuotas(options.dataDir, options.modelHomeDir),
      authenticated, authenticatedAgents: authenticated, allowedAgents: allowedFor(workspaceId) };
  };
  const routingRunner = createQuotaFallbackRunner(withWorkspaceMcpBlocks(options.routingRunner ?? runCli, options.dataDir, policyFor), fallbackContext);
  const orchestra = new Orchestra(broadcast, undefined, scheduleSessions, broadcastRemoval, async (session, prompt, signal) => {
    await modelsReady;
    const settings = await routing.loadSettings();
    const candidates = (await getAvailableAgents()).filter((id) => allowedFor(session.workspaceId).includes(id));
    return recommendAutoSwitch(prompt, session.cwd, settings, await quotaAwareAgents(candidates, session.workspaceId), routingRunner, signal, { workspaceId: session.workspaceId, sessionId: session.id, role: "router", dataDir: options.dataDir }, undefined, policyFor(session.workspaceId).mediaGeneration);
  }, allowedFor, options.dataDir, (session) => fallbackContext(session.workspaceId),
  (prompt) => routing.loadSettings().then((settings) => mediaRouteRequired(prompt, settings.rules)), options.inactivityTimeoutMs, policyFor);
  // Per-worker git worktrees (server/worktrees.ts). Opt-in so tests and embedders never create branches.
  if (options.worktrees) orchestra.worktreeDataDir = options.dataDir ?? join(homedir(), ".sinawi");
  orchestra.stewardDataDir = options.dataDir ?? join(homedir(), ".sinawi");
  // Leads' daily reports: checked every minute, and once shortly after start for a report missed while closed.
  const stewardTimer = setInterval(() => orchestra.stewardTick(), 60_000);
  stewardTimer.unref();
  setTimeout(() => orchestra.stewardTick(), 15_000).unref();
  const routing = new RoutingService({ dataDir: options.dataDir, runner: routingRunner, skillLoader: options.routingSkillLoader, modelRunner: options.modelRunner, homeDir: options.modelHomeDir, authDiscovery: options.authDiscovery });
  const getAvailableAgents = async () => {
    if (Array.isArray(options.availableAgents)) return [...new Set(options.availableAgents)];
    if (options.availabilityLoader) return [...new Set(await options.availabilityLoader())];
    const ids = ["codex", "claude", "grok"] as AgentId[];
    const availability = await Promise.all(ids.map(commandAvailable));
    return ids.filter((_id, index) => availability[index]);
  };
  const ready = Promise.all([loadSessions(options.dataDir), loadWorkspaceState(options.dataDir)]).then(async ([sessions, state]) => {
    workspaceState = state;
    await recoverStaleSessions(sessions, persistAllSessions);
    orchestra.restore(sessions);
  });
  // Start discovery even when settings were saved by an earlier app version.
  // Settings errors remain visible through the API without blocking session recovery.
  const syncAuthNotifications = async () => {
    const settings = await routing.loadSettings();
    for (const { id: workspaceId } of workspaceState.workspaces) {
      for (const id of agentIds) {
        const option = settings.modelOptions[id];
        const note = allowedFor(workspaceId).includes(id) ? authNotification(workspaceId, id, option.authStatus, option.authDetail) : undefined;
        if (note) await notifications.add(note);
        else if (option.authStatus === "authenticated" || !allowedFor(workspaceId).includes(id)) await notifications.resolve(workspaceId, `auth:${id}`);
      }
    }
  };
  const modelsReady = routing.refreshModels().then(async () => { await ready; await syncAuthNotifications(); }).then(() => undefined, () => undefined);
  let authRefresh: Promise<unknown> | undefined;
  let lastFocusRefresh = 0;
  const refreshAuth = () => {
    if (!authRefresh) authRefresh = routing.refreshModels().then(async (settings) => { await ready; await syncAuthNotifications(); return settings; }).finally(() => { authRefresh = undefined; });
    return authRefresh;
  };
  const authInterval = setInterval(() => { void refreshAuth().catch(() => undefined); }, 5 * 60_000);
  authInterval.unref();
  httpServer.once("close", () => { clearInterval(authInterval); terminal.close(); });
  websocket.once("close", () => { clearInterval(authInterval); terminal.close(); });
  const assertMediaAvailable = async (prompt: string, workspaceId: WorkspaceId) => {
    await modelsReady;
    const settings = await routing.loadSettings();
    if (!mediaRouteRequired(prompt, settings.rules)) return;
    assertMediaAllowed(policyFor(workspaceId));
    const available = await quotaAwareAgents(await getAvailableAgents(), workspaceId);
    if (!available.includes("grok") || !allowedFor(workspaceId).includes("grok") || settings.modelOptions.grok.authStatus === "unauthenticated") {
      throw new Error(mediaUnavailableMessage);
    }
  };
  let limitsRefresh: Promise<void> | undefined;
  const refreshClaudeLimits = () => {
    if (limitsRefresh) return limitsRefresh;
    limitsRefresh = (async () => {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        // Ref'd on purpose: it is what settles the awaited race if the CLI never does; `finally` clears it.
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 15_000);
      });
      const limitsPolicy = policyFor(currentWorkspace());
      const invocation = Promise.resolve().then(() => (options.limitsRunner ?? runCli)({
        agent: "claude", prompt: ".", model: "haiku", cwd: process.cwd(), signal: controller.signal,
        blockedMcp: policyDenyPatterns(limitsPolicy, "claude"), lockedMcp: lockedToolsFor(limitsPolicy, "claude"),
        usageContext: { workspaceId: currentWorkspace(), sessionId: randomUUID(), role: "router", dataDir: options.dataDir },
        onLine: () => undefined,
      }));
      try {
        const result = await Promise.race([invocation, timeout]);
        if (!result) throw new Error("Claude 한도 확인 시간이 초과되었습니다.");
        if (result.exitCode !== 0) throw new Error("Claude 한도 확인에 실패했습니다.");
      } finally { if (timer) clearTimeout(timer); }
    })().finally(() => { limitsRefresh = undefined; });
    return limitsRefresh;
  };

  app.use("/api", localGuard);
  const previewProxies = registerPreviewRoutes(app, { dataDir: options.dataDir, appPort: Number(envVar("PORT") ?? 3001) });
  httpServer.once("close", () => previewProxies.close());
  const browserBridge = new BrowserBridge((command) => {
    const message = JSON.stringify(command);
    let count = 0;
    for (const client of websocket.clients) if (client.readyState === WebSocket.OPEN) { client.send(message); count++; }
    return count;
  }, options.browserQueue && process.platform === "darwin" ? () => new Promise<boolean>((done) => {
    // Server runs under launchd, separate from the app; reopen the app window so ao-browser has a target.
    // -g leaves it behind other windows. It still has to answer: WKWebView must not suspend (backgroundThrottling: disabled).
    execFile("open", ["-g", "-b", envVar("BUNDLE_ID") ?? "dev.sinawi.app"], (error) => done(!error));
  }) : undefined);
  // Every agent run has a token; a command without one has no workspace or owner (see NO_TOKEN_ERROR).
  registerBrowserRoutes(app, browserBridge, true);
  if (options.browserQueue) { const stop = watchQueue(browserBridge, undefined, undefined, true); httpServer.once("close", stop); }
  // Computer use: same relay as the browser bridge, gated by the workspace setting `computerUse`.
  const openClients = () => [...websocket.clients].filter((client) => client.readyState === WebSocket.OPEN);
  // The caller is identified only by its per-run token (issued by runCli); client-sent ids are ignored.
  const computerContext = (hint: ComputerHint) => computerContextForToken(hint.token, orchestra.list(), (id) => workspaceState.workspaces.find((item) => item.id === id)?.name);
  const tokenPrune = setInterval(() => pruneComputerTokens((id) => orchestra.list().some((item) => item.id === id && item.status === "running")), 60_000);
  tokenPrune.unref();
  httpServer.once("close", () => clearInterval(tokenPrune));
  httpServer.once("close", () => clearInterval(stewardTimer));
  const computerBridge = new ComputerBridge({
    // Each connection gets its own nonce; /api/computer/result accepts only a nonce sent with that command.
    send: (command, nonce) => { const clients = openClients(); for (const client of clients) client.send(JSON.stringify({ ...command, nonce: nonce() })); return clients.length; },
    broadcast: (payload) => { const message = JSON.stringify(payload); for (const client of openClients()) client.send(message); },
    windows: () => openClients().length,
    isAllowed: (workspaceId) => isComputerUseAllowed(workspaceState, workspaceId),
    resolveContext: computerContext,
    keyAlive: (key) => !key.startsWith("session:") || orchestra.list().some((item) => item.id === key.slice("session:".length)),
    launchApp: options.browserQueue && process.platform === "darwin" ? () => new Promise<boolean>((done) => {
      execFile("open", ["-g", "-b", envVar("BUNDLE_ID") ?? "dev.sinawi.app"], (error) => done(!error));
    }) : undefined,
    logFile: envVar("COMPUTER_LOG"),
  });
  orchestra.computerHalt = (sessionId, since) => computerBridge.userHalt(sessionId, since);
  httpServer.once("close", () => computerBridge.dispose());
  registerComputerRoutes(app, computerBridge);
  if (options.browserQueue) { const stop = watchComputerQueue(computerBridge); httpServer.once("close", stop); }
  const devServers = new DevServerManager({
    logDir: join(computerDir(), "serve-logs"),
    // No CI=1 here (unlike the agent CLIs): Expo/Metro and others turn off file watching in CI,
    // so a fixed file never reached the app until the server was restarted. stdin is closed, so
    // nothing waits on a prompt anyway.
    env: () => devServerEnv(cliChildEnv(process.env, { PATH: fullPath() })),
    onEvent: (sessionId, text) => orchestra.note(sessionId, text),
  });
  orchestra.sessionRemoved = (id) => devServers.stopSession(id);
  // Live drafts: at most one push per 50 ms per writer; the end of a draft ("") goes out at once and
  // drops a pending push, so a stale fragment never lands after the finished message.
  const draftTimers = new Map<string, { timer?: NodeJS.Timeout; latest?: SessionDraft }>();
  const sendDraft = (draft: SessionDraft) => { const message = JSON.stringify({ type: "draft", ...draft }); for (const client of openClients()) client.send(message); };
  orchestra.sessionDraft = (draft) => {
    const key = `${draft.sessionId}:${draft.workerId ?? ""}`;
    const state = draftTimers.get(key) ?? {};
    if (!draft.text) {
      if (state.timer) clearTimeout(state.timer);
      draftTimers.delete(key);
      sendDraft(draft);
      return;
    }
    state.latest = draft;
    if (!state.timer) {
      sendDraft(draft);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        if (state.latest && state.latest !== draft) sendDraft(state.latest);
      }, 50);
    }
    draftTimers.set(key, state);
  };
  httpServer.once("close", () => devServers.stopAll());
  process.once("exit", () => devServers.stopAll("SIGKILL"));
  registerServeRoutes(app, devServers);
  if (options.browserQueue) { const stop = watchServeQueue(devServers); httpServer.once("close", stop); }
  const simOptions = { onLaunch: (udid: string) => { const message = JSON.stringify({ type: "sim-open", udid }); for (const client of openClients()) client.send(message); } };
  registerSimRoutes(app, simOptions);
  const simScreen = new SimScreen();
  httpServer.once("close", () => simScreen.stopAll());
  registerSimViewRoutes(app, simScreen);
  if (options.browserQueue) { const stop = watchSimQueue(simOptions); httpServer.once("close", stop); }
  app.use("/api", async (_req, _res, next) => { await ready; next(); });

  terminal.registerRoutes(app);
  registerSetupRoutes(app);
  app.get("/api/notifications", async (req, res) => {
    try { res.json(await notifications.list(workspace(req.query.workspace, currentWorkspace()))); }
    catch (error) { errorResponse(res, error); }
  });
  app.post("/api/notifications", async (req, res) => {
    try {
      const workspaceId = workspace(req.body?.workspace ?? req.body?.workspaceId, currentWorkspace());
      const type = string(req.body?.type, 30) as NotificationType;
      if (!["auth", "quota", "permission", "run-finished", "error", "info"].includes(type)) throw new Error("알림 종류가 올바르지 않습니다.");
      // Client reports are informational; executable actions originate in server sources.
      res.status(201).json(await notifications.add({ workspaceId, type, title: string(req.body?.title, 200), body: optionalString(req.body?.body, 2000) ?? "", key: optionalString(req.body?.key, 200) }));
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/notifications/read", async (req, res) => {
    try {
      const workspaceId = workspace(req.body?.workspace ?? req.body?.workspaceId, currentWorkspace());
      await notifications.read(workspaceId, req.body?.all === true ? "all" : ids(req.body?.ids, 200));
      res.json(await notifications.list(workspaceId));
    } catch (error) { errorResponse(res, error); }
  });
  app.delete("/api/notifications", async (req, res) => {
    try { await notifications.clear(workspace(req.query.workspace, currentWorkspace())); res.status(204).end(); }
    catch (error) { errorResponse(res, error); }
  });

  app.get("/api/bootstrap", async (req, res) => {
    try {
      const workspaceId = queryWorkspace(req.query.workspace);
      const available = new Set(await getAvailableAgents());
      const names = ["Codex", "Claude", "Grok Build"];
      const agents = (["codex", "claude", "grok"] as AgentId[]).map((id, index) => ({ id, name: names[index], available: available.has(id), detail: available.has(id) ? "설치됨" : "CLI를 찾을 수 없음" }));
      const defaultCwd = homedir();
      const groups = await loadGroups(options.dataDir);
      const disabled = workspaceId ? workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId).disabledSkills : [];
      res.json({ agents, skills: await enabledPublicSkills(undefined, false, disabled), bots: await loadBots(options.dataDir), groups: workspaceId ? groups.filter((group) => group.workspaceId === workspaceId) : groups, defaultCwd, homeCwd: homedir() });
    } catch (error) { errorResponse(res, error, 500); }
  });

  app.get("/api/skills", async (req, res) => {
    try {
      const cwd = req.query.cwd === undefined ? process.cwd() : resolve(string(req.query.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const workspaceId = toolsWorkspace(req.query.workspace);
      const disabled = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId).disabledSkills;
      res.json(await enabledPublicSkills(cwd, false, disabled));
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/skills/refresh", async (req, res) => {
    try {
      const cwd = resolve(string(req.body?.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const workspaceId = toolsWorkspace(req.body?.workspace);
      const disabled = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId).disabledSkills;
      res.json(await enabledPublicSkills(cwd, true, disabled));
    } catch (error) { errorResponse(res, error); }
  });

  const toolsPayload = async (workspaceId: WorkspaceId, cwd = process.cwd()) => {
    const settings = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId);
    const skillLoader = options.toolSkillLoader ?? publicSkills;
    const skills = await skillLoader(cwd);
    const disabled = new Set(settings.disabledSkills.map((name) => name.toLocaleLowerCase()));
    return {
      mcp: await discoverMcpTools(workspaceId, { runner: options.toolRunner, disabledMcp: settings.disabledMcp, policy: policyFor(workspaceId) }).then(async (tools) => {
        // Optional/unused MCPs only show a status in 도구 관리. Notify (grouped) only for MCPs the user relies on.
        await notifications.resolveWhere(workspaceId, (key) => key.startsWith("mcp:"));
        const watched = new Set(policyFor(workspaceId).authAlertTools.map((name) => name.toLocaleLowerCase()));
        const pending = tools.filter((tool) => tool.needsAuth && tool.appEnabled && allowedFor(workspaceId).includes(tool.agent) && watched.has(tool.name.toLocaleLowerCase()));
        if (pending.length) {
          const first = pending[0];
          const title = pending.length === 1 ? mcpAuthTitle(first.agent, [first.name])
            : `MCP 인증이 필요해요: ${pending.map((tool) => `${tool.agent === "grok" ? "Grok" : tool.agent === "claude" ? "Claude" : "Codex"}의 ${mcpDisplayName(tool.name)}`).join(", ")}`;
          const body = pending.map((tool) => tool.authHint).filter(Boolean).join("\n");
          await notifications.add({ workspaceId, key: "mcp-auth", type: "auth", title, body, action: { label: `터미널에서 ${mcpDisplayName(first.name)} 인증`, command: first.authCommand ?? first.agent, cwd } });
        } else await notifications.resolve(workspaceId, "mcp-auth");
        return tools;
      }),
      skills: skills.map((skill) => ({ name: skill.name, source: skill.source, agents: skill.agents ?? [], description: skill.description, enabled: !disabled.has(skill.name.toLocaleLowerCase()) })),
    };
  };

  app.get("/api/tools", async (req, res) => {
    try {
      const cwd = req.query.cwd == null ? process.cwd() : resolve(string(req.query.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      res.json(await toolsPayload(toolsWorkspace(req.query.workspace), cwd));
    }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.put("/api/tools/mcp", async (req, res) => {
    try {
      const workspaceId = toolsWorkspace(req.body?.workspace);
      const cwd = req.body?.cwd == null ? process.cwd() : resolve(string(req.body.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const id = agent(req.body?.agent);
      const name = string(req.body?.name, 200);
      if (typeof req.body?.enabled !== "boolean") throw new Error("도구 사용 설정이 올바르지 않습니다.");
      if (isToolLocked(policyFor(workspaceId), id, name)) throw new WorkspacePolicyError(blockedToolMessage(name));
      await updateMcpTool({ agent: id, name, enabled: req.body.enabled }, { runner: options.toolRunner, codexConfigPath: options.codexConfigPath });
      await mutateToolSettings((settings) => {
        const key = `${id}:${name}`;
        const target = workspaceToolSettings(settings, workspaceId);
        const values = target.disabledMcp.filter((item) => item !== key);
        target.disabledMcp = req.body.enabled ? values : [...values, key];
      }, options.dataDir);
      res.json(await toolsPayload(workspaceId, cwd));
    } catch (error) { errorResponse(res, error); }
  });
  app.put("/api/tools/skill", async (req, res) => {
    try {
      const workspaceId = toolsWorkspace(req.body?.workspace);
      const cwd = req.body?.cwd == null ? process.cwd() : resolve(string(req.body.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const name = string(req.body?.name, 200);
      if (typeof req.body?.enabled !== "boolean") throw new Error("스킬 사용 설정이 올바르지 않습니다.");
      await mutateToolSettings((settings) => {
        const target = workspaceToolSettings(settings, workspaceId);
        const values = target.disabledSkills.filter((item) => item.toLocaleLowerCase() !== name.toLocaleLowerCase());
        target.disabledSkills = req.body.enabled ? values : [...values, name];
      }, options.dataDir);
      res.json(await toolsPayload(workspaceId, cwd));
    } catch (error) { errorResponse(res, error); }
  });

  app.get("/api/settings", async (_req, res) => {
    try { await modelsReady; res.json(await routing.loadSettings()); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.put("/api/settings", async (req, res) => {
    try { await modelsReady; res.json(await routing.saveSettings(req.body)); }
    catch (error) { errorResponse(res, error); }
  });
  app.post("/api/settings/models/refresh", async (_req, res) => {
    try {
      await modelsReady;
      const focus = _req.body?.reason === "focus";
      if (focus && Date.now() - lastFocusRefresh < 60_000) { res.json(await routing.loadSettings()); return; }
      if (focus) lastFocusRefresh = Date.now();
      res.json(await refreshAuth());
    }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.post("/api/route", async (req, res) => {
    try {
      await modelsReady;
      const input = routingInput(req.body);
      if (!(await stat(input.cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const workspaceId = workspace(req.body?.workspaceId, currentWorkspace());
      await assertMediaAvailable(input.prompt, workspaceId);
      const permitted = (await getAvailableAgents()).filter((id) => allowedFor(workspaceId).includes(id));
      const available = await quotaAwareAgents(permitted, workspaceId);
      res.json(await routing.recommend(input.prompt, input.cwd, input.skills, available, { workspaceId, sessionId: randomUUID(), role: "router", dataDir: options.dataDir }, allowedFor(workspaceId), policyFor(workspaceId)));
    } catch (error) { errorResponse(res, error); }
  });

  app.get("/api/sessions", (req, res) => {
    try {
      const workspaceId = queryWorkspace(req.query.workspace);
      const sessions = orchestra.list();
      res.json(workspaceId ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions);
    } catch (error) { errorResponse(res, error); }
  });

  app.get("/api/usage", async (_req, res) => {
    try { res.json({ runs: await loadUsage(options.dataDir) }); }
    catch (error) { errorResponse(res, error, 500); }
  });

  app.get("/api/limits", async (_req, res) => {
    try { res.json({ providers: await loadProviderQuotas(options.dataDir, options.modelHomeDir) }); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.post("/api/limits/refresh", async (_req, res) => {
    try {
      await refreshClaudeLimits();
      res.json({ providers: await loadProviderQuotas(options.dataDir, options.modelHomeDir) });
    } catch (error) { errorResponse(res, error, 500); }
  });

  app.post("/api/sessions/:id/quota/return", async (req, res) => {
    try { res.json(await orchestra.returnFromQuotaFallback(routeParam(req.params.id), string(req.body?.eventId, 100))); }
    catch (error) { errorResponse(res, error); }
  });

  app.get("/api/workspaces", async (_req, res) => {
    try { workspaceState = await loadWorkspaceState(options.dataDir); res.json(workspacesPayload()); }
    catch (error) { errorResponse(res, error, 500); }
  });
  const workspaceNotFound = (error: unknown) => error instanceof Error && error.message === "워크스페이스를 찾을 수 없습니다.";
  app.patch("/api/workspaces", async (req, res) => {
    try {
      const currentWorkspaceId = req.body?.currentWorkspaceId == null ? undefined : workspace(req.body.currentWorkspaceId);
      let defaultsByWorkspace: Record<WorkspaceId, WorkspaceDefaults> | undefined;
      if (req.body?.defaultsByWorkspace != null) {
        const input = req.body.defaultsByWorkspace;
        if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length) throw new Error("워크스페이스 기본 설정이 올바르지 않습니다.");
        defaultsByWorkspace = {};
        for (const [id, value] of Object.entries(input)) defaultsByWorkspace[workspace(id)] = workspaceDefaults(value);
      }
      const singleWorkspaceId = req.body?.defaults == null && req.body?.settings == null ? undefined : workspace(req.body?.workspaceId);
      const singleDefaults = req.body?.defaults == null ? undefined : workspaceDefaults(req.body.defaults);
      // Validate before touching the state; merged onto the stored policy below.
      if (req.body?.settings != null) normalizeWorkspacePolicy(req.body.settings, true);
      workspaceState = await mutateWorkspaceState((state) => {
        const known = new Set(state.workspaces.map((item) => item.id));
        for (const id of [currentWorkspaceId, singleWorkspaceId, ...Object.keys(defaultsByWorkspace ?? {})]) if (id && !known.has(id)) throw new Error("워크스페이스를 찾을 수 없습니다.");
        if (currentWorkspaceId) state.currentWorkspaceId = currentWorkspaceId;
        if (defaultsByWorkspace) Object.assign(state.defaults, defaultsByWorkspace);
        if (singleWorkspaceId && singleDefaults) state.defaults[singleWorkspaceId] = singleDefaults;
        if (singleWorkspaceId && req.body?.settings != null) (state.settings ??= {})[singleWorkspaceId] = normalizeWorkspacePolicy(req.body.settings, true, state.settings[singleWorkspaceId]);
        return state;
      }, options.dataDir);
      // Turning computer use off stops already-approved sessions now, not at their next approval.
      // Turning it on is possible through this API too (an agent can call it): that is not the
      // boundary. Every session still has to pass the native approval alert in the app.
      if (singleWorkspaceId && req.body?.settings != null && !isComputerUseAllowed(workspaceState, singleWorkspaceId)) computerBridge.revokeWorkspace(singleWorkspaceId);
      res.json(workspacesPayload());
    } catch (error) { errorResponse(res, error, workspaceNotFound(error) ? 404 : 400); }
  });
  app.post("/api/workspaces", async (req, res) => {
    try {
      const name = workspaceName(req.body?.name);
      if (req.body?.settings != null) normalizeWorkspacePolicy(req.body.settings, true);
      workspaceState = await mutateWorkspaceState((state) => {
        const id = newWorkspaceId(name, new Set(state.workspaces.map((item) => item.id)));
        state.workspaces.push({ id, name });
        // A new workspace starts from the current one's defaults (folder, allowed agents, team, ...) and settings.
        state.defaults[id] = structuredClone(state.defaults[state.currentWorkspaceId] ?? {});
        (state.settings ??= {})[id] = normalizeWorkspacePolicy(req.body?.settings, true, state.settings[state.currentWorkspaceId]);
        return state;
      }, options.dataDir);
      res.status(201).json(workspacesPayload());
    } catch (error) { errorResponse(res, error); }
  });
  app.patch("/api/workspaces/:id", async (req, res) => {
    try {
      const id = workspaceIdFormat(routeParam(req.params.id));
      const hasSettings = req.body?.settings != null;
      // Rename, update settings (merged onto the stored ones), or both.
      const name = req.body?.name == null && hasSettings ? undefined : workspaceName(req.body?.name);
      if (hasSettings) normalizeWorkspacePolicy(req.body.settings, true);
      workspaceState = await mutateWorkspaceState((state) => {
        const found = state.workspaces.find((item) => item.id === id);
        if (!found) throw new Error("워크스페이스를 찾을 수 없습니다.");
        if (name) found.name = name;
        if (hasSettings) (state.settings ??= {})[id] = normalizeWorkspacePolicy(req.body.settings, true, state.settings[id]);
        return state;
      }, options.dataDir);
      if (hasSettings && !isComputerUseAllowed(workspaceState, id)) computerBridge.revokeWorkspace(id);
      res.json(workspacesPayload());
    } catch (error) { errorResponse(res, error, workspaceNotFound(error) ? 404 : 400); }
  });
  app.delete("/api/workspaces/:id", async (req, res) => {
    const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
    try {
      const id = workspaceIdFormat(routeParam(req.params.id));
      const requestedMoveTo = req.query.moveTo == null || req.query.moveTo === "" ? undefined : workspaceIdFormat(req.query.moveTo);
      let moveTo = "";
      workspaceState = await mutateWorkspaceState(async (state) => {
        const index = state.workspaces.findIndex((item) => item.id === id);
        if (index < 0) throw new Error("워크스페이스를 찾을 수 없습니다.");
        if (state.workspaces.length === 1) throw conflict("마지막 워크스페이스는 삭제할 수 없습니다.");
        if (orchestra.list().some((session) => session.workspaceId === id && session.status === "running")) throw conflict("실행 중인 세션이 있는 워크스페이스는 삭제할 수 없습니다.");
        const remaining = state.workspaces.filter((item) => item.id !== id);
        moveTo = requestedMoveTo ?? remaining[0].id;
        if (!remaining.some((item) => item.id === moveTo)) throw new Error(requestedMoveTo === id ? "삭제할 워크스페이스로는 옮길 수 없습니다." : "옮길 워크스페이스를 찾을 수 없습니다.");
        // Move the contents before dropping the workspace so a failed write leaves nothing orphaned.
        await mutateGroups((groups) => { for (const group of groups) if (group.workspaceId === id) group.workspaceId = moveTo; }, options.dataDir);
        for (const session of orchestra.list()) if (session.workspaceId === id) orchestra.setWorkspace(session.id, moveTo, false);
        await persistSessions(orchestra.list());
        state.workspaces = remaining;
        delete state.defaults[id];
        delete state.settings?.[id];
        if (state.currentWorkspaceId === id) state.currentWorkspaceId = moveTo;
        return state;
      }, options.dataDir);
      broadcastGroups(await loadGroups(options.dataDir));
      await mutateToolSettings((settings) => { delete settings[id]; }, options.dataDir).catch(() => undefined);
      await notifications.clear(id).catch(() => undefined);
      res.json(workspacesPayload());
    } catch (error) {
      const status = (error as { status?: number })?.status ?? (workspaceNotFound(error) ? 404 : 400);
      errorResponse(res, error, status);
    }
  });

  registerOpenExternalRoute(app);
  registerPermissionRoutes(app, {
    broadcast: (payload) => { const message = JSON.stringify(payload); for (const client of openClients()) client.send(message); },
    onRequest: (request) => notify({ workspaceId: request.workspaceId, type: "permission", key: `permission:${request.id}`, title: `에이전트가 권한을 묻습니다: ${request.toolName}`, body: request.detail, action: { label: "세션 열기", sessionId: request.sessionId } }),
  });
  app.post("/api/sessions", async (req, res) => {
    try {
      const input = startInput(req.body, workspace, currentWorkspace());
      await assertMediaAvailable(input.prompt, input.workspaceId ?? currentWorkspace());
      if (input.groupId && !(await loadGroups(options.dataDir)).some((group) => group.id === input.groupId && group.workspaceId === input.workspaceId)) throw new Error("그룹을 찾을 수 없습니다.");
      res.status(201).json(await orchestra.create(input));
    }
    catch (error) { errorResponse(res, error); }
  });
  // Chat attachments and results, scoped to the session work folder (plus pasted/dropped uploads).
  registerSessionFileRoutes(app, {
    lookup: (id) => orchestra.get(id),
    extraRoots: () => [previewAssetsDir(options.dataDir)],
    previewRoot: () => previewAssetsDir(options.dataDir),
    cacheDir: () => join(options.dataDir ?? join(homedir(), ".sinawi"), "file-previews"),
  });
  registerLinkPreviewRoute(app);
  registerWorktreeRoutes(app, { orchestra, persist: () => persistSessions(orchestra.list()) });
  app.post("/api/sessions/:id/messages", async (req, res) => {
    try {
      const id = routeParam(req.params.id);
      const prompt = string(req.body?.prompt);
      const session = orchestra.get(id);
      if (session) await assertMediaAvailable(prompt, session.workspaceId);
      res.json(await orchestra.followup(id, prompt, ids(req.body?.skills), conversationSettings(req.body)));
    }
    catch (error) { errorResponse(res, error); }
  });
  app.post("/api/sessions/:id/live", async (req, res) => {
    try { res.json(await orchestra.liveTurn(routeParam(req.params.id), string(req.body?.prompt))); }
    catch (error) { errorResponse(res, error); }
  });
  app.post("/api/sessions/:id/live/promote", (req, res) => {
    try { res.json(orchestra.promoteLive(routeParam(req.params.id), string(req.body?.eventId, 200))); }
    catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.post("/api/sessions/:id/handoff/undo", async (req, res) => {
    try {
      const session = orchestra.undoHandoff(routeParam(req.params.id), string(req.body?.eventId, 500));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/sessions/:id/compact", async (req, res) => {
    try {
      const session = orchestra.compact(routeParam(req.params.id));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/sessions/:id/stop", (req, res) => {
    try { res.json(orchestra.stop(routeParam(req.params.id))); }
    catch (error) { errorResponse(res, error, 404); }
  });
  app.patch("/api/sessions/:id", async (req, res) => {
    try {
      const session = orchestra.rename(routeParam(req.params.id), string(req.body?.title, 100));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.get("/api/sessions/:id/steward", async (req, res) => {
    try {
      const session = orchestra.get(routeParam(req.params.id));
      if (!session?.steward) throw new Error("담당 채팅이 아닙니다.");
      const dir = orchestra.stewardDataDir;
      res.json({
        notes: dir ? await readNotes(dir, session.id) : "", transcript: dir ? transcriptPath(dir, session.id) : undefined,
        turns: session.steward.turns, rolloverAt: STEWARD_ROLLOVER_TURNS,
        name: stewardName(session), report: session.steward.report ?? null,
        peers: orchestra.list().filter((item) => item.steward && item.id !== session.id).map((item) => ({ id: item.id, name: stewardName(item), cwd: item.cwd })),
      });
    } catch (error) { errorResponse(res, error, 404); }
  });
  app.patch("/api/sessions/:id/steward", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new Error("담당 설정이 올바르지 않습니다.");
      if (body.name !== undefined && typeof body.name !== "string") throw new Error("담당 이름이 올바르지 않습니다.");
      const report = body.report === null || body.report === "" ? null : body.report === undefined ? undefined : reportTime(body.report);
      if (report === undefined && body.report !== undefined) throw new Error("보고 시각은 HH:MM 형식이어야 합니다.");
      if (body.enabled === undefined && body.name === undefined && body.report === undefined) throw new Error("담당 설정이 올바르지 않습니다.");
      const session = orchestra.updateSteward(routeParam(req.params.id), { enabled: body.enabled, name: body.name, report });
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.patch("/api/sessions/:id/auto-switch", async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") throw new Error("자동 전환 설정이 올바르지 않습니다.");
      const session = orchestra.setAutoSwitch(routeParam(req.params.id), req.body.enabled);
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.patch("/api/sessions/:id/team", async (req, res) => {
    try {
      const session = orchestra.updateTeam(routeParam(req.params.id), teamInput(req.body));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) {
      const status = error instanceof Error && error.message === "세션을 찾을 수 없습니다."
        ? 404
        : error instanceof Error && error.message === "실행 중에는 팀을 변경할 수 없습니다."
          ? 409
          : 400;
      errorResponse(res, error, status);
    }
  });
  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      // Worktrees are kept unless asked; cleanup never drops uncommitted changes or branches with commits.
      const target = orchestra.get(routeParam(req.params.id));
      if (target?.status === "running") throw new Error("실행 중인 세션은 삭제할 수 없습니다.");
      const cleanup = req.query.worktrees === "remove" && target?.worktrees?.length ? await cleanupSessionWorktrees(target.worktrees) : undefined;
      orchestra.remove(routeParam(req.params.id));
      await persistSessions(orchestra.list());
      if (cleanup) res.json(cleanup);
      else res.status(204).end();
    } catch (error) {
      const status = error instanceof Error && error.message === "세션을 찾을 수 없습니다."
        ? 404
        : error instanceof Error && error.message === "실행 중인 세션은 삭제할 수 없습니다."
          ? 409
          : 400;
      errorResponse(res, error, status);
    }
  });
  app.delete("/api/sessions/:id/workers/:workerId", async (req, res) => {
    try {
      const session = orchestra.removeWorker(routeParam(req.params.id), string(req.params.workerId, 100));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && /찾을 수 없습니다/.test(error.message) ? 404 : 400); }
  });
  app.patch("/api/sessions/:id/group", async (req, res) => {
    try {
      const groupId = req.body?.groupId == null ? undefined : string(req.body.groupId, 500);
      const current = orchestra.get(routeParam(req.params.id));
      if (!current) throw new Error("세션을 찾을 수 없습니다.");
      if (groupId && !(await loadGroups(options.dataDir)).some((group) => group.id === groupId && group.workspaceId === current.workspaceId)) throw new Error("그룹을 찾을 수 없습니다.");
      const session = orchestra.setGroup(routeParam(req.params.id), groupId);
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && /찾을 수 없습니다/.test(error.message) ? 404 : 400); }
  });
  app.patch("/api/sessions/:id/workspace", async (req, res) => {
    try {
      const session = orchestra.setWorkspace(routeParam(req.params.id), workspace(req.body?.workspaceId));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && /찾을 수 없습니다/.test(error.message) ? 404 : 400); }
  });

  app.get("/api/files", async (req, res) => {
    try {
      const cwd = req.query.cwd == null ? process.cwd() : resolve(string(req.query.cwd, 4_096));
      const query = req.query.q == null ? "" : typeof req.query.q === "string" && req.query.q.length <= 4_096 ? req.query.q : undefined;
      if (query === undefined) throw new Error("파일 검색어가 올바르지 않습니다.");
      res.json({ files: await discoverFiles(cwd, query) });
    } catch (error) { errorResponse(res, error); }
  });

  app.get("/api/directories", async (req, res) => {
    try {
      const raw = typeof req.query.path === "string" ? req.query.path : homedir();
      const path = resolve(raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw);
      if (!(await stat(path)).isDirectory()) throw new Error("폴더를 찾을 수 없습니다.");
      const entries = await readdir(path, { withFileTypes: true });
      const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => resolve(path, entry.name)).sort((a, b) => a.localeCompare(b)).slice(0, 500);
      res.json({ path, parent: dirname(path), directories });
    } catch (error) { errorResponse(res, error, 404); }
  });
  app.post("/api/directories/pick", async (_req, res) => {
    try { res.json({ path: await pickDirectory(options.folderRunner) }); }
    catch (error) { errorResponse(res, error, 500); }
  });

  app.get("/api/groups", async (req, res) => {
    try {
      const workspaceId = queryWorkspace(req.query.workspace);
      const groups = await loadGroups(options.dataDir);
      res.json(workspaceId ? groups.filter((group) => group.workspaceId === workspaceId) : groups);
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/groups", async (req, res) => {
    try {
      const name = string(req.body?.name, 100);
      const workspaceId = workspace(req.body?.workspaceId, currentWorkspace());
      const group: Group = { id: randomUUID(), name, createdAt: new Date().toISOString(), workspaceId };
      await mutateGroups((groups) => {
        if (groups.some((item) => item.workspaceId === workspaceId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("같은 이름의 그룹이 이미 있습니다.");
        groups.push(group);
      }, options.dataDir);
      broadcastGroups(await loadGroups(options.dataDir));
      res.status(201).json(group);
    } catch (error) { errorResponse(res, error); }
  });
  app.patch("/api/groups/:id", async (req, res) => {
    try {
      const id = routeParam(req.params.id);
      const name = string(req.body?.name, 100);
      const group = await mutateGroups((groups) => {
        const found = groups.find((item) => item.id === id);
        if (!found) throw new Error("그룹을 찾을 수 없습니다.");
        if (groups.some((item) => item.id !== id && item.workspaceId === found.workspaceId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("같은 이름의 그룹이 이미 있습니다.");
        found.name = name;
        return found;
      }, options.dataDir);
      broadcastGroups(await loadGroups(options.dataDir));
      res.json(group);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "그룹을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.patch("/api/groups/:id/workspace", async (req, res) => {
    const affected: Array<{ id: string; workspaceId: WorkspaceId }> = [];
    let previousGroupWorkspace: WorkspaceId | undefined;
    try {
      const id = routeParam(req.params.id);
      const workspaceId = workspace(req.body?.workspaceId);
      const group = await mutateGroups((groups) => {
        const found = groups.find((item) => item.id === id);
        if (!found) throw new Error("그룹을 찾을 수 없습니다.");
        previousGroupWorkspace = found.workspaceId;
        found.workspaceId = workspaceId;
        return found;
      }, options.dataDir);
      for (const session of orchestra.list()) if (session.groupId === id) {
        affected.push({ id: session.id, workspaceId: session.workspaceId });
        orchestra.setWorkspace(session.id, workspaceId, false);
      }
      await persistSessions(orchestra.list());
      broadcastGroups(await loadGroups(options.dataDir));
      res.json(group);
    } catch (error) {
      if (previousGroupWorkspace) {
        await mutateGroups((groups) => {
          const found = groups.find((item) => item.id === routeParam(req.params.id));
          if (found) found.workspaceId = previousGroupWorkspace!;
        }, options.dataDir).catch(() => undefined);
        for (const session of affected) orchestra.setWorkspace(session.id, session.workspaceId, false);
        await persistSessions(orchestra.list()).catch(() => undefined);
      }
      errorResponse(res, error, error instanceof Error && error.message === "그룹을 찾을 수 없습니다." ? 404 : 400);
    }
  });
  app.delete("/api/groups/:id", async (req, res) => {
    try {
      const id = routeParam(req.params.id);
      await mutateGroups((groups) => {
        const index = groups.findIndex((item) => item.id === id);
        if (index < 0) throw new Error("그룹을 찾을 수 없습니다.");
        groups.splice(index, 1);
      }, options.dataDir);
      for (const session of orchestra.list()) if (session.groupId === id) orchestra.setGroup(session.id);
      await persistSessions(orchestra.list());
      broadcastGroups(await loadGroups(options.dataDir));
      res.status(204).end();
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "그룹을 찾을 수 없습니다." ? 404 : 400); }
  });

  app.post("/api/bots", async (req, res) => {
    try {
      const bot: Bot = { id: randomUUID(), name: string(req.body?.name, 100), agent: agent(req.body?.agent), model: optionalString(req.body?.model, 200), skills: ids(req.body?.skills), systemPrompt: optionalString(req.body?.systemPrompt, 50_000) ?? "", createdAt: new Date().toISOString() };
      await mutateBots((bots) => { bots.push(bot); }, options.dataDir);
      res.status(201).json(bot);
    } catch (error) { errorResponse(res, error); }
  });
  app.delete("/api/bots/:id", async (req, res) => {
    try {
      const id = routeParam(req.params.id);
      await mutateBots((bots) => {
        const index = bots.findIndex((bot) => bot.id === id);
        if (index < 0) throw new Error("봇을 찾을 수 없습니다.");
        bots.splice(index, 1);
      }, options.dataDir);
      res.status(204).end();
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "봇을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.post("/api/conversations", async (req, res) => {
    try {
      const requestedTurns = Number(req.body?.turns);
      if (!Number.isFinite(requestedTurns) || !Number.isInteger(requestedTurns)) throw new Error("대화 턴 수는 정수여야 합니다.");
      const input: ConversationInput = { botA: string(req.body?.botA, 100), botB: string(req.body?.botB, 100), turns: Math.min(Math.max(requestedTurns, 1), 20), prompt: string(req.body?.prompt), cwd: string(req.body?.cwd, 4_096), workspaceId: workspace(req.body?.workspaceId, currentWorkspace()) };
      res.status(201).json(await orchestra.conversation(input, await loadBots(options.dataDir)));
    } catch (error) { errorResponse(res, error); }
  });
  const sendHealth = (_req: Request, res: Response) => res.json({ ok: true, app: "sinawi", mode: options.staticDir ? "production" : "development", running: orchestra.list().filter((session) => session.status === "running").length, version: envVar("SERVER_VERSION") ?? "", windows: [...websocket.clients].filter((client) => client.readyState === WebSocket.OPEN).length });
  app.get("/api/health", sendHealth);
  app.get("/health", sendHealth);
  // Unknown API routes must never become a successful HTML response.
  app.use("/api", (_req, res) => res.status(404).json({ error: "API를 찾을 수 없습니다." }));
  if (options.staticDir) {
    const staticDir = resolve(options.staticDir);
    const contentSecurityPolicy = appContentSecurityPolicy();
    app.use(localGuard);
    app.use((_req, res, next) => { res.setHeader("Content-Security-Policy", contentSecurityPolicy); next(); });
    app.use(express.static(staticDir, { index: "index.html" }));
    app.get("/{*path}", (req, res, next) => {
      if (req.path === "/ws" || /\.[^/]+$/.test(req.path) || !req.accepts("html")) return next();
      res.sendFile(resolve(staticDir, "index.html"));
    });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    if (terminal.handleUpgrade(request, socket, head)) return;
    if (request.url !== "/ws" || !isLoopbackHost(request.headers.host) || !isLocalOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
  });
  websocket.on("connection", async (client) => {
    await ready;
    const sessions = orchestra.list();
    client.send(JSON.stringify({ type: "sessions", sessions }));
    deliveredEvents.set(client, new Map(sessions.flatMap((session) => {
      const latest = session.events.at(-1)?.id;
      return latest ? [[session.id, latest] as const] : [];
    })));
  });

  const flushSessions = () => persistAllSessions(orchestra.list());
  return { app, httpServer, websocket, orchestra, terminal, notifications, browserBridge, flushSessions };
}
