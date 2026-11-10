import { installAccountSkills } from "./account-tooling.js";
import { previewAssetsDir, registerPreviewRoutes } from "./preview.js";
import { registerSetupRoutes, SETUP_TOOLS } from "./setup.js";
import { BrowserBridge, QUEUE_DIR, registerBrowserRoutes, watchQueue } from "./browser-bridge.js";
import { ComputerBridge, registerComputerRoutes, SHOT_DIR, watchComputerQueue, type ComputerHint } from "./computer-bridge.js";
import { findTool, handleToolMcp, nameLookup, routeDispatcher, type ToolContext, type ToolSurface } from "./app-tools.js";
import { withJosa } from "./korean.js";
import { ApprovalStore, approvalRequester, type AppApproval, type ApprovalStatus } from "./app-approvals.js";
import { APP_MCP_SERVER, appMcpTokenPath, clientConfig, connectEntry, ensureAppMcpToken, scriptClientConfig, installAppMcpScript, presentedToken, rotateAppMcpToken, tokenMatches } from "./app-mcp.js";
import { LEAD_MCP_SERVER } from "./lead-tools.js";
import { loadSchedules, saveSchedules, type ScheduleInput } from "./schedules.js";
import { isComputerUseAllowed } from "./workspace-policy.js";
import { computerContextForToken, computerDir, pruneComputerTokens, resolveComputerToken } from "./computer-tokens.js";
import { DevServerManager, devServerEnv } from "./dev-servers.js";
import { registerOpenExternalRoute } from "./open-external.js";
import { registerPermissionRoutes, touchRunActivity } from "./permission-prompts.js";
import { registerServeRoutes, watchServeQueue } from "./serve-tool.js";
import { registerSimRoutes, watchSimQueue } from "./sim-tool.js";
import { registerSimViewRoutes } from "./sim-view.js";
import { cliChildEnv } from "./supervision.js";
import { fullPath } from "./cli-path.js";
import { dataDirFor, envVar } from "./runtime.js";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { NotificationStore } from "./notifications.js";
import { mcpAuthTitle, mcpDisplayName } from "./tools.js";
import { authNotification, sessionNotifications } from "./notification-sources.js";
import type { NotificationInput, NotificationType } from "./notification-types.js";
import { createTerminalService } from "./terminal.js";
import { appContentSecurityPolicy, isAllowedOrigin } from "./origin-policy.js";
import { applyMcpClient, isMcpClient, McpClientConfigError, planMcpClient } from "./mcp-clients.js";
import { commandAvailable, runCli } from "./cli.js";
import { recommendAutoSwitch } from "./auto-routing.js";
import { mediaRouteRequired, mediaUnavailableMessage } from "./media-routing.js";
import { accountDirFor, accountLoginCommand, allowedAgentsForWorkspace, assertMediaAllowed, blockedToolMessage, defaultWorkspacePolicy, isToolLocked, lockedToolsFor, normalizeWorkspacePolicy, policyDenyPatterns, WorkspacePolicyError, type WorkspacePolicyResolver } from "./workspace-policy.js";
import { loadUsage } from "./usage.js";
import { loadProviderQuotas } from "./quota.js";
import { exhaustionFromQuota } from "./quota-fallback.js";
import { createQuotaFallbackRunner } from "./router-fallback.js";
import { Orchestra } from "./orchestra.js";
import { discoverFiles } from "./files.js";
import { enabledPublicSkills, publicSkills } from "./skills.js";
import { RoutingService, type ModelCommandRunner, type PlannerRunner } from "./routing.js";
import { workspaceIdPattern, createCoalescedSaver, loadBots, loadGroups, loadSessions, loadStewards, loadToolSettings, loadWorkspaceState, workspaceToolSettings, mutateBots, mutateGroups, mutateToolSettings, mutateWorkspaceState, saveSessions, saveStewards } from "./store.js";
import { discoverMcpTools, updateMcpTool, type ToolCommandRunner } from "./tools.js";
import type { AgentId, AgentSelection, Bot, ConversationInput, ConversationSettings, Group, Session, SessionDraft, StartSessionInput, UpdateTeamInput, WorkspaceDefaults, WorkspaceId, WorkspaceState } from "./types.js";
import { randomUUID } from "node:crypto";
import { registerSessionFileRoutes } from "./session-files.js";
import { registerLinkPreviewRoute } from "./link-preview.js";
import { registerWorktreeRoutes } from "./worktree-routes.js";
import { cleanupSessionWorktrees } from "./worktrees.js";
import { isMergePolicy, LEGACY_MERGE_POLICY, readNotes, readUserPreferences, reportTime, saveNotes, saveUserPreferences, STEWARD_ROLLOVER_TURNS, stewardName, stewardNotesId, transcriptPath, USER_PREFERENCES_LIMIT, type StewardPatch } from "./steward.js";
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

/** Schedule fields from a request body; schedules.ts checks the values. */
function scheduleInput(body: any): ScheduleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("일정 값이 올바르지 않습니다.");
  const out: ScheduleInput = {};
  for (const key of ["title", "prompt", "at", "cron", "timezone"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== "string") throw new Error(`일정 ${key} 값이 올바르지 않습니다.`);
    out[key] = body[key] ?? "";
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("일정 enabled 값이 올바르지 않습니다.");
    out.enabled = body.enabled;
  }
  return out;
}

export function startInput(body: any, workspace: WorkspaceResolver, fallbackWorkspace: WorkspaceId): StartSessionInput {
  return {
    ...conversationSettings(body),
    // A new thread of a lead may leave the team out: Orchestra.create fills it from the lead (or the workspace).
    // No prompt opens an empty chat (Orchestra.create); the first message comes later as a follow-up.
    prompt: body?.prompt == null || body.prompt === "" ? "" : string(body.prompt),
    ...(body?.title == null || body.title === "" ? {} : { title: string(body.title, 100) }),
    // Left out: the lead's agent, else the workspace's default (filled in the route and Orchestra.create).
    agent: body?.agent == null || body.agent === "" ? undefined as unknown as AgentId : agent(body.agent),
    // A new thread of a lead may leave the folder out: it opens in the lead's (Orchestra.create).
    workers: agents(body?.workers, 3), cwd: body?.steward?.id && (body?.cwd == null || body.cwd === "") ? "" : string(body?.cwd, 4_096),
    model: optionalString(body?.model, 200), reasoningEffort: optionalReasoningEffort(body?.reasoningEffort),
    workerConfigs: agentSelections(body?.workerConfigs), planner: body?.planner == null ? undefined : agentSelection(body.planner),
    skills: ids(body?.skills),
    systemPrompt: optionalString(body?.systemPrompt, 50_000), resumeSessionId: optionalString(body?.resumeSessionId, 500),
    groupId: optionalString(body?.groupId, 500),
    workspaceId: workspace(body?.workspaceId, fallbackWorkspace),
    // A commander's goal sessions are started by the app (parentId), never from a request.
    ...(body?.commander === true ? { commander: true } : body?.goal === true ? { goal: true } : {}),
    ...(body?.steward === true || body?.steward && typeof body.steward === "object" ? { steward: { name: optionalString(body.steward?.name, 80), ...(body.steward?.id ? { id: string(body.steward.id, 100) } : {}) } } : {}),
  };
}

/**
 * A chat asked for without workers (or a lead agent): the workspace's default team, else every
 * agent it allows. A lead's own team still wins in Orchestra.create, so only the gaps are filled.
 */
export function withWorkspaceTeam(input: StartSessionInput, defaults: WorkspaceDefaults, allowed: AgentId[]): StartSessionInput {
  if (input.workers?.length && input.agent) return input;
  const usable = (list: AgentId[] | undefined) => (list ?? []).filter((id) => allowed.includes(id));
  const workers = input.workers?.length ? input.workers : usable(defaults.workers).length ? usable(defaults.workers) : [...allowed];
  // The default team's own worker settings only fit when the workers are that team's.
  const workerConfigs = input.workers?.length || input.workerConfigs?.length ? input.workerConfigs
    : defaults.workerConfigs?.length && usable(defaults.workers).length === (defaults.workers?.length ?? 0) ? structuredClone(defaults.workerConfigs) : undefined;
  // A lead's thread keeps its gap for the lead's agent (Orchestra.create).
  const agentId = input.agent || (input.steward?.id ? input.agent : usable(defaults.agent ? [defaults.agent] : [])[0] ?? (allowed.includes("claude") ? "claude" : allowed[0]));
  return { ...input, agent: agentId, workers, ...(workerConfigs ? { workerConfigs } : {}) };
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

/** A Steward's fields from a request; only the ones sent. `create` requires the name. */
export function stewardInput(body: any, create = false): StewardPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("담당 설정이 올바르지 않습니다.");
  if (body.mergePolicy !== undefined && !isMergePolicy(body.mergePolicy)) throw new Error("병합 정책은 auto, ask, never 중 하나여야 합니다.");
  if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") throw new Error("담당 지침이 올바르지 않습니다.");
  if (typeof body.systemPrompt === "string" && body.systemPrompt.length > 50_000) throw new Error("담당 지침이 너무 깁니다.");
  const patch: StewardPatch = {
    ...(create || body.name !== undefined ? { name: string(body.name, 80) } : {}),
    ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt.trim() } : {}),
    ...(body.skills !== undefined ? { skills: ids(body.skills) } : {}),
    ...(body.agent !== undefined ? { agent: agent(body.agent) } : {}),
    ...(body.model !== undefined ? { model: optionalString(body.model, 200) ?? "" } : {}),
    ...(body.reasoningEffort !== undefined ? { reasoningEffort: optionalReasoningEffort(body.reasoningEffort) ?? "" } : {}),
    ...(body.workers !== undefined ? { workers: agentSelections(body.workers) } : {}),
    ...(body.mergePolicy !== undefined ? { mergePolicy: body.mergePolicy } : {}),
    ...(body.cwds !== undefined ? { cwds: ids(body.cwds, 20).map((cwd) => resolve(string(cwd, 4_096))) } : {}),
  };
  if (!create && !Object.keys(patch).length && body.notes === undefined && body.report === undefined && (body.workspaceId == null || body.workspaceId === "")) throw new Error("담당 설정이 올바르지 않습니다.");
  return patch;
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

/** Gives every planner run the CLI account its workspace keeps for the run's agent (CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME). */
export function withWorkspaceAccounts(runner: PlannerRunner, policyFor?: WorkspacePolicyResolver): PlannerRunner {
  return (options) => {
    const workspaceId = options.usageContext?.workspaceId;
    const accountDir = options.accountDir ?? (workspaceId ? accountDirFor(policyFor?.(workspaceId), options.agent) : undefined);
    return runner(accountDir ? { ...options, accountDir } : options);
  };
}

export function createServer(options: { staticDir?: string; folderRunner?: FolderRunner; dataDir?: string; routingRunner?: PlannerRunner; limitsRunner?: typeof runCli; routingSkillLoader?: typeof publicSkills; toolSkillLoader?: typeof publicSkills; toolRunner?: ToolCommandRunner; codexConfigPath?: string; availableAgents?: AgentId[]; availabilityLoader?: () => Promise<AgentId[]>; modelRunner?: ModelCommandRunner; modelHomeDir?: string; sessionSaver?: typeof saveSessions; sessionSaveDelayMs?: number; inactivityTimeoutMs?: number; worktrees?: boolean; authDiscovery?: { sleep?: (ms: number) => Promise<void> }; browserQueue?: boolean; appMcp?: boolean } = {}) {
  const app = express();
  app.disable("x-powered-by");
  const smallJson = express.json({ limit: "1mb" });
  const largeJson = express.json({ limit: "40mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/preview/assets/raw") { next(); return; }
    return ((req.path === "/api/preview/assets" || req.path === "/api/browser/result") ? largeJson : smallJson)(req, res, next);
  });
  const httpServer = createHttpServer(app);
  // Each subsystem below stops itself on close (bridges, queues, timers): more than Node's default of 10 listeners.
  httpServer.setMaxListeners(40);
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
    for (const note of sessionNotifications(session, workspaceState.settings?.[session.workspaceId]?.accounts)) {
      const seen = note.type === "run-finished" || note.type === "lead" ? completedRuns : observedEvents;
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
    const quotas = await loadProviderQuotas(options.dataDir, options.modelHomeDir, policyFor(workspaceId).accounts);
    const eligible = agents.filter((id) => !exhaustionFromQuota(quotas.find((quota) => quota.agent === id), defaults.quotaThreshold ?? 3).exhausted);
    return eligible;
  };
  const fallbackContext = async (workspaceId: WorkspaceId) => {
    await modelsReady;
    const defaults = workspaceState.defaults[workspaceId] ?? {};
    const settings = await routing.loadSettings(policyFor(workspaceId).accounts);
    const available = await getAvailableAgents();
    const authenticated = available.filter((id) => settings.modelOptions[id].authStatus !== "unauthenticated");
    return { enabled: defaults.quotaFallback !== false, threshold: defaults.quotaThreshold ?? 3,
      order: defaults.fallbackOrder, quotas: await loadProviderQuotas(options.dataDir, options.modelHomeDir, policyFor(workspaceId).accounts),
      authenticated, authenticatedAgents: authenticated, allowedAgents: allowedFor(workspaceId) };
  };
  const routingRunner = createQuotaFallbackRunner(withWorkspaceAccounts(withWorkspaceMcpBlocks(options.routingRunner ?? runCli, options.dataDir, policyFor), policyFor), fallbackContext);
  const orchestra = new Orchestra(broadcast, undefined, scheduleSessions, broadcastRemoval, async (session, prompt, signal) => {
    await modelsReady;
    const settings = await routing.loadSettings(policyFor(session.workspaceId).accounts);
    const candidates = (await getAvailableAgents()).filter((id) => allowedFor(session.workspaceId).includes(id));
    return recommendAutoSwitch(prompt, session.cwd, settings, await quotaAwareAgents(candidates, session.workspaceId), routingRunner, signal, { workspaceId: session.workspaceId, sessionId: session.id, role: "router", dataDir: options.dataDir }, undefined, policyFor(session.workspaceId).mediaGeneration);
  }, allowedFor, options.dataDir, (session) => fallbackContext(session.workspaceId),
  (prompt) => routing.loadSettings().then((settings) => mediaRouteRequired(prompt, settings.rules)), options.inactivityTimeoutMs, policyFor);
  // Per-worker git worktrees (server/worktrees.ts). Opt-in so tests and embedders never create branches.
  if (options.worktrees) orchestra.worktreeDataDir = options.dataDir ?? join(homedir(), ".sinawi");
  // Leads' notes, transcripts and the user's preferences live in the data folder the stores use
  // (SINAWI_DATA_DIR when set), never in ~/.sinawi behind a custom one's back.
  orchestra.stewardDataDir = dataDirFor(options.dataDir);
  // Leads' daily reports: checked every minute, and once shortly after start for a report missed while closed.
  const stewardTimer = setInterval(() => void orchestra.stewardTick().catch(() => undefined), 60_000);
  stewardTimer.unref();
  setTimeout(() => void orchestra.stewardTick().catch(() => undefined), 15_000).unref();
  const routing = new RoutingService({ dataDir: options.dataDir, runner: routingRunner, skillLoader: options.routingSkillLoader, modelRunner: options.modelRunner, homeDir: options.modelHomeDir, authDiscovery: options.authDiscovery });
  const getAvailableAgents = async () => {
    if (Array.isArray(options.availableAgents)) return [...new Set(options.availableAgents)];
    if (options.availabilityLoader) return [...new Set(await options.availabilityLoader())];
    const ids = ["codex", "claude", "grok"] as AgentId[];
    const availability = await Promise.all(ids.map(commandAvailable));
    return ids.filter((_id, index) => availability[index]);
  };
  orchestra.workerReadiness = async (session, agent) => {
    const setup = SETUP_TOOLS.find((tool) => tool.id === agent)!;
    const installed = (await getAvailableAgents()).includes(agent);
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        detail: `${setup.name} CLI가 설치되어 있지 않아 워커를 추가하지 않았습니다. 설정에서 설치하거나 터미널에서 ${setup.install} 명령을 실행한 뒤 다시 시도하세요.`,
      };
    }
    await modelsReady;
    const option = (await routing.refreshModels(policyFor(session.workspaceId).accounts)).modelOptions[agent];
    if (option.authStatus !== "authenticated") {
      return {
        installed: true,
        authenticated: false,
        detail: `${option.authDetail ?? `${setup.name} 로그인 상태를 확인할 수 없습니다.`} 워커를 추가하지 않았습니다. 터미널에서 ${setup.login} 명령을 실행한 뒤 다시 시도하세요.`,
      };
    }
    return { installed: true, authenticated: true, detail: `${setup.name} CLI 준비됨` };
  };
  orchestra.persistStewards = (stewards) => saveStewards(stewards, options.dataDir);
  const schedulesDir = dataDirFor(options.dataDir);
  orchestra.persistSchedules = (schedules) => saveSchedules(schedulesDir, schedules);
  const ready = Promise.all([loadSessions(options.dataDir), loadWorkspaceState(options.dataDir), loadStewards(options.dataDir), loadSchedules(schedulesDir)]).then(async ([sessions, state, stewards, schedules]) => {
    workspaceState = state;
    for (const [workspaceId, policy] of Object.entries(state.settings ?? {})) {
      try {
        await installAccountSkills(policy.accounts);
        await notifications.resolve(workspaceId, "account-skills");
      }
      catch (error) {
        await notifications.add({ workspaceId, key: "account-skills", type: "error", title: "계정 폴더 스킬 설치 실패", body: error instanceof Error ? error.message : String(error) });
      }
    }
    await recoverStaleSessions(sessions, persistAllSessions);
    // Lead chats saved before leads were entities get one here (Orchestra.restore).
    orchestra.restore(sessions, stewards, { legacyMergePolicy: state.stewardSettings?.legacyMergePolicy, defaultWorkspaceId: state.workspaces[0]?.id ?? state.currentWorkspaceId });
    // Missed while the app was off: the first stewardTick runs or skips them (MISSED_GRACE_MS).
    orchestra.restoreSchedules(schedules);
  });
  // Start discovery even when settings were saved by an earlier app version.
  // Settings errors remain visible through the API without blocking session recovery.
  const syncAuthNotifications = async () => {
    for (const { id: workspaceId } of workspaceState.workspaces) {
      const settings = await routing.loadSettings(policyFor(workspaceId).accounts);
      for (const id of agentIds) {
        const option = settings.modelOptions[id];
        const note = allowedFor(workspaceId).includes(id) ? authNotification(workspaceId, id, option.authStatus, option.authDetail, accountDirFor(policyFor(workspaceId), id)) : undefined;
        if (note) await notifications.add(note);
        else if (option.authStatus === "authenticated" || !allowedFor(workspaceId).includes(id)) await notifications.resolve(workspaceId, `auth:${id}`);
      }
    }
  };
  const refreshAllModels = async () => {
    await ready;
    const refreshed = new Set<string>();
    for (const { id } of workspaceState.workspaces) {
      const accounts = policyFor(id).accounts;
      const key = JSON.stringify([accounts?.claude, accounts?.codex, accounts?.grok]);
      if (refreshed.has(key)) continue;
      await routing.refreshModels(accounts);
      refreshed.add(key);
    }
    await syncAuthNotifications();
    return routing.loadSettings(policyFor(currentWorkspace()).accounts);
  };
  const modelsReady = refreshAllModels().then(() => undefined, () => undefined);
  let authRefresh: Promise<unknown> | undefined;
  let lastFocusRefresh = 0;
  const refreshAuth = () => {
    if (!authRefresh) authRefresh = refreshAllModels().finally(() => { authRefresh = undefined; });
    return authRefresh;
  };
  const authInterval = setInterval(() => { void refreshAuth().catch(() => undefined); }, 5 * 60_000);
  authInterval.unref();
  httpServer.once("close", () => { clearInterval(authInterval); terminal.close(); });
  websocket.once("close", () => { clearInterval(authInterval); terminal.close(); });
  const assertMediaAvailable = async (prompt: string, workspaceId: WorkspaceId) => {
    await modelsReady;
    const settings = await routing.loadSettings(policyFor(workspaceId).accounts);
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
        // The current workspace's Claude login, whose limits the app shows.
        ...(accountDirFor(limitsPolicy, "claude") ? { accountDir: accountDirFor(limitsPolicy, "claude") } : {}),
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
  // Sinawi does not mirror the simulator: `ao-sim launch` changes nothing in the app window.
  const simOptions = {};
  registerSimRoutes(app, simOptions);
  registerSimViewRoutes(app);
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
      if (!["auth", "quota", "permission", "run-finished", "lead", "error", "info"].includes(type)) throw new Error("알림 종류가 올바르지 않습니다.");
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
      res.json({ agents, skills: await enabledPublicSkills(undefined, false, disabled, workspaceId ? policyFor(workspaceId).accounts : undefined), bots: await loadBots(options.dataDir), groups: workspaceId ? groups.filter((group) => group.workspaceId === workspaceId) : groups, defaultCwd, homeCwd: homedir() });
    } catch (error) { errorResponse(res, error, 500); }
  });

  app.get("/api/skills", async (req, res) => {
    try {
      const cwd = req.query.cwd === undefined ? process.cwd() : resolve(string(req.query.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const workspaceId = toolsWorkspace(req.query.workspace);
      const disabled = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId).disabledSkills;
      res.json(await enabledPublicSkills(cwd, false, disabled, policyFor(workspaceId).accounts));
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/skills/refresh", async (req, res) => {
    try {
      const cwd = resolve(string(req.body?.cwd, 4_096));
      if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
      const workspaceId = toolsWorkspace(req.body?.workspace);
      const disabled = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId).disabledSkills;
      res.json(await enabledPublicSkills(cwd, true, disabled, policyFor(workspaceId).accounts));
    } catch (error) { errorResponse(res, error); }
  });

  const toolsPayload = async (workspaceId: WorkspaceId, cwd = process.cwd()) => {
    const settings = workspaceToolSettings(await loadToolSettings(options.dataDir), workspaceId);
    const skillLoader = options.toolSkillLoader ?? publicSkills;
    const skills = await skillLoader(cwd, false, policyFor(workspaceId).accounts);
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
      await updateMcpTool({ agent: id, name, enabled: req.body.enabled }, { runner: options.toolRunner, codexConfigPath: options.codexConfigPath, accounts: policyFor(workspaceId).accounts });
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

  app.get("/api/settings", async (req, res) => {
    try { await modelsReady; res.json(await routing.loadSettings(policyFor(toolsWorkspace(req.query.workspace ?? req.body?.workspaceId)).accounts)); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.put("/api/settings", async (req, res) => {
    try { await modelsReady; res.json(await routing.saveSettings(req.body, policyFor(toolsWorkspace(req.query.workspace ?? req.body?.workspaceId)).accounts)); }
    catch (error) { errorResponse(res, error); }
  });
  app.post("/api/settings/models/refresh", async (req, res) => {
    try {
      await modelsReady;
      const focus = req.body?.reason === "focus";
      if (focus && Date.now() - lastFocusRefresh < 60_000) { res.json(await routing.loadSettings(policyFor(toolsWorkspace(req.query.workspace ?? req.body?.workspaceId)).accounts)); return; }
      if (focus) lastFocusRefresh = Date.now();
      await refreshAuth();
      res.json(await routing.loadSettings(policyFor(toolsWorkspace(req.query.workspace ?? req.body?.workspaceId)).accounts));
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

  // Limits of the CLI logins a workspace uses (`?workspace=`, else the current one): its own accounts, else the default logins.
  app.get("/api/limits", async (req, res) => {
    try { res.json({ providers: await loadProviderQuotas(options.dataDir, options.modelHomeDir, policyFor(toolsWorkspace(req.query.workspace)).accounts) }); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.post("/api/limits/refresh", async (req, res) => {
    try {
      await refreshClaudeLimits();
      res.json({ providers: await loadProviderQuotas(options.dataDir, options.modelHomeDir, policyFor(toolsWorkspace(req.query.workspace)).accounts) });
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
      workspaceState = await mutateWorkspaceState(async (state) => {
        const known = new Set(state.workspaces.map((item) => item.id));
        for (const id of [currentWorkspaceId, singleWorkspaceId, ...Object.keys(defaultsByWorkspace ?? {})]) if (id && !known.has(id)) throw new Error("워크스페이스를 찾을 수 없습니다.");
        if (currentWorkspaceId) state.currentWorkspaceId = currentWorkspaceId;
        if (defaultsByWorkspace) Object.assign(state.defaults, defaultsByWorkspace);
        if (singleWorkspaceId && singleDefaults) state.defaults[singleWorkspaceId] = singleDefaults;
        if (singleWorkspaceId && req.body?.settings != null) {
          const policy = normalizeWorkspacePolicy(req.body.settings, true, state.settings?.[singleWorkspaceId]);
          if (req.body.settings.accounts !== undefined) await installAccountSkills(policy.accounts);
          (state.settings ??= {})[singleWorkspaceId] = policy;
        }
        return state;
      }, options.dataDir);
      if (singleWorkspaceId && req.body?.settings?.accounts !== undefined) {
        await notifications.resolve(singleWorkspaceId, "account-skills");
        await routing.refreshModels(policyFor(singleWorkspaceId).accounts);
        await syncAuthNotifications();
      }
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
      workspaceState = await mutateWorkspaceState(async (state) => {
        const id = newWorkspaceId(name, new Set(state.workspaces.map((item) => item.id)));
        const policy = normalizeWorkspacePolicy(req.body?.settings, true, state.settings?.[state.currentWorkspaceId]);
        await installAccountSkills(policy.accounts);
        state.workspaces.push({ id, name });
        // A new workspace starts from the current one's defaults (folder, allowed agents, team, ...) and settings.
        state.defaults[id] = structuredClone(state.defaults[state.currentWorkspaceId] ?? {});
        (state.settings ??= {})[id] = policy;
        return state;
      }, options.dataDir);
      await refreshAllModels();
      res.status(201).json(workspacesPayload());
    } catch (error) { errorResponse(res, error); }
  });
  // User-triggered login: select the folder here, then let the existing terminal run the official CLI.
  app.post("/api/workspaces/:id/accounts/:agent/login", async (req, res) => {
    if (!req.headers.origin || !isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: "앱 설정 화면에서 로그인을 시작해 주세요." });
      return;
    }
    try {
      const id = workspaceIdFormat(routeParam(req.params.id));
      const cli = agent(routeParam(req.params.agent));
      if (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)) throw new Error("로그인 요청에는 경로를 지정할 수 없습니다.");
      let accountDir = "";
      workspaceState = await mutateWorkspaceState(async (state) => {
        if (!state.workspaces.some((item) => item.id === id)) throw new Error("워크스페이스를 찾을 수 없습니다.");
        const policy = state.settings?.[id] ?? defaultWorkspacePolicy();
        accountDir = accountDirFor(policy, cli) ?? join(dataDirFor(options.dataDir), "accounts", id, cli);
        await mkdir(accountDir, { recursive: true });
        await installAccountSkills({ [cli]: accountDir });
        (state.settings ??= {})[id] = normalizeWorkspacePolicy({ accounts: { [cli]: accountDir } }, true, policy);
        return state;
      }, options.dataDir);
      res.json({ ...workspacesPayload(), command: accountLoginCommand(cli, accountDir) });
    } catch (error) { errorResponse(res, error, workspaceNotFound(error) ? 404 : 400); }
  });
  app.patch("/api/workspaces/:id", async (req, res) => {
    try {
      const id = workspaceIdFormat(routeParam(req.params.id));
      const hasSettings = req.body?.settings != null;
      // Rename, update settings (merged onto the stored ones), or both.
      const name = req.body?.name == null && hasSettings ? undefined : workspaceName(req.body?.name);
      if (hasSettings) normalizeWorkspacePolicy(req.body.settings, true);
      workspaceState = await mutateWorkspaceState(async (state) => {
        const found = state.workspaces.find((item) => item.id === id);
        if (!found) throw new Error("워크스페이스를 찾을 수 없습니다.");
        if (name) found.name = name;
        if (hasSettings) {
          const policy = normalizeWorkspacePolicy(req.body.settings, true, state.settings?.[id]);
          if (req.body.settings.accounts !== undefined) await installAccountSkills(policy.accounts);
          (state.settings ??= {})[id] = policy;
        }
        return state;
      }, options.dataDir);
      if (hasSettings && req.body.settings.accounts !== undefined) {
        await notifications.resolve(id, "account-skills");
        await routing.refreshModels(policyFor(id).accounts);
        await syncAuthNotifications();
      }
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
        const destinationNames = new Set(orchestra.listStewards(moveTo).map((lead) => lead.name.toLowerCase()));
        for (const lead of orchestra.listStewards(id)) {
          if (destinationNames.has(lead.name.toLowerCase())) throw conflict(`옮길 공간에 이미 「${lead.name}」 담당이 있습니다. 담당 이름을 바꾼 뒤 다시 시도하세요.`);
          destinationNames.add(lead.name.toLowerCase());
        }
        // Move the contents before dropping the workspace so a failed write leaves nothing orphaned.
        await mutateGroups((groups) => { for (const group of groups) if (group.workspaceId === id) group.workspaceId = moveTo; }, options.dataDir);
        // Leads (with or without chats) move along with their chats.
        for (const steward of orchestra.listStewards(id)) orchestra.moveSteward(steward.id, moveTo, false);
        for (const session of orchestra.list()) if (session.workspaceId === id) orchestra.setWorkspace(session.id, moveTo, false);
        await saveStewards(orchestra.listStewards(), options.dataDir);
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
      const parsed = startInput(req.body, workspace, currentWorkspace());
      const workspaceId = parsed.workspaceId ?? currentWorkspace();
      if (parsed.steward?.id) parsed.steward.id = resolveStewardId(parsed.steward.id, workspaceId);
      const input = withWorkspaceTeam(parsed, workspaceState.defaults[workspaceId] ?? {}, allowedFor(workspaceId));
      if (input.prompt) await assertMediaAvailable(input.prompt, input.workspaceId ?? currentWorkspace());
      if (input.groupId && !(await loadGroups(options.dataDir)).some((group) => group.id === input.groupId && group.workspaceId === input.workspaceId)) throw new Error("그룹을 찾을 수 없습니다.");
      res.status(201).json(await orchestra.create(input));
    }
    catch (error) { errorResponse(res, error); }
  });
  // Chat attachments and results, scoped to the session work folder (plus pasted/dropped uploads).
  registerSessionFileRoutes(app, {
    lookup: (id) => orchestra.get(id),
    // A worker's result (a design screenshot copied into its worktree) shows in the chat too.
    extraRoots: (session) => [previewAssetsDir(options.dataDir), ...(session?.worktrees?.map((item) => item.path) ?? []), QUEUE_DIR, SHOT_DIR],
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
      await ready;
      const session = orchestra.get(routeParam(req.params.id));
      if (!session?.steward) throw new Error("담당 채팅이 아닙니다.");
      const dir = orchestra.stewardDataDir;
      res.json({
        steward: orchestra.stewardOf(session) ?? null, pendingMerge: session.steward.pendingMerge ?? null,
        threads: orchestra.stewardThreads(session.steward.id ?? session.id).length,
        notes: dir ? await readNotes(dir, stewardNotesId(session)) : "", transcript: dir ? transcriptPath(dir, session.id) : undefined,
        turns: session.steward.turns, rolloverAt: STEWARD_ROLLOVER_TURNS,
        name: stewardName(session), report: orchestra.stewardOf(session)?.report ?? session.steward.report ?? null, acceptWork: Boolean(session.steward.acceptWork),
        // The leads this one can ask: those of its own workspace (Orchestra.stewards).
        peers: orchestra.list().filter((item) => item.steward && item.id !== session.id && item.workspaceId === session.workspaceId).map((item) => ({ id: item.id, name: stewardName(item), cwd: item.cwd })),
      });
    } catch (error) { errorResponse(res, error, 404); }
  });
  app.patch("/api/sessions/:id/steward", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new Error("담당 설정이 올바르지 않습니다.");
      if (body.name !== undefined && typeof body.name !== "string") throw new Error("담당 이름이 올바르지 않습니다.");
      if (body.acceptWork !== undefined && typeof body.acceptWork !== "boolean") throw new Error("담당 설정이 올바르지 않습니다.");
      const report = body.report === null || body.report === "" ? null : body.report === undefined ? undefined : reportTime(body.report);
      if (report === undefined && body.report !== undefined) throw new Error("보고 시각은 HH:MM 형식이어야 합니다.");
      if (body.enabled === undefined && body.name === undefined && body.report === undefined && body.acceptWork === undefined) throw new Error("담당 설정이 올바르지 않습니다.");
      const session = orchestra.updateSteward(routeParam(req.params.id), { enabled: body.enabled, name: body.name, report, acceptWork: body.acceptWork });
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  // One chat at a glance: status, the lead's last answer, its checklist, a merge waiting for approval
  // and the lead. Meant for tools that drive the app from outside (an MCP layer).
  app.get("/api/sessions/:id/summary", async (req, res) => {
    try { await ready; res.json(orchestra.summary(routeParam(req.params.id))); }
    catch (error) { errorResponse(res, error, 404); }
  });
  app.post("/api/sessions/:id/merge/approve", async (req, res) => {
    try {
      const session = await orchestra.approveMerge(routeParam(req.params.id));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });
  app.post("/api/sessions/:id/merge/reject", async (req, res) => {
    try {
      const session = orchestra.rejectMerge(routeParam(req.params.id));
      await persistSessions(orchestra.list());
      res.json(session);
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "세션을 찾을 수 없습니다." ? 404 : 400); }
  });

  // Project leads as entities (server/steward.ts): chats are their threads (`steward.id`).
  const resolveStewardId = (value: string, workspaceId: WorkspaceId) => {
    const steward = orchestra.resolveSteward(value, workspaceId);
    if (!steward) throw new Error("담당을 찾을 수 없습니다.");
    return steward.id;
  };
  const stewardPayload = async (id: string) => {
    const steward = orchestra.getSteward(id);
    if (!steward) throw new Error("담당을 찾을 수 없습니다.");
    const dir = orchestra.stewardDataDir;
    return { ...steward, notes: dir ? await readNotes(dir, id) : "", threads: orchestra.stewardThreads(id).map((session) => ({ id: session.id, title: session.title, status: session.status, cwd: session.cwd })) };
  };
  const stewardStatus = (error: unknown) => error instanceof Error && error.message === "담당을 찾을 수 없습니다." ? 404 : 400;
  // App-wide lead settings (workspaces.json `stewardSettings`) and the one-click policy change.
  app.get("/api/stewards/settings", async (_req, res) => {
    try { await ready; res.json({ legacyMergePolicy: workspaceState.stewardSettings?.legacyMergePolicy ?? LEGACY_MERGE_POLICY }); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.put("/api/stewards/settings", async (req, res) => {
    try {
      await ready;
      const policy = req.body?.legacyMergePolicy;
      if (policy !== "auto" && policy !== "ask") throw new Error("이전된 담당의 병합 정책은 auto 또는 ask여야 합니다.");
      workspaceState = await mutateWorkspaceState((state) => { state.stewardSettings = { ...state.stewardSettings, legacyMergePolicy: policy }; return state; }, options.dataDir);
      const updated = orchestra.setLegacyMergePolicy(policy);
      await saveStewards(orchestra.listStewards(), options.dataDir);
      res.json({ legacyMergePolicy: policy, updated });
    } catch (error) { errorResponse(res, error); }
  });
  app.post("/api/stewards/merge-policy/bulk", async (req, res) => {
    try {
      await ready;
      const policy = req.body?.policy;
      if (!isMergePolicy(policy)) throw new Error("병합 정책은 auto, ask, never 중 하나여야 합니다.");
      const updated = orchestra.setAllMergePolicies(policy);
      await saveStewards(orchestra.listStewards(), options.dataDir);
      res.json({ policy, updated, stewards: orchestra.listStewards() });
    } catch (error) { errorResponse(res, error); }
  });
  // `?workspace=`: only that workspace's leads (each workspace has its own); left out, every lead.
  app.get("/api/stewards", async (req, res) => {
    try {
      await ready;
      res.json(orchestra.listStewards(queryWorkspace(req.query.workspace)));
    } catch (error) { errorResponse(res, error, error instanceof Error && error.message === "워크스페이스가 올바르지 않습니다." ? 400 : 500); }
  });
  app.post("/api/stewards", async (req, res) => {
    try {
      await ready;
      const report = req.body?.report == null || req.body.report === "" ? undefined : reportTime(req.body.report);
      if (req.body?.report != null && req.body.report !== "" && !report) throw new Error("보고 시각은 HH:MM 형식이어야 합니다.");
      const steward = orchestra.createSteward({ ...stewardInput(req.body, true) as StewardPatch & { name: string }, workspaceId: workspace(req.body?.workspaceId, currentWorkspace()) });
      if (report) orchestra.setStewardReport(steward.id, report);
      await saveStewards(orchestra.listStewards(), options.dataDir);
      res.status(201).json(await stewardPayload(steward.id));
    } catch (error) { errorResponse(res, error); }
  });
  app.get("/api/stewards/:id", async (req, res) => {
    try { await ready; res.json(await stewardPayload(resolveStewardId(routeParam(req.params.id), toolsWorkspace(req.query.workspace)))); } catch (error) { errorResponse(res, error, stewardStatus(error)); }
  });
  app.patch("/api/stewards/:id", async (req, res) => {
    try {
      await ready;
      const id = resolveStewardId(routeParam(req.params.id), toolsWorkspace(req.query.workspace));
      if (!orchestra.getSteward(id)) throw new Error("담당을 찾을 수 없습니다.");
      const patch = stewardInput(req.body);
      // Moving a lead to another workspace takes its chats along (Orchestra.moveSteward).
      const moveTo = req.body.workspaceId == null || req.body.workspaceId === "" ? undefined : workspace(req.body.workspaceId);
      if (req.body.notes !== undefined && typeof req.body.notes !== "string") throw new Error("담당 노트가 올바르지 않습니다.");
      const report = req.body.report === null || req.body.report === "" ? null : req.body.report === undefined ? undefined : reportTime(req.body.report);
      if (report === undefined && req.body.report !== undefined) throw new Error("보고 시각은 HH:MM 형식이어야 합니다.");
      if (Object.keys(patch).length || moveTo) orchestra.patchSteward(id, patch, moveTo);
      if (report !== undefined) orchestra.setStewardReport(id, report);
      // The user edits the notes by hand: the lead reads them at the start of its next turn.
      if (typeof req.body.notes === "string" && orchestra.stewardDataDir) await saveNotes(orchestra.stewardDataDir, id, req.body.notes.slice(0, 20_000));
      await saveStewards(orchestra.listStewards(), options.dataDir);
      await persistSessions(orchestra.list());
      res.json(await stewardPayload(id));
    } catch (error) { errorResponse(res, error, stewardStatus(error)); }
  });
  app.delete("/api/stewards/:id", async (req, res) => {
    try {
      await ready;
      await orchestra.deleteSteward(resolveStewardId(routeParam(req.params.id), toolsWorkspace(req.query.workspace)));
      await saveStewards(orchestra.listStewards(), options.dataDir);
      await persistSessions(orchestra.list());
      res.status(204).end();
    } catch (error) { errorResponse(res, error, stewardStatus(error)); }
  });
  // A lead's schedules (schedules.ts). The lead makes them with its tools; the user here.
  app.get("/api/stewards/:id/schedules", async (req, res) => {
    try {
      await ready;
      const id = resolveStewardId(routeParam(req.params.id), toolsWorkspace(req.query.workspace));
      if (!orchestra.getSteward(id)) throw new Error("담당을 찾을 수 없습니다.");
      res.json(orchestra.listSchedules(id));
    } catch (error) { errorResponse(res, error, stewardStatus(error)); }
  });
  app.post("/api/stewards/:id/schedules", async (req, res) => {
    try {
      await ready;
      const schedule = orchestra.createLeadSchedule(resolveStewardId(routeParam(req.params.id), toolsWorkspace(req.query.workspace)), scheduleInput(req.body), "user");
      await Promise.all([saveSchedules(schedulesDir, orchestra.listSchedules()), persistSessions(orchestra.list())]);
      res.status(201).json(schedule);
    } catch (error) { errorResponse(res, error, stewardStatus(error)); }
  });
  app.patch("/api/schedules/:id", async (req, res) => {
    try {
      await ready;
      const schedule = orchestra.updateLeadSchedule(routeParam(req.params.id), scheduleInput(req.body), "user");
      await Promise.all([saveSchedules(schedulesDir, orchestra.listSchedules()), persistSessions(orchestra.list())]);
      res.json(schedule);
    } catch (error) { errorResponse(res, error, /찾을 수 없/u.test(error instanceof Error ? error.message : "") ? 404 : 400); }
  });
  app.delete("/api/schedules/:id", async (req, res) => {
    try {
      await ready;
      orchestra.deleteLeadSchedule(routeParam(req.params.id), "user");
      await Promise.all([saveSchedules(schedulesDir, orchestra.listSchedules()), persistSessions(orchestra.list())]);
      res.status(204).end();
    } catch (error) { errorResponse(res, error, /찾을 수 없/u.test(error instanceof Error ? error.message : "") ? 404 : 400); }
  });
  // ---------- app tools over MCP (app-tools.ts) ----------
  // One registry, two surfaces: a lead's run (/api/lead-mcp, its run token) and outside AIs
  // (/api/app-mcp, the app's external token). Tools run the routes above in-process.
  const dispatch = routeDispatcher(app as never);
  const mcpDataDir = dataDirFor(options.dataDir);
  const sendApprovals = async () => {
    const message = JSON.stringify({ type: "app-approvals", approvals: await approvals.list({ status: "pending" }) });
    for (const client of openClients()) client.send(message);
  };
  const approvals = new ApprovalStore(mcpDataDir, (item) => {
    const key = `approval:${item.id}`;
    if (item.status === "pending") {
      notify({ workspaceId: item.workspaceId, type: "permission", key, title: `AI가 승인을 기다립니다: ${item.summary}`, body: `${withJosa(approvalRequester(item), "이/가")} 요청한 '${item.tool}'입니다. 앱의 승인 카드에서 승인하거나 거절하세요.`, ...(item.sessionId ? { action: { label: "세션 열기", sessionId: item.sessionId } } : {}) });
      if (item.sessionId) orchestra.note(item.sessionId, `승인 대기: ${item.summary} (${item.tool})`);
    } else {
      void notifications.resolve(item.workspaceId, key).catch(() => undefined);
      const verdict = item.status === "approved" ? "승인되어 실행했습니다" : item.status === "rejected" ? "거절했습니다" : "승인했지만 실행에 실패했습니다";
      const detail = item.status === "failed" ? item.error ?? "" : item.status === "approved" ? item.result ?? "" : "";
      notify({ workspaceId: item.workspaceId, type: item.status === "failed" ? "error" : "info", key: `approval-result:${item.id}`, title: `${item.summary}: ${verdict}`, body: detail.slice(0, 2000), ...(item.sessionId ? { action: { label: "세션 열기", sessionId: item.sessionId } } : {}) });
      if (item.sessionId) orchestra.note(item.sessionId, `${verdict}: ${item.summary} (${item.tool}, approvalId ${item.id})${detail ? `\n${detail.slice(0, 1500)}` : ""}`);
    }
    void sendApprovals().catch(() => undefined);
  });
  type CallerContext = { surface: ToolSurface; sessionId?: string; workspaceId: string; touch?: () => void };
  /** Names for the IDs an approval's line mentions, read when it is asked for. */
  const approvalNames = async () => {
    const [groups, bots] = await Promise.all([loadGroups(options.dataDir).catch(() => []), loadBots(options.dataDir).catch(() => [])]);
    return nameLookup({
      session: (id) => orchestra.get(id)?.title,
      lead: (id) => orchestra.getSteward(id)?.name,
      workspace: (id) => workspaceState.workspaces.find((item) => item.id === id)?.name,
      schedule: (id) => orchestra.listSchedules().find((item) => item.id === id)?.title,
      group: (id) => groups.find((item) => item.id === id)?.name,
      bot: (id) => bots.find((item) => item.id === id)?.name,
    });
  };
  /** Who asked and where, by name, for the approval card. */
  const approvalContext = (caller: CallerContext) => {
    const session = caller.sessionId ? orchestra.get(caller.sessionId) : undefined;
    const workspaceName = workspaceState.workspaces.find((item) => item.id === caller.workspaceId)?.name;
    return {
      ...(session?.steward ? { requester: stewardName(session) } : {}),
      ...(session?.title ? { sessionTitle: session.title } : {}),
      ...(workspaceName ? { workspaceName } : {}),
    };
  };
  const toolContext = (caller: CallerContext): ToolContext => ({
    dispatch: (method, path, body) => {
      const url = new URL(path, "http://sinawi.local");
      const askedSession = method === "POST" ? /^\/api\/sessions\/([^/]+)\/live$/.exec(url.pathname) : null;
      if (askedSession) {
        const target = orchestra.get(decodeURIComponent(askedSession[1]));
        if (target && target.workspaceId !== caller.workspaceId) throw new Error("같은 공간의 채팅에만 질문할 수 있습니다. 먼저 담당을 같은 공간으로 옮기세요.");
      }
      if (/^\/api\/(?:stewards|settings)(?:\/|$)/.test(url.pathname) && !url.searchParams.has("workspace")) url.searchParams.set("workspace", caller.workspaceId);
      return dispatch(method, `${url.pathname}${url.search}`, body);
    }, workspaceId: caller.workspaceId,
    ...(caller.surface === "lead" && caller.sessionId ? { leadCall: (name: string, args: Record<string, unknown>) => orchestra.leadToolCall(caller.sessionId!, name, args, caller.touch) } : {}),
  });
  /** A tool call from either surface: reads and creations run, the rest wait for the user. */
  const callTool = async (caller: CallerContext, name: string, args: Record<string, unknown>) => {
    const tool = findTool(caller.surface, name);
    if (!tool) throw new Error(`알 수 없는 도구: ${name}`);
    if (tool.risk !== "approval") return tool.run(args, toolContext(caller));
    const item = await approvals.create({ tool: name, args, summary: tool.summary?.(args, await approvalNames()) ?? name, source: caller.surface, ...(caller.sessionId ? { sessionId: caller.sessionId } : {}), workspaceId: caller.workspaceId, ...approvalContext(caller) });
    return { status: "pending_approval", approvalId: item.id, summary: item.summary, next: "사용자가 앱의 승인 카드에서 승인하면 실행됩니다. 결과는 list_approvals(approval_id)로 확인하세요. 같은 요청을 다시 보내지 마세요." };
  };
  const runApproved = (item: AppApproval) => {
    const tool = findTool(item.source, item.tool);
    if (!tool) throw new Error(`도구가 더 이상 없습니다: ${item.tool}`);
    return tool.run(item.args, toolContext({ surface: item.source, sessionId: item.sessionId, workspaceId: item.workspaceId }));
  };
  // Only that run's own token works: it names the chat, and only the lead's run (not a worker's) may call.
  app.post("/api/lead-mcp", async (req, res) => {
    const token = req.get("x-sinawi-token") ?? "";
    const run = resolveComputerToken(token);
    const session = run ? orchestra.get(run.sessionId) : undefined;
    if (!run || run.owner !== `${run.sessionId}:orchestrator` || !session?.steward) {
      res.status(403).json({ error: "Sinawi: 담당 실행의 토큰이 아닙니다." });
      return;
    }
    try {
      await ready;
      const caller: CallerContext = { surface: "lead", sessionId: run.sessionId, workspaceId: session.workspaceId, touch: () => touchRunActivity(token) };
      const answer = await handleToolMcp(req.body ?? {}, "lead", LEAD_MCP_SERVER, (name, args) => callTool(caller, name, args));
      if (!answer) { res.status(202).end(); return; }
      res.json(answer);
    } catch (error) { errorResponse(res, error, 500); }
  });
  // Outside AIs (the bridge in packages/sinawi/lib/mcp.mjs): the token in <data>/app-mcp-token.
  app.post("/api/app-mcp", async (req, res) => {
    try {
      if (!tokenMatches(await ensureAppMcpToken(mcpDataDir), presentedToken(req.headers))) {
        res.status(401).json({ error: "Sinawi: MCP 토큰이 없거나 틀렸습니다. 설정 → 일반 → 외부 AI 연결에서 확인하세요." });
        return;
      }
      await ready;
      const caller: CallerContext = { surface: "external", workspaceId: currentWorkspace() };
      const answer = await handleToolMcp(req.body ?? {}, "external", APP_MCP_SERVER, (name, args) => callTool(caller, name, args));
      if (!answer) { res.status(202).end(); return; }
      res.json(answer);
    } catch (error) { errorResponse(res, error, 500); }
  });
  const connectionPayload = async (token: string) => {
    const script = await installAppMcpScript(mcpDataDir).catch(() => undefined);
    // `config` runs the npm package through npx; `scriptConfig` is the offline alternative (the copy in <data>/hooks).
    return { token, tokenFile: appMcpTokenPath(mcpDataDir), script: script ?? null, server: APP_MCP_SERVER, config: clientConfig(token), scriptConfig: script ? scriptClientConfig(script, token) : null };
  };
  // For the settings page: how to connect Claude Desktop (shows the token, so not a tool).
  app.get("/api/app-mcp/connection", async (_req, res) => {
    try { res.json(await connectionPayload(await ensureAppMcpToken(mcpDataDir))); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.post("/api/app-mcp/token", async (_req, res) => {
    try { res.json(await connectionPayload(await rotateAppMcpToken(mcpDataDir))); }
    catch (error) { errorResponse(res, error, 500); }
  });
  // "Connect to Claude Desktop / Cursor" (server/mcp-clients.ts). GET shows what would be merged; POST
  // writes it, only for a browser request from the app itself (an Origin header from the app's own
  // window) and only with the exact JSON the user confirmed. Neither route is an MCP tool.
  const clientEntry = async () => {
    await ensureAppMcpToken(mcpDataDir);
    const script = await installAppMcpScript(mcpDataDir);
    if (!script) throw new Error("Sinawi: 연결 스크립트를 찾지 못했습니다. / The bridge script was not found.");
    return connectEntry(script, appMcpTokenPath(mcpDataDir));
  };
  const clientError = (res: Response, error: unknown) => {
    if (error instanceof McpClientConfigError) { res.status(409).json({ error: error.message, code: error.code, path: error.path }); return; }
    errorResponse(res, error, 500);
  };
  app.get("/api/app-mcp/clients/:client", async (req, res) => {
    const client = routeParam(req.params.client);
    if (!isMcpClient(client)) { res.status(404).json({ error: `Unknown client ${client}` }); return; }
    try { res.json(await planMcpClient(client, await clientEntry())); }
    catch (error) { clientError(res, error); }
  });
  app.post("/api/app-mcp/clients/:client", async (req, res) => {
    const client = routeParam(req.params.client);
    if (!isMcpClient(client)) { res.status(404).json({ error: `Unknown client ${client}` }); return; }
    if (!req.headers.origin || !isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: "Sinawi: 앱의 설정 화면에서만 연결할 수 있습니다. / Only Sinawi's settings page can connect a client." });
      return;
    }
    try {
      const plan = await planMcpClient(client, await clientEntry());
      if (typeof req.body?.merge !== "string" || req.body.merge !== plan.merge) {
        res.status(409).json({ error: "Sinawi: 확인한 내용과 지금 쓸 내용이 다릅니다. 다시 시도하세요. / The confirmed JSON is out of date; try again.", code: "stale" });
        return;
      }
      res.json({ ...(await applyMcpClient(client, plan.entry)), name: plan.name });
    } catch (error) { clientError(res, error); }
  });
  // The app writes the token and script at start so `sinawi mcp` finds them; tests and embedders make them on demand.
  if (options.appMcp) void ensureAppMcpToken(mcpDataDir).then(() => installAppMcpScript(mcpDataDir)).catch(() => undefined);
  // Pending approvals (app-approvals.ts): the cards in the app read and answer these.
  const approvalStatuses = new Set<ApprovalStatus>(["pending", "approved", "rejected", "failed"]);
  app.get("/api/app-approvals", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" && req.query.status ? req.query.status as ApprovalStatus : undefined;
      if (status && !approvalStatuses.has(status)) throw new Error("승인 상태가 올바르지 않습니다.");
      const id = typeof req.query.id === "string" && req.query.id ? req.query.id : undefined;
      res.json({ approvals: await approvals.list({ status, id }) });
    } catch (error) { errorResponse(res, error); }
  });
  const decide = (approve: boolean) => async (req: Request, res: Response) => {
    try { res.json(await approvals.decide(routeParam(req.params.id), approve, runApproved)); }
    catch (error) { errorResponse(res, error, (error as { status?: number }).status ?? 400); }
  };
  app.post("/api/app-approvals/:id/approve", decide(true));
  app.post("/api/app-approvals/:id/reject", decide(false));
  // What the user wants from every lead, in user-preferences.md next to the leads' notes.
  app.get("/api/user-preferences", async (_req, res) => {
    try { res.json({ text: orchestra.stewardDataDir ? await readUserPreferences(orchestra.stewardDataDir) : "", limit: USER_PREFERENCES_LIMIT }); }
    catch (error) { errorResponse(res, error, 500); }
  });
  app.put("/api/user-preferences", async (req, res) => {
    try {
      if (typeof req.body?.text !== "string") throw new Error("선호 내용이 올바르지 않습니다.");
      if (req.body.text.length > USER_PREFERENCES_LIMIT) throw new Error(`선호는 ${USER_PREFERENCES_LIMIT}자까지 쓸 수 있습니다.`);
      if (!orchestra.stewardDataDir) throw new Error("데이터 폴더가 없습니다.");
      await saveUserPreferences(orchestra.stewardDataDir, req.body.text);
      res.json({ text: await readUserPreferences(orchestra.stewardDataDir), limit: USER_PREFERENCES_LIMIT });
    } catch (error) { errorResponse(res, error); }
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
      await orchestra.remove(routeParam(req.params.id));
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
      // A lead's chat takes its lead (and the lead's other chats) along (Orchestra.setWorkspace).
      if (session.steward) await saveStewards(orchestra.listStewards(), options.dataDir);
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
      const input: ConversationInput = { botA: string(req.body?.botA, 100), botB: string(req.body?.botB, 100), turns: Math.min(Math.max(requestedTurns, 1), 20), prompt: string(req.body?.prompt), cwd: string(req.body?.cwd, 4_096), workspaceId: workspace(req.body?.workspaceId, currentWorkspace()), ...(conversationSettings(req.body).permissionMode ? { permissionMode: conversationSettings(req.body).permissionMode } : {}) };
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
