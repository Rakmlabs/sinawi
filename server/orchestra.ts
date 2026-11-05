import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { killSessionProcessGroups, runCli } from "./cli.js";
import { QUEUE_DIR } from "./browser-bridge.js";
import { SHOT_DIR } from "./computer-bridge.js";
import { workerSessionId, setWorkerSessionId, loadToolSettings, workspaceToolSettings } from "./store.js";
import { clearSkillsCache, enabledPublicSkills, filterEnabledSkills, formatSkillPrompt, loadSkills, resolveSkillPrompt, scanSkillRoot, type SkillRecord } from "./skills.js";
import { applySchedulePatch, createSchedule, describeSchedule, dueSchedules, SCHEDULE_LIMIT, type Schedule, type ScheduleInput } from "./schedules.js";
import { LEAD_TOOLS_GUIDE, LEAD_WAIT_LIMIT_SEC } from "./lead-tools.js";
import { capabilityCatalog } from "./agent-capabilities.js";
import { workerInvocationWarnings } from "./worker-invocation.js";
import { briefSkillNames, skillCatalog, workerSkillSection } from "./skill-routing.js";
import type { AgentId, AgentSelection, Bot, CommanderGoal, GoalItem, ConversationInput, ConversationSettings, PermissionMode, Session, SessionDraft, SessionEvent, StartSessionInput, UpdateTeamInput, StewardDelivery, Steward, MergePolicy, ScheduleCard } from "./types.js";
import type { ProviderQuota } from "./quota.js";
import { equivalentFallbackModel, exhaustionFromQuota, isQuotaExhaustion, selectQuotaFallback } from "./quota-fallback.js";

import type { AutoSwitchRecommendation } from "./auto-routing.js";
import { accountDirFor, allowedAgentsForWorkspace, assertAgentsAllowed, assertMediaAllowed, fullAccessBlockedMessage, lockedToolsFor, policyDenyPatterns, type AllowedAgentResolver, type WorkspacePolicyResolver } from "./workspace-policy.js";
import { normalizeWorkerConfigs, workerLabel } from "./workers.js";
import { mediaRouteRequired, mediaSkills, mediaUnavailableMessage, isMediaRule } from "./media-routing.js";
import { cliNotes, compactHandoff, ensureBrief, ORCHESTRATOR_RULES, permissionModeRules, retargetCliNotes, reviewPrompt, StallDetector, stripToolNoise, isPureNoise, WORKER_RULES, type StallOptions, type StallSignal } from "./supervision.js";
import { ensureWorkerWorktree, mergeWorktree, gitRepo, mainTreeDirty, pruneEmptyWorktrees, repoSnapshot, userWorktrees, worktreeReviewNote, worktreeStatus, worktreeWorkerNote } from "./worktrees.js";
import { applyStewardPatch, askPrompt, DEFAULT_MERGE_POLICY, mergeThreadReports, isReportPrompt, LEGACY_MERGE_POLICY, MAX_ASK_DEPTH, mergeRule, parseAsks, parseNotes, projectState, readNotes, readUserPreferences, replyPrompt, reportDue, reportPrompt, rolloverContext, saveNotes, saveTranscript, sessionSummary, STEWARD_ROLLOVER_TURNS, stewardFromSession, stewardName, stewardNotesId, stewardRules, stewardStartText, stripLeadBlocks, transcriptPath, type SessionSummary, type StewardAsk, type StewardPatch } from "./steward.js";
import { COMMANDER_RULES, commanderActive, commanderBoard, goalRules, GOAL_STOP_TEXT, goalStateLabel, goalTurnPrompt, nextGoalStep, parseChecklist, parseGoals, renderChecklist, settledCount } from "./goals.js";
import { carriedOverPrompt, classifyLiveMessage, instructionSuffix, pushInstruction, liveReplyPrompt, parseLiveReply, STATUS_AGENT_MODEL, statusDigest, takePending, type LiveWorker } from "./live-turn.js";
import { withJosa } from "./korean.js";

const delegationPattern = /<<DELEGATE\b([^<>]{0,500})>>(.*?)<<\/DELEGATE>>/gis;
const delegationAttributePattern = /\b([a-z][\w-]*)\s*=\s*(["'])(.*?)\2/giu;
const maxEvents = 2_000;
const maxDelegations = 6;
/** Extra delegation rounds the orchestrator may use to re-plan after verification. */
const maxReplanRounds = 2;
const stallCheckMs = 15_000;
/** A worker's run ended because the session was stopped. */
const STOPPED = Symbol("stopped");
/** A feature failed, but its diagnostic report should still reach tag-based leads. */
class WorkerFeatureError extends Error {}
const guardKey = (sessionId: string, workerId: string) => `${sessionId}:${workerId}`;

/** What a lead's tools need from the turn that is running (Orchestra.leadTurns). */
interface LeadTurn {
  controller: AbortController;
  userPrompt: string;
  systemPrompt: string;
  skills: string;
  installedSkills: SkillRecord[];
  requiresGrokMedia: boolean;
  mediaPrompt?: string;
  /** The turn's team; delegate_task adds to it like a <<DELEGATE>> to a missing CLI does. */
  workers: AgentSelection[];
  answerOnly: boolean;
  tasks: LeadTask[];
  /** Worktrees the tool-delegated briefs ran in, by worker id. */
  worktrees: Map<string, NonNullable<Session["worktrees"]>[number]>;
}

/** One delegate_task call. */
interface LeadTask {
  id: string;
  workerId: string;
  label: string;
  agent: AgentId;
  brief: string;
  group?: string;
  kind?: string;
  status: "running" | "done" | "error" | "stopped";
  result?: string;
  collected: boolean;
  startedAt: string;
  endedAt?: string;
  done: Promise<void>;
}

const skillSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);

/** delegate_task kind "design": the worker shows its result, so the lead (and the chat) can see it. */
export const DESIGN_BRIEF = `## 디자인 작업
- 화면을 만들거나 고친 뒤 실제로 띄워 브라우저(orchestra-browser 스킬, ao-browser)로 열고 확인하세요.
- 확인한 화면의 스크린샷을 저장하고, 보고 끝에 한 줄씩 \`![무엇을 찍었는지](스크린샷 절대 경로)\` 형식으로 붙이세요. 채팅에서 그 이미지가 보입니다.
- 색·간격·글꼴은 프로젝트에 있는 디자인 토큰과 컴포넌트를 먼저 쓰고, 바꾼 이유를 한 줄로 적으세요.`;
const agentNames: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok Build",
};

function workerRoster(workers: AgentSelection[]): string {
  return workers.map((worker) => `${worker.id} (${workerLabel(worker)} / ${worker.agent})`).join(", ") || "없음";
}

/** A worker moved to another agent keeps a custom label, but not the old agent's default name ("Codex", "Codex 2"). */
function relabelForAgent<T extends AgentSelection>(config: T, from: AgentId): T {
  if (!config.label || !new RegExp(`^${agentNames[from]}(?: \\d+)?$`, "u").test(config.label)) return config;
  const { label: _label, ...rest } = config;
  return rest as T;
}

function clearChangedWorkerSessions(session: Session, before: AgentSelection[], after: AgentSelection[]): void {
  const previous = new Map(before.map((worker) => [worker.id!, worker.agent]));
  const next = new Map(after.map((worker) => [worker.id!, worker.agent]));
  for (const workerId of new Set([...previous.keys(), ...next.keys()])) {
    if (!previous.has(workerId) || !next.has(workerId) || previous.get(workerId) !== next.get(workerId)) {
      setWorkerSessionId(session, workerId);
    }
  }
}

export interface QuotaFallbackContext {
  enabled: boolean;
  threshold: number;
  order?: Partial<Record<AgentId, AgentId[]>>;
  quotas: ProviderQuota[];
  authenticated: AgentId[];
}

export type QuotaFallbackResolver = (session: Session) => Promise<QuotaFallbackContext>;

export interface WorkerReadiness {
  installed: boolean;
  authenticated: boolean;
  detail: string;
}

export type WorkerReadinessResolver = (session: Session, agent: AgentId) => Promise<WorkerReadiness>;

export interface DelegationRequest { target: string; task: string; model?: string; kind?: "design" | "research" }
export function parseDelegations(text: string): DelegationRequest[] {
  const requests: DelegationRequest[] = [];
  for (const match of text.matchAll(delegationPattern)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1].matchAll(delegationAttributePattern)) attributes.set(attribute[1].toLowerCase(), attribute[3].trim());
    const target = attributes.get("to");
    const task = match[2].trim();
    const model = attributes.get("model")?.slice(0, 100);
    const rawKind = attributes.get("kind")?.toLowerCase();
    const kind = rawKind === "design" || rawKind === "research" ? rawKind : undefined;
    if (target && /^[\w.-]{1,100}$/u.test(target) && task) requests.push({ target, task, ...(model ? { model } : {}), ...(kind ? { kind } : {}) });
    if (requests.length >= maxDelegations) break;
  }
  return requests;
}

function designBriefRequested(task: string, kind?: DelegationRequest["kind"]): boolean {
  if (kind === "design" || /(?:^|\s)\/design\b/iu.test(task)) return true;
  if (briefSkillNames(task).some((name) => /(?:^|[-_:])(?:design|impeccable)(?:$|[-_:])/iu.test(name))) return true;
  const visual = String.raw`(?:UI|UX|화면|웹\s*페이지|랜딩\s*페이지|대시보드|인터페이스|프론트엔드|screen|web\s*page|landing\s*page|dashboard|interface|frontend)`;
  const design = String.raw`(?:디자인|시안|목업|design|redesign|mockup)`;
  return new RegExp(`${visual}[^\n]{0,60}${design}|${design}[^\n]{0,60}${visual}`, "iu").test(task);
}

/** An empty chat's title until its first message names it (followup). */
const EMPTY_TITLE = "새 채팅";

function titleFrom(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact || "새 세션";
}

/** A worker's result block as built in execute(): "[label 결과]\n" + the report. */
const REPORT_HEADER = /^\[[^\]\n]*결과\]\n/u;
/** The report opens with "상태: 완료" (not "부분 완료" or "막힘"), optionally in bold. */
const CLEAN_REPORT = /^\[[^\]\n]*결과\]\n\s*(?:\*\*)?상태(?:\*\*)?\s*:\s*(?:\*\*)?완료/u;
/** A worker that ended "상태: 막힘". */
const BLOCKED_REPORT = /^\[[^\]\n]*결과\]\n\s*(?:\*\*)?상태(?:\*\*)?\s*:\s*(?:\*\*)?막힘/u;
/** A worker the app cut off (stall, abort). */
const CUT_REPORT = /^\[[^\]\n]*결과 — (?:앱이 정체를 감지해 중단함|중단됨)/u;

const PLAN_MODE_NOTICE = `## 계획 모드
사용자가 계획 모드를 골랐습니다. 이번 턴에는 파일 수정, 커밋, push, 배포, 워커 위임(<<DELEGATE>>)을 하지 않습니다. 모든 도구가 읽기 전용입니다.
읽기 전용으로 확인한 뒤 실행 계획만 짧게 쓰세요: 목표(무엇을 어떤 상태로, git이면 대상 브랜치·커밋), 바꿀 파일, 실행할 명령과 순서(커밋·push·배포 포함), 확인 방법, 사용자에게 물어볼 것.
사용자가 "이대로 실행"을 누르면 다음 턴에 이 계획대로 실행합니다.`;

/** A finished run whose CLI reported a quota or rate limit. */
const freshGoal = (): NonNullable<Session["goal"]> => ({ items: [], startedAt: new Date().toISOString(), autoTurns: 0, idleTurns: 0 });

function runExhausted(run: { exitCode: number; cliText: string; quotaErrorEvidence: boolean; stoppedByApp: boolean }): boolean {
  if (run.stoppedByApp) return false;
  return run.quotaErrorEvidence || run.exitCode !== 0 && isQuotaExhaustion(run.cliText);
}

export class Orchestra {
  private sessions = new Map<string, Session>();
  private controllers = new Map<string, AbortController>();
  private inactivityTimers = new Map<string, NodeJS.Timeout>();
  private configs = new Map<string, { skills: string[]; systemPrompt: string }>();
  /** The checklist the lead wrote last in a goal session's running turn. */
  private turnChecklists = new Map<string, GoalItem[]>();
  /** Goal sessions whose next followup is a turn the app opens itself. */
  private goalAutoNext = new Set<string>();
  /** Goal sessions whose running turn the app opened itself. */
  private goalAutoTurn = new Set<string>();
  /** Where project leads keep their notes and transcripts (server/steward.ts); unset: no files. */
  stewardDataDir?: string;
  /** Project leads as entities (Steward), by id; their chats point at them with `steward.id`. */
  private stewardEntities = new Map<string, Steward>();
  /** Set by the server: writes the lead entities (stewards.json) after the app changed them. */
  persistStewards?: (stewards: Steward[]) => void | Promise<void>;
  /** `<<ASK>>` blocks a lead wrote this turn, sent when the turn ends. */
  private stewardAsks = new Map<string, StewardAsk[]>();
  /** Leads whose next waiting message is being started (followup sets "running" only after an await). */
  private stewardStarting = new Set<string>();
  /** The lead's last final answer: what goes back to the lead that asked. */
  private stewardLastAnswer = new Map<string, string>();
  /** How many lead-to-lead hops led to this lead's current turn (MAX_ASK_DEPTH). */
  private stewardDepth = new Map<string, number>();
  /** Goal sessions started by a commander run at once, at most. */
  commanderParallelGoals = 3;
  /** Per-session kill switch + stall detector for the worker currently running. */
  /** One per running worker (`guardKey`): workers of a session run at the same time. */
  private workerGuards = new Map<string, { kill: AbortController; detector: StallDetector; stall?: StallSignal }>();
  /** Briefs waiting for a busy worker (`guardKey`): one CLI session runs one brief at a time. */
  private workerChains = new Map<string, Promise<unknown>>();
  /** The lead turn running now, for its tools (delegate_task and friends); by session id. */
  private leadTurns = new Map<string, LeadTurn>();
  /** Lead schedules (schedules.ts), by id. */
  private schedules = new Map<string, Schedule>();
  /** Set by the server: writes schedules.json after a change. */
  persistSchedules?: (schedules: Schedule[]) => void | Promise<void>;
  /** Sessions whose already-published events were edited or removed since the last publish. */
  private rewrittenEvents = new Set<string>();
  /** Tunable stall thresholds (tests shorten these). */
  stallOptions: StallOptions = {};
  /**
   * Data directory for per-worker git worktrees. Unset (tests, embedders) keeps every worker in the
   * session folder; the server sets it so workers in a git repository get their own worktree.
   */
  worktreeDataDir?: string;
  /** Throttle state for heartbeats: last inactivity re-arm and last client publish per session. */
  private heartbeats = new Map<string, { touched: number; published: number }>();
  /** How often a quiet-but-alive run tells clients it is still alive. */
  heartbeatPublishMs = 5_000;
  /**
   * Upper bound on "alive but saying nothing": raw CLI output keeps re-arming the inactivity
   * watchdog, so a CLI that prints retry noise or endless partial deltas would never time out.
   * After this long without a session event (message, tool, command, status, error) the run fails.
   */
  quietLimitMs = 20 * 60 * 1_000;
  /** Set by the server: whether the user denied or stopped computer use for a session since a time. */
  computerHalt?: (sessionId: string, since: number) => "denied" | "stopped" | undefined;
  /** Set by the server: confirms a missing CLI is installed and logged in before a lead adds it. */
  workerReadiness?: WorkerReadinessResolver;
  /** Time of the last session event per running session (see quietLimitMs). */
  private lastEventAt = new Map<string, number>();
  /**
   * Per-session worktree mutex: worktree creation/reuse (prepareWorktree) and automatic pruning
   * never overlap, so a new run cannot pick up a worktree that a prune is deleting.
   */
  private worktreeLocks = new Map<string, Promise<unknown>>();
  /** CLI runs still in flight per session; pruning waits until these processes have exited. */
  private inflightRuns = new Map<string, Set<Promise<unknown>>>();

  constructor(
    // `full` = already-sent events were changed or removed, so clients need a whole snapshot, not an append.
    private publish: (session: Session, options?: { full?: boolean }) => void = () => undefined,
    private runner: typeof runCli = runCli,
    // Receives the full list plus the ids that changed, so storage can rewrite only those.
    private persist: (sessions: Session[], changedIds: string[]) => void | Promise<void> = () => undefined,
    private publishRemoval: (sessionId: string) => void = () => undefined,
    private autoRouter?: (session: Session, prompt: string, signal: AbortSignal) => Promise<AutoSwitchRecommendation | undefined>,
    private allowedAgentResolver?: AllowedAgentResolver,
    private usageDataDir?: string,
    private quotaFallbackResolver?: QuotaFallbackResolver,
    private mediaRequestResolver?: (prompt: string) => Promise<boolean>,
    private inactivityTimeoutMs = 10 * 60 * 1_000,
    /** Per-workspace settings (media generation, locked tools, ...); absent means everything allowed. */
    private workspacePolicyResolver?: WorkspacePolicyResolver,
  ) {}

  private clearInactivityTimer(sessionId: string): void {
    const timer = this.inactivityTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.inactivityTimers.delete(sessionId);
  }

  private touchInactivityTimer(session: Session): void {
    this.clearInactivityTimer(session.id);
    if (session.status !== "running" || !this.controllers.has(session.id) || this.inactivityTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      if (session.status !== "running") return;
      this.controllers.get(session.id)?.abort();
      // Say what was running and for how long, so the user knows which step went silent.
      const last = session.events.at(-1);
      const waited = this.inactivityTimeoutMs >= 60_000 ? `${Math.round(this.inactivityTimeoutMs / 60_000)}분` : `${Math.round(this.inactivityTimeoutMs / 1_000)}초`;
      const lastStep = last ? ` 마지막 기록: ${last.agent === "user" ? "사용자" : agentNames[last.agent]}${last.workerLabel ? `(${last.workerLabel})` : ""} — ${last.text.replace(/\s+/g, " ").slice(0, 120)}.` : "";
      this.fail(session, new Error(`새 이벤트가 없어 작업을 중단했습니다 (${waited} 동안 CLI 출력 없음).${lastStep} 같은 요청을 다시 보내면 새로 실행합니다.`));
    }, this.inactivityTimeoutMs);
    timer.unref();
    this.inactivityTimers.set(session.id, timer);
  }

  /**
   * Raw CLI output that may render nothing (Claude partial messages, Grok thoughts, stderr):
   * proof the run is alive. Re-arms the inactivity watchdog and the worker stall clock, and tells
   * clients (throttled) so the chat can show "thinking… Ns" instead of looking frozen.
   */
  private heartbeat(session: Session, signal: AbortSignal, detector?: StallDetector): void {
    if (!this.isCurrentRun(session, signal)) return;
    const now = Date.now();
    const quietFor = now - (this.lastEventAt.get(session.id) ?? now);
    if (this.quietLimitMs > 0 && quietFor >= this.quietLimitMs) {
      this.controllers.get(session.id)?.abort();
      const minutes = this.quietLimitMs >= 60_000 ? `${Math.round(this.quietLimitMs / 60_000)}분` : `${Math.round(this.quietLimitMs / 1_000)}초`;
      this.fail(session, Object.assign(new Error(`CLI가 출력은 계속 내지만 ${minutes} 동안 메시지·도구·결과 이벤트가 없어 작업을 중단했습니다 (재시도 반복이나 응답 정지로 보입니다). 같은 요청을 다시 보내면 새로 실행합니다.`), { code: "CLI_NO_PROGRESS" }));
      return;
    }
    detector?.heartbeat();
    const state = this.heartbeats.get(session.id) ?? { touched: 0, published: 0 };
    if (now - state.touched >= Math.min(1_000, this.inactivityTimeoutMs / 4)) {
      state.touched = now;
      this.touchInactivityTimer(session);
    }
    if (now - state.published >= this.heartbeatPublishMs) {
      state.published = now;
      session.lastActivityAt = new Date(now).toISOString();
      this.publish(session);
    }
    this.heartbeats.set(session.id, state);
  }

  private isCurrentRun(session: Session, signal: AbortSignal): boolean {
    return !signal.aborted && this.controllers.get(session.id)?.signal === signal;
  }

  private requireCurrentRun(session: Session, signal: AbortSignal): void {
    if (!this.isCurrentRun(session, signal)) throw Object.assign(new Error("실행이 중지되었습니다."), { name: "AbortError" });
  }

  private async isMediaRequest(prompt: string, skills: string[] = [], workspaceId: Session["workspaceId"] = "personal"): Promise<boolean> {
    const disabled = new Set(workspaceToolSettings(await loadToolSettings(this.usageDataDir), workspaceId).disabledSkills.map((name) => name.toLocaleLowerCase()));
    return skills.some((id) => isMediaRule(id) && !disabled.has(id.toLocaleLowerCase())) || (this.mediaRequestResolver
      ? await this.mediaRequestResolver(prompt)
      : mediaRouteRequired(prompt, []));
  }

  private mediaWorkers(workspaceId: Session["workspaceId"]): AgentId[] {
    return (["codex", "grok"] as AgentId[]).filter((agent) => this.allowedAgents({ workspaceId }).includes(agent));
  }

  private allowedAgents(session: Pick<Session, "workspaceId">): AgentId[] {
    return allowedAgentsForWorkspace(session.workspaceId, this.allowedAgentResolver?.(session.workspaceId));
  }

  private agentAllowed(workspaceId: Session["workspaceId"], agent: AgentId): boolean {
    try { this.assertPolicy(workspaceId, [agent]); return true; } catch { return false; }
  }

  private assertPolicy(workspaceId: Session["workspaceId"], agents: readonly AgentId[]): void {
    assertAgentsAllowed(workspaceId, agents, this.allowedAgentResolver?.(workspaceId));
  }

  /** The session's permission mode; sessions from before modes follow the workspace switch. */
  private permissionModeOf(session: Session): PermissionMode {
    const allowFull = Boolean(this.workspacePolicyResolver?.(session.workspaceId)?.fullAccess);
    const mode = session.permissionMode ?? (allowFull ? "full" : "auto");
    return mode === "full" && !allowFull ? "auto" : mode;
  }

  private assertPermissionMode(workspaceId: Session["workspaceId"], mode: PermissionMode | undefined): void {
    if (mode === "full" && !this.workspacePolicyResolver?.(workspaceId)?.fullAccess) throw new Error(fullAccessBlockedMessage);
  }

  /** The workspace's CLI account folders (skills and runs use them); none means the default logins. */
  private accountsOf(workspaceId: Session["workspaceId"]) {
    return this.workspacePolicyResolver?.(workspaceId)?.accounts;
  }

  private assertSessionPolicy(session: Session): void {
    this.assertPolicy(session.workspaceId, [session.agent, ...session.workers, ...(session.planner ? [session.planner.agent] : [])]);
  }

  /**
   * `legacyMergePolicy`: what migrated leads get (StewardSettings); "auto" when unset.
   * `defaultWorkspaceId`: where a lead saved before leads were per workspace goes when it has no chat.
   */
  restore(sessions: Session[], stewards: Steward[] = [], options: { legacyMergePolicy?: MergePolicy; defaultWorkspaceId?: Session["workspaceId"] } = {}) {
    for (const steward of stewards) this.stewardEntities.set(steward.id, steward);
    for (const session of sessions) {
      session.workerConfigs = normalizeWorkerConfigs(session.workers, session.workerConfigs);
      this.sessions.set(session.id, session);
      this.configs.set(session.id, { skills: session.skills ?? [], systemPrompt: session.systemPrompt ?? "" });
    }
    // Lead chats from before leads were entities (or whose entity is gone) get one made from what the
    // chat was started with, under the chat's own id so its notes stay where they are.
    const migrated: string[] = [];
    for (const session of sessions) {
      if (!session.steward) continue;
      let entity = session.steward.id ? this.stewardEntities.get(session.steward.id) : undefined;
      if (!entity) {
        entity = { ...stewardFromSession(session, { mergePolicy: options.legacyMergePolicy ?? LEGACY_MERGE_POLICY }), migrated: true };
        this.stewardEntities.set(entity.id, entity);
        session.steward.id = entity.id;
        migrated.push(session.id);
      }
      if (entity.name) session.steward.name = entity.name;
    }
    // Report times used to be per chat: each lead now has one, the earliest its chats had.
    const reportsMoved = this.moveThreadReports();
    if (reportsMoved.length) migrated.push(...reportsMoved.filter((id) => !migrated.includes(id)));
    // Leads used to be app-wide: each now belongs to one workspace (its threads' too).
    const placed = this.placeStewardsInWorkspaces(options.defaultWorkspaceId);
    if (placed.stewards && !migrated.length) void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
    if (placed.sessions.length) migrated.push(...placed.sessions.filter((id) => !migrated.includes(id)));
    if (migrated.length) {
      void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
      void Promise.resolve(this.persist(this.list(), migrated)).catch(() => undefined);
    }
    // A lead that was answering another lead when the app quit: tell the asker. Waiting messages run
    // on the first stewardTick.
    for (const session of sessions) {
      if (session.steward?.answering) this.settleStewardAnswer(session, "error", false);
    }
    // The app quit while goals ran: those goals wait again and resume in their own session on the
    // commander's next tick (its next turn).
    for (const session of sessions) {
      for (const goal of session.commander?.goals ?? []) {
        if (goal.state === "running" && this.sessions.get(goal.childId ?? "")?.status !== "running") goal.state = "waiting";
      }
    }
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Session | undefined { return this.sessions.get(id); }

  /** Set by the server: app-owned resources of a session (dev servers) end with it. */
  sessionRemoved?: (id: string) => void;
  /** Set by the server: live text of a message an agent is still writing. */
  sessionDraft?: (draft: SessionDraft) => void;

  /** A status line from an app tool (ao-serve) in a session's chat. */
  note(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session) this.event(session, session.agent, "status", text);
  }

  /** Call after editing or removing events that clients may already hold. */
  private markEventsRewritten(session: Session): void {
    this.rewrittenEvents.add(session.id);
  }

  private broadcast(session: Session) {
    this.publish(session, this.rewrittenEvents.delete(session.id) ? { full: true } : undefined);
    void Promise.resolve(this.persist(this.list(), [session.id])).catch(() => undefined);
  }

  private event(
    session: Session,
    agent: AgentId | "user",
    type: SessionEvent["type"],
    text: string,
    metadata: Partial<Pick<SessionEvent, "role" | "delegationId" | "taskStatus" | "model" | "reasoningEffort" | "workerId" | "workerLabel" | "metadata">> = {},
  ): SessionEvent | undefined {
    if (this.sessions.get(session.id) !== session) return;
    if (!text.trim()) return;
    if (type === "status" && text === "CLI 세션 연결됨" && session.events.some((event) => event.type === type && event.text === text)) return;
    const id = type === "delegation" && metadata.taskStatus === "running" ? (metadata.delegationId ?? randomUUID()) : randomUUID();
    const event = { id, sessionId: session.id, agent, type, text, time: new Date().toISOString(), ...metadata } satisfies SessionEvent;
    if (type === "delegation" && metadata.taskStatus === "running") event.delegationId = id;
    session.events.push(event);
    if (session.events.length > maxEvents) session.events.splice(0, session.events.length - maxEvents);
    this.lastEventAt.set(session.id, Date.now());
    this.touchInactivityTimer(session);
    this.broadcast(session);
    return event;
  }

  async create(requested: StartSessionInput): Promise<Session> {
    // A new thread of an existing lead runs with the lead's own team, instructions and skills.
    const entity = requested.steward?.id ? this.stewardEntities.get(requested.steward.id) : undefined;
    if (requested.steward?.id && !entity) throw new Error("담당을 찾을 수 없습니다.");
    if (requested.parentId && entity) throw new Error("나눠 맡긴 채팅은 담당이 될 수 없습니다.");
    let input: StartSessionInput = entity ? {
      // A lead's threads live in the lead's workspace, wherever they were asked for from.
      ...requested, ...(entity.workspaceId ? { workspaceId: entity.workspaceId } : {}), agent: entity.agent, model: entity.model, reasoningEffort: entity.reasoningEffort,
      ...(entity.workers.length ? { workers: entity.workers.map((worker) => worker.agent), workerConfigs: structuredClone(entity.workers) } : {}),
      systemPrompt: entity.systemPrompt, skills: [...new Set([...entity.skills, ...(requested.skills ?? [])])],
    } : requested;
    // A lead's chat started with just `steward: {id}` (API, scripts): the lead's team, else the workspace's agents.
    // No workers picked (any chat): the lead's team above, else every agent the workspace allows.
    // The HTTP route fills the workspace's default team first (server.ts withWorkspaceTeam).
    if (!input.agent || !input.workers?.length) {
      const fallback = this.defaultTeam(input.workspaceId ?? "personal", input.agent || undefined);
      input = { ...input, agent: input.agent || fallback.agent, ...(input.workers?.length ? {} : { workers: fallback.workers, workerConfigs: undefined }) };
    }
    if (!entity && input.steward?.name?.trim()) this.assertStewardNameFree(input.steward.name.trim().slice(0, 80), undefined, input.workspaceId ?? "personal");
    const workspaceId = input.workspaceId ?? "personal";
    // No first message: an empty chat that waits for one (followup starts its first turn).
    const empty = !input.prompt.trim();
    const mediaRequest = !empty && await this.isMediaRequest(input.prompt, input.skills, workspaceId);
    if (mediaRequest) assertMediaAllowed(this.workspacePolicyResolver?.(workspaceId));
    // Media requests move the lead to Grok only in auto mode; a manually chosen team is kept as is.
    const mediaLead = mediaRequest && (input.mode ?? "manual") === "auto";
    if (mediaLead && !this.allowedAgents({ workspaceId }).includes("grok")) throw new Error(mediaUnavailableMessage);
    const agent = mediaLead ? "grok" : input.agent;
    const workers: AgentId[] = [...(input.workers ?? [])];
    const model = mediaLead ? "grok-4.7" : input.model;
    const reasoningEffort = mediaLead ? undefined : input.reasoningEffort;
    const workerConfigs = normalizeWorkerConfigs(workers, input.workerConfigs);
    this.assertPolicy(workspaceId, [agent, ...workers, ...(input.planner ? [input.planner.agent] : [])]);
    this.assertPermissionMode(workspaceId, input.permissionMode);
    // A new thread of a lead opens in the lead's first folder unless the user picked another.
    const folder = input.cwd || entity?.cwds[0];
    if (!folder) throw new Error("작업 폴더가 올바르지 않습니다.");
    const cwd = resolve(folder);
    if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
    const selectedSkills = [...new Set([...(input.skills ?? []), ...mediaSkills(input.prompt, await enabledPublicSkills(cwd, false, workspaceToolSettings(await loadToolSettings(this.usageDataDir), workspaceId).disabledSkills, this.accountsOf(workspaceId)))])];
    const session: Session = {
      id: randomUUID(), title: input.title?.trim().slice(0, 100) || (empty ? EMPTY_TITLE : titleFrom(input.prompt)), agent,
      workers, cwd, model,
      reasoningEffort,
      workerConfigs,
      planner: input.planner,
      mode: input.mode ?? "manual", autoSwitch: input.autoSwitch ?? true, turnCount: empty ? 0 : 1,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      status: empty ? "done" : "running", createdAt: new Date().toISOString(), events: [],
      cliSessionId: agent === input.agent ? input.resumeSessionId : undefined,
      groupId: input.groupId,
      workspaceId,
      skills: selectedSkills, systemPrompt: input.systemPrompt ?? "",
      ...(input.commander ? { commander: { goals: [], forced: true } } : input.goal || input.autoRun || input.steward ? { goal: freshGoal() } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.steward && !input.parentId ? { steward: { turns: 0, since: new Date().toISOString(), ...(entity ? { id: entity.id, name: entity.name } : input.steward.name?.trim() ? { name: input.steward.name.trim().slice(0, 80) } : {}) } } : {}),
    };
    this.sessions.set(session.id, session);
    try {
      if (session.steward) {
        if (entity && !entity.cwds.includes(cwd)) this.saveStewardEntity({ ...entity, cwds: [...entity.cwds, cwd] });
        if (!entity) this.adoptSteward(session);
      }
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    this.configs.set(session.id, { skills: selectedSkills, systemPrompt: input.systemPrompt ?? "" });
    if (empty) {
      this.event(session, agent, "status", `빈 채팅을 열었습니다. 메시지를 보내면 ${withJosa(agentNames[agent], "으로/로")} 시작합니다.`);
      if (session.steward) this.event(session, agent, "status", stewardStartText(this.stewardOf(session)?.mergePolicy));
      return session;
    }
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    this.event(session, agent, "status", `${agentNames[agent]} 세션을 시작했습니다.`);
    if (session.steward) this.event(session, agent, "status", stewardStartText(this.stewardOf(session)?.mergePolicy));
    this.event(session, "user", "message", input.prompt);
    void this.execute(session, input.prompt, selectedSkills, input.systemPrompt ?? "", controller, mediaLead || (mediaRequest && agent === "grok"))
      .catch((error) => this.fail(session, error, controller));
    return session;
  }

  private async execute(session: Session, userPrompt: string, skillIds: string[], systemPrompt: string, controller: AbortController, requiresGrokMedia: boolean) {
    try {
      return await this.executeTurn(session, userPrompt, skillIds, systemPrompt, controller, requiresGrokMedia);
    } finally {
      // The lead's tools belong to one turn: later calls with an old token find nothing to act on.
      if (this.leadTurns.get(session.id)?.controller === controller) this.leadTurns.delete(session.id);
    }
  }

  private async executeTurn(session: Session, userPrompt: string, skillIds: string[], systemPrompt: string, controller: AbortController, requiresGrokMedia: boolean) {
    if (!this.isCurrentRun(session, controller.signal)) return;
    const runStartedAt = Date.now();
    this.turnChecklists.delete(session.id);
    if (commanderActive(session)) return this.executeCommander(session, userPrompt, systemPrompt, controller);
    this.assertSessionPolicy(session);
    if (requiresGrokMedia) assertMediaAllowed(this.workspacePolicyResolver?.(session.workspaceId));
    if (requiresGrokMedia && session.agent !== "grok") {
      throw new Error(mediaUnavailableMessage);
    }
    const disabledSkills = workspaceToolSettings(await loadToolSettings(this.usageDataDir), session.workspaceId).disabledSkills;
    const skills = await resolveSkillPrompt(skillIds, session.cwd, disabledSkills, this.accountsOf(session.workspaceId));
    // Every installed skill, so the lead can pick skills for a brief the user never named.
    const installedSkills = filterEnabledSkills(await loadSkills(session.cwd, false, this.accountsOf(session.workspaceId)).catch(() => []), disabledSkills);
    const mediaPrompt = this.workspacePolicyResolver?.(session.workspaceId).mediaPrompt;
    if (!this.isCurrentRun(session, controller.signal)) return;
    let plan = "";
    if (session.planner) {
      this.event(session, session.planner.agent, "status", `${agentNames[session.planner.agent]}가 실행 계획을 준비하고 있습니다.`);
      const planningPrompt = `당신은 실행 전 계획을 작성하는 전문 에이전트입니다. 파일을 수정하거나 상태를 변경하지 말고, 도구를 호출하지 마세요. 구현하지 마세요. 주어진 요청을 분석해 간결한 실행 계획을 한국어로 작성하세요. 단계는 확인 가능한 문장으로, 2개 이상일 때만 나누고, 한 단계짜리 계획은 쓰지 마세요. 서로 독립인 단계만 병렬이라고 표시하고, 같은 파일은 한 단계에만 넣으세요. 주요 위험, 가정, 완료 조건을 적으세요. "그것", "이어서"처럼 앞 대화를 가리키는 표현은 아래 이전 대화로 해석하세요.${skills}\n\n이전 대화 요약:\n${session.handoffContext ?? this.conversationSummary(session, session.agent)}\n\n사용자 요청:\n${userPrompt}`;
      const planning = await this.runSelection(session, session.planner, planningPrompt, undefined, controller.signal);
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      if (planning.exitCode !== 0) throw new Error(`${agentNames[session.planner.agent]} 계획 단계가 종료 코드 ${planning.exitCode}로 끝났습니다.`);
      plan = planning.finalText.trim();
    }
    const workers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workerConfigs = workers;
    const workerNames = workerRoster(workers);
    const workerContext = workers.map((worker) => `${worker.id}: ${worker.sessionMode !== "new" && workerSessionId(session, worker.id!) ? "이전 작업의 맥락을 가진 세션을 이어서 사용합니다. 기존 설명을 반복하지 않고 후속 작업을 지시할 수 있습니다." : "새 세션으로 시작합니다. 필요한 맥락을 전달하세요."}`).join("\n");
    const exampleWorker = workers[0]?.id ?? "claude";
    const worktreeNotice = await this.worktreeNotice(session);
    const orchestration = `당신은 Sinawi의 상위 명령자입니다. 사용 가능한 워커: ${workerNames}. 워커에게 일을 맡길 때는 정확히 <<DELEGATE to="${exampleWorker}">>구체적인 작업<</DELEGATE>> 형식으로 출력하세요. 특정 모델이 필요하면 여는 태그에 model="모델명"을, 디자인 작업이면 kind="design"을 추가하세요. 같은 에이전트 워커가 여러 명이면 반드시 워커 ID로 지정하세요. 서로 다른 워커에게 준 위임은 동시에 실행되고, 같은 워커에게 준 위임은 그 워커 세션에서 차례로 실행됩니다. 독립적인 일을 병렬로 돌리려면 다른 워커에게 나누세요. 워커 결과를 받은 뒤 검증하고 사용자에게 최종 답을 작성하세요.\n\n${ORCHESTRATOR_RULES}\n\n${permissionModeRules(this.permissionModeOf(session))}\n\n${cliNotes(session.agent, "orchestrator")}${worktreeNotice}\n\n워커 세션 상태:\n${workerContext}${capabilityCatalog(this.allowedAgents(session), workers.map((worker) => worker.agent))}${skillCatalog(installedSkills)}`;
    const planningContext = plan ? `\n\n계획 전문 에이전트가 작성한 실행 계획:\n${plan}` : "";
    const handoffContext = session.handoffContext ? `\n\n이전 오케스트라의 대화 요약:\n${session.handoffContext}` : "";
    const resumeBrief = session.cliSessionId ? `\n\n이어받기 전 압축 요약:\n${compactHandoff(session.events)}` : "";
    const planMode = this.permissionModeOf(session) === "plan";
    const planNotice = planMode ? `\n\n${PLAN_MODE_NOTICE}${await repoSnapshot(session.cwd).then((facts) => facts ? `\n\n${facts}` : "").catch(() => "")}` : "";
    // A chat the user talks to may split a big request into goal chats; a goal chat never splits again.
    const split = Boolean(session.goal && !session.parentId && !planMode && this.worktreeDataDir && await gitRepo(session.cwd).catch(() => undefined));
    const board = commanderBoard(session, (id) => this.sessions.get(id));
    const goalContext = session.goal ? `\n\n${goalRules(split)}${session.goal.items.length ? `\n\n지금 체크리스트:\n<<CHECKLIST>>\n${renderChecklist(session.goal.items)}\n<</CHECKLIST>>` : ""}${board ? `\n\n이 채팅이 앞서 나눠 맡긴 목표:\n${board}` : ""}` : "";
    const stewardContext = await this.stewardContext(session);
    // Answering another lead without the user's leave to work for it: look and answer only.
    const answerOnly = Boolean(session.steward?.answering && !session.steward.acceptWork);
    const turn: LeadTurn = { controller, userPrompt, systemPrompt, skills, installedSkills, requiresGrokMedia, mediaPrompt, workers, answerOnly, tasks: [], worktrees: new Map() };
    // A lead's own run gets its tools (lead-tools.ts) where the CLI can load MCP; Grok keeps the tags.
    const toolsGuide = session.steward && !planMode && this.stewardDataDir && session.agent !== "grok" ? `\n\n${LEAD_TOOLS_GUIDE}` : "";
    if (session.steward && !planMode) this.leadTurns.set(session.id, turn);
    const prompt = `${systemPrompt ? `${systemPrompt}\n\n` : ""}${orchestration}${goalContext}${stewardContext}${toolsGuide}${skills}${planningContext}${handoffContext}${resumeBrief}${planNotice}\n\n사용자 요청:\n${userPrompt}`;
    const first = await this.runAgent(session, session.agent, prompt, session.model, session.reasoningEffort, session.cliSessionId, controller.signal, true, false, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
    if (controller.signal.aborted) return this.finishStopped(session, controller);
    if (first.sessionId) session.cliSessionId = first.sessionId;
    if (first.exitCode !== 0) throw new Error(`${agentNames[session.agent]} CLI가 종료 코드 ${first.exitCode}로 끝났습니다.`);
    this.noteChecklist(session, first.finalText);
    delete session.handoffContext;
    // Plan mode: the lead's read-only answer is the plan; nothing is handed to workers.
    if (planMode) return this.finish(session);
    // The lead split the request: this chat now runs the goal chats instead of its own workers.
    if (split && this.addGoals(session, first.finalText)) {
      this.turnChecklists.delete(session.id);
      if (session.goal) session.goal.items = [];
      return this.finish(session);
    }

    let refused = false;
    const resolveRequests = async (text: string) => {
      const resolved: Array<{ request: DelegationRequest; worker: AgentSelection }> = [];
      const failures: string[] = [];
      for (const request of parseDelegations(text)) {
        if (answerOnly) {
          if (!refused) this.event(session, session.agent, "warning", "다른 담당의 질문에 답하는 중이라 워커에게 일을 맡기지 않았습니다. 이 프로젝트에서 작업하려면 사용자가 이 채팅에서 시키거나, 담당 패널에서 '다른 담당의 부탁으로 작업하기'를 켜세요.");
          refused = true;
          continue;
        }
        const exact = workers.find((candidate) => candidate.id === request.target);
        const legacyAgent = request.target.toLowerCase();
        const named = legacyAgent === "codex" || legacyAgent === "claude" || legacyAgent === "grok" ? legacyAgent : undefined;
        let worker = exact ?? (named ? workers.find((candidate) => candidate.agent === named) : undefined);
        if (!worker && named) {
          try {
            // The lead chose a CLI its team lacks: add it only after install/login readiness passes.
            worker = await this.addStewardWorker(session, workers, named);
          } catch (error) {
            failures.push(`[${agentNames[named]} 위임 실패]\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (worker) resolved.push({ request, worker: request.model ? { ...worker, model: request.model } : worker });
      }
      return { resolved, failures };
    };
    const firstResolution = await resolveRequests(first.finalText);
    let requests = firstResolution.resolved;
    // Work the lead handed out with delegate_task and has not collected: the review checks it like a round.
    const uncollected = turn.tasks.filter((item) => !item.collected);
    if (uncollected.length) await Promise.all(uncollected.map((item) => item.done));
    if (controller.signal.aborted || uncollected.some((item) => item.status === "stopped")) return this.finishStopped(session, controller);
    const toolResults = [...firstResolution.failures, ...uncollected.map((item) => { item.collected = true; return item.result ?? ""; }).filter(Boolean)];
    if (!requests.length && !toolResults.length) return this.finish(session);
    let pendingResults = toolResults;

    for (let round = 0; ; round++) {
      const workerResults: string[] = pendingResults;
      pendingResults = [];
      const roundWorktrees = round === 0 ? new Map(uncollected.flatMap((item) => { const info = turn.worktrees.get(item.workerId); return info ? [[item.workerId, info] as const] : []; })) : new Map<string, NonNullable<Session["worktrees"]>[number]>();
      // Different workers run at once (each has its own worktree and CLI session); one worker's
      // briefs run in order inside its session. Reports keep the lead's delegation order.
      const runRequest = (item: (typeof requests)[number]) => this.runBrief(session, turn, item.request.task, item.worker, roundWorktrees,
        item.request.kind === "design" ? `\n\n${DESIGN_BRIEF}` : "").catch((error: unknown) => {
          if (error instanceof WorkerFeatureError) return `[${workerLabel(item.worker)} 결과 — 실패]\n${error.message}`;
          throw error;
        });
      const queues = new Map<string, Array<{ index: number; item: (typeof requests)[number] }>>();
      requests.forEach((item, index) => queues.set(item.worker.id!, [...(queues.get(item.worker.id!) ?? []), { index, item }]));
      const outcomes: Array<string | typeof STOPPED | undefined> = new Array(requests.length);
      const settled = await Promise.allSettled([...queues.values()].map(async (queue) => {
        for (const { index, item } of queue) {
          outcomes[index] = await runRequest(item);
          if (outcomes[index] === STOPPED) return;
        }
      }));
      if (controller.signal.aborted || outcomes.includes(STOPPED)) return this.finishStopped(session, controller);
      const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failed) throw failed.reason;
      for (const out of outcomes) if (typeof out === "string") workerResults.push(out);

      if (controller.signal.aborted) return this.finishStopped(session, controller);
      // The user said no to computer use: end the run instead of letting the lead look for workarounds.
      const halt = this.computerHalt?.(session.id, runStartedAt);
      if (halt) throw new Error(halt === "denied" ? "사용자가 컴퓨터 조작을 거부해 작업을 멈췄습니다." : "사용자가 컴퓨터 조작을 중지해 작업을 멈췄습니다.");
      // Like Claude Code and Codex, a worker report that says "상태: 완료" is the answer: no second,
      // context-poor review run (it took as long as the work itself and was often cancelled).
      // A goal session needs the review: that is where the lead checks the work and updates the checklist.
      if (!this.trackingChecklist(session) && workerResults.length && workerResults.every((text) => CLEAN_REPORT.test(text))) {
        this.event(session, session.agent, "message", workerResults.map((text) => workerResults.length === 1 ? text.replace(REPORT_HEADER, "") : text).join("\n\n"), { role: "orchestrator", metadata: { phase: "worker-report", round } });
        return this.finish(session);
      }
      const roundsLeft = maxReplanRounds - round;
      // The review is a fresh CLI session: without this it never sees what the user asked for.
      const originalContext = `\n\n원래 사용자 요청:\n${userPrompt}\n\n당신의 첫 응답:\n${first.finalText}`;
      this.event(session, session.agent, "status", round === 0 ? "총괄이 워커 결과를 검증하고 있습니다." : `총괄이 재계획 ${round}회차 결과를 검증하고 있습니다.`, { role: "orchestrator", metadata: { phase: "verify", round } });
      const roundFailed = workerResults.some((text) => CUT_REPORT.test(text));
      const strict = roundFailed && roundsLeft > 0 && session.agent === "grok";
      const worktreeNote = await worktreeReviewNote([...roundWorktrees.values()], session.steward ? mergeRule(this.stewardOf(session)?.mergePolicy) : Boolean(session.parentId)).catch(() => "");
      const gitFacts = await repoSnapshot(session.cwd).catch(() => "");
      const goalReview = session.goal ? `\n\n${goalRules(false)}${session.goal.items.length ? `\n\n이번 턴 시작 때의 체크리스트:\n<<CHECKLIST>>\n${renderChecklist(session.goal.items)}\n<</CHECKLIST>>` : ""}` : "";
      // The review is a fresh CLI session too: a lead needs its notes and transcript here as well.
      const stewardReview = await this.stewardContext(session);
      const reviewText = `이어받기 전 압축 요약:\n${compactHandoff(session.events)}\n\n${reviewPrompt(workerResults, originalContext, roundsLeft)}${goalReview}${stewardReview}${worktreeNote ? `\n\n${worktreeNote}` : ""}${gitFacts ? `\n\n${gitFacts}` : ""}` + (strict ? `\n\n[필수] 실패한 워커가 있습니다. 총괄은 파일 수정·명령 실행으로 직접 일을 하지 말고, 다른 접근의 <<DELEGATE>>로 재위임하세요. 읽기 전용 확인만 허용됩니다.` : "");
      const reviewStart = session.events.length;
      let review = await this.runAgent(session, session.agent, reviewText, session.model, session.reasoningEffort, undefined, controller.signal, false, true, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      if (review.exitCode !== 0) throw new Error(`${agentNames[session.agent]} 후속 실행이 종료 코드 ${review.exitCode}로 끝났습니다.`);
      this.noteChecklist(session, review.finalText);
      // Exit code 0 but the CLI stopped early: hand over the workers' reports instead of a silent "완료".
      if (session.events.slice(reviewStart).some((event) => event.type === "error" && event.role === "orchestrator" && /중단되었습니다 \(/u.test(event.text))) {
        this.event(session, session.agent, "warning", "총괄 검증이 중간에 끊겼습니다. 아래는 검증하지 못한 워커 보고입니다.", { role: "orchestrator", metadata: { phase: "verify-cut", round } });
        this.event(session, session.agent, "message", workerResults.join("\n\n"), { role: "orchestrator", metadata: { phase: "worker-report", round } });
        return this.finish(session);
      }
      const nextResolution = roundsLeft > 0 ? await resolveRequests(review.finalText) : { resolved: [], failures: [] };
      let next = nextResolution.resolved;
      pendingResults.push(...nextResolution.failures);
      if (roundFailed && !next.length) {
        const selfWork = session.events.slice(reviewStart).filter((event) => event.role === "orchestrator" && (event.type === "edit" || event.type === "command" || event.type === "tool") && /^(명령|파일 (수정|쓰기|생성)|편집|쓰기)\s*:/u.test(event.text));
        this.event(session, session.agent, "warning", `검증 실패 후 총괄이 재위임하지 않고 ${selfWork.length ? `직접 작업했습니다 (${selfWork.length}건: ${selfWork.slice(0, 3).map((event) => event.text.slice(0, 60)).join(", ")})` : "마무리하려 합니다"}.`, { role: "orchestrator", metadata: { phase: "self-work", round } });
        if (strict) {
          // Enforce once: Grok orchestrators must hand the failed work back to a worker.
          review = await this.runAgent(session, session.agent, `방금 응답에 <<DELEGATE>>가 없습니다. 실패한 작업을 다른 접근으로 워커에게 재위임하세요(6개 제목 사용). 정말 재위임이 불가능하면 그 이유를 한 줄로 쓰고 끝내세요.`, session.model, session.reasoningEffort, session.cliSessionId, controller.signal, true, false, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
          if (review.sessionId) session.cliSessionId = review.sessionId;
          if (controller.signal.aborted) return this.finishStopped(session, controller);
          const enforcedResolution = review.exitCode === 0 ? await resolveRequests(review.finalText) : { resolved: [], failures: [] };
          next = enforcedResolution.resolved;
          pendingResults.push(...enforcedResolution.failures);
          if (review.exitCode === 0) this.noteChecklist(session, review.finalText);
        }
      }
      // The lead gave up on a blocked worker: that is not a finished task, whatever the lead wrote.
      // A worker the app cut off is the lead's to judge: it often finished before the cut, and the review checks git.
      if (!next.length && !pendingResults.length) return this.finish(session, workerResults.some((text) => BLOCKED_REPORT.test(text)));
      const status = next.length
        ? `총괄이 다시 계획해 ${next.length}건을 재위임합니다 (남은 기회 ${roundsLeft - 1}회).`
        : `재위임할 CLI를 사용할 수 없어 원인을 총괄에게 전달합니다 (남은 기회 ${roundsLeft - 1}회).`;
      this.event(session, session.agent, "status", status, { role: "orchestrator", metadata: { phase: "replan", round: round + 1 } });
      requests = next;
    }
  }

  /**
   * One brief for one worker: worktree, prompt, stall guard, resume and retry. Briefs for the same
   * worker wait for each other (one CLI session each); different workers run at once. Used by the
   * <<DELEGATE>> rounds and by the lead's delegate_task tool.
   */
  private runBrief(session: Session, turn: LeadTurn, task: string, worker: AgentSelection, roundWorktrees: Map<string, NonNullable<Session["worktrees"]>[number]>, extra = ""): Promise<string | typeof STOPPED> {
    const key = guardKey(session.id, worker.id!);
    const previous = this.workerChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runBriefNow(session, turn, task, worker, roundWorktrees, extra));
    const tail = run.catch(() => undefined);
    this.workerChains.set(key, tail);
    void tail.then(() => { if (this.workerChains.get(key) === tail) this.workerChains.delete(key); });
    return run;
  }

  private async runBriefNow(session: Session, turn: LeadTurn, task: string, worker: AgentSelection, roundWorktrees: Map<string, NonNullable<Session["worktrees"]>[number]>, extra: string): Promise<string | typeof STOPPED> {
    const { controller, userPrompt, systemPrompt, skills, installedSkills, requiresGrokMedia, mediaPrompt } = turn;
    if (controller.signal.aborted) return STOPPED;
    const brief = ensureBrief(task, userPrompt);
    const workerId = worker.id!;
    const resumeIdForBrief = worker.sessionMode === "new" ? undefined : workerSessionId(session, workerId);
    const workerResume = resumeIdForBrief ? `\n\n이어받기 전 압축 요약:\n${compactHandoff(session.events, workerId)}` : "";
    const label = workerLabel(worker);
    const worktree = await this.prepareWorktree(session, workerId, label);
    if (controller.signal.aborted) return STOPPED;
    if (worktree.info) roundWorktrees.set(workerId, worktree.info);
    const designExtra = designBriefRequested(`${task}\n${extra}`) && !extra.includes(DESIGN_BRIEF) ? `\n\n${DESIGN_BRIEF}` : "";
    const workerPrompt = `${requiresGrokMedia && mediaPrompt ? `${mediaPrompt}\n\n` : ""}${systemPrompt ? `${systemPrompt}\n\n` : ""}상위 에이전트가 다음 작업을 위임했습니다. 작업 결과를 간결하고 구체적으로 보고하세요.\n\n${WORKER_RULES}\n\n${cliNotes(worker.agent, "worker")}${skills}\n\n${brief.text}${workerSkillSection(task, installedSkills, worker.agent)}${worktree.info ? `\n\n${worktreeWorkerNote(worktree.info, session.cwd)}` : ""}${extra}${designExtra}${workerResume}`;
    const delegation = this.event(session, worker.agent, "delegation", task, { role: "worker", workerId, workerLabel: label, taskStatus: "running", model: worker.model, reasoningEffort: worker.reasoningEffort, ...(brief.missing.length ? { metadata: { briefAutofilled: brief.missing } } : {}) });
    const delegationId = delegation?.id;
    if (worktree.info) this.event(session, worker.agent, "status", `작업 브랜치 ${worktree.info.branch} — ${worktree.info.path}${worktree.info.mainDirty ? " (메인 폴더의 커밋되지 않은 변경은 포함되지 않음)" : ""}`, { role: "worker", workerId, workerLabel: label, delegationId });
    else if (worktree.error) this.event(session, worker.agent, "warning", `worktree를 만들지 못해 세션 폴더에서 실행합니다: ${worktree.error}`, { role: "worker", workerId, workerLabel: label, delegationId });
    const resumeId = resumeIdForBrief;
    if (!resumeId) setWorkerSessionId(session, workerId);
    const guard = { kill: new AbortController(), detector: new StallDetector(this.stallOptions) } as { kill: AbortController; detector: StallDetector; stall?: StallSignal };
    this.workerGuards.set(guardKey(session.id, workerId), guard);
    const idleTimer = setInterval(() => {
      const stall = guard.detector.checkIdle();
      if (stall && !guard.stall) this.tripStall(session, guard, stall, worker.agent, workerId, label, delegationId);
    }, Math.min(stallCheckMs, Math.max(50, Math.floor(guard.detector.idleMs / 4))));
    idleTimer.unref();
    const runWorker = (id?: string) => this.runAgent(session, worker.agent, workerPrompt, worker.model, worker.reasoningEffort, id, controller.signal, false, false, "worker", delegationId, workerId, label, requiresGrokMedia);
    let result;
    const eventStart = session.events.length;
    try {
      try {
        result = await runWorker(resumeId);
      } catch (error) {
        if (!resumeId || controller.signal.aborted || isQuotaExhaustion(error) || guard.stall) throw error;
      }
      if (resumeId && !controller.signal.aborted && !guard.stall && (!result || result.exitCode !== 0 && !result.quotaFailure)) {
        setWorkerSessionId(session, workerId);
        this.event(session, worker.agent, "status", "이전 세션에 연결하지 못해 새 세션으로 다시 시작합니다.", { role: "worker", workerId, workerLabel: label, delegationId });
        result = await runWorker();
      }
    } catch (error) {
      if (!guard.stall) throw error;
    } finally {
      clearInterval(idleTimer);
      if (this.workerGuards.get(guardKey(session.id, workerId)) === guard) this.workerGuards.delete(guardKey(session.id, workerId));
    }
    if (controller.signal.aborted) return STOPPED;
    if (guard.stall) {
      if (result?.sessionId) setWorkerSessionId(session, workerId, result.sessionId);
      const partial = result?.finalText?.trim();
      const out = `[${label} 결과 — 앱이 정체를 감지해 중단함]\n원인: ${guard.stall.reason}\n최근 기록:\n${guard.stall.evidence.map((line) => `- ${line}`).join("\n")}${partial ? `\n중단 전 마지막 응답:\n${partial.slice(-1_500)}` : ""}\n→ 같은 방법을 반복하지 말고 원인을 진단해 다른 접근으로 다시 계획하세요.`;
      return out;
    }
    if (!result) throw new Error("작업자 세션을 시작할 수 없습니다.");
    if (result.sessionId) setWorkerSessionId(session, workerId, result.sessionId);
    const invocationWarnings = workerInvocationWarnings({ agent: result.agent, brief: `${task}\n${extra}`, skills: `${skills}\n${extra.includes("선택된 스킬 지침:") ? extra : ""}`, tools: result.toolText, output: result.outputText });
    for (const warning of invocationWarnings) this.event(session, result.agent, "warning", warning, { role: "worker", workerId, workerLabel: label, delegationId });
    const invocationNote = invocationWarnings.length ? `\n\n기능 실행 확인(최선 노력):\n${invocationWarnings.map((warning) => `- ${warning}`).join("\n")}` : "";
    if (result.exitCode !== 0) {
      this.event(session, result.agent, "error", `${label} 워커가 종료 코드 ${result.exitCode}로 끝났습니다.`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", model: result.model, reasoningEffort: result.reasoningEffort });
      // A recognizable feature blocker is actionable feedback for the lead, even on a failed CLI run.
      if (invocationWarnings.some((warning) => warning.startsWith("Claude /design 사용이 막혔습니다:"))) throw new WorkerFeatureError(`${result.finalText}${invocationNote}`);
      throw new Error(`${agentNames[result.agent]} 워커가 종료 코드 ${result.exitCode}로 끝났습니다.${invocationNote}`);
    }
    const report = (result.finalText || `${agentNames[result.agent]}가 결과 없이 종료되었습니다(코드 ${result.exitCode}).`) + invocationNote;
    // Exit code 0 but the CLI reported it stopped early (e.g. Grok "cancelled"): not a success.
    const interrupted = session.events.slice(eventStart).find((event) => event.type === "error" && event.delegationId === delegationId && /중단되었습니다 \(/.test(event.text));
    if (interrupted) {
      const out = `[${label} 결과 — 중단됨: ${interrupted.text} 아래 내용은 불완전할 수 있다]\n${report}`;
      this.event(session, result.agent, "status", `작업이 중간에 중단되었습니다. ${interrupted.text}`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", model: result.model, reasoningEffort: result.reasoningEffort });
      return out;
    }
    this.event(session, result.agent, "status", "작업을 완료했습니다.", { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "done", model: result.model, reasoningEffort: result.reasoningEffort });
    return `[${label} 결과]\n${report}`;
  }

  /** Creates or reuses the worker's git worktree; `{}` when worktrees are off or the folder is not in git. */
  private async prepareWorktree(session: Session, workerId: string, label: string): Promise<{ info?: NonNullable<Session["worktrees"]>[number]; error?: string }> {
    if (!this.worktreeDataDir) return {};
    const dataDir = this.worktreeDataDir;
    return this.withWorktreeLock(session.id, () => this.prepareWorktreeLocked(session, workerId, label, dataDir));
  }

  private async prepareWorktreeLocked(session: Session, workerId: string, label: string, dataDir: string): Promise<{ info?: NonNullable<Session["worktrees"]>[number]; error?: string }> {
    const existing = session.worktrees?.find((item) => item.workerId === workerId);
    try {
      const info = await ensureWorkerWorktree({ dataDir, sessionId: session.id, workerId, workerLabel: label, cwd: session.cwd, existing });
      if (!info) return {};
      session.worktrees = [...(session.worktrees ?? []).filter((item) => item.workerId !== workerId), info];
      return { info };
    } catch (error) {
      if (existing) session.worktrees = session.worktrees?.filter((item) => item !== existing);
      return { error: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300) };
    }
  }

  /** Lead prompt section: workers get separate worktrees, so results live on branches. */
  private async worktreeNotice(session: Session): Promise<string> {
    if (!this.worktreeDataDir || !await gitRepo(session.cwd).catch(() => undefined)) return "";
    const dirty = await mainTreeDirty(session.cwd).catch(() => false);
    const checkouts = await userWorktrees(session.cwd, this.worktreeDataDir).catch(() => []);
    const siblings = checkouts.length > 1 ? `\n\n## 이 저장소의 사용자 작업 폴더 (git worktree)\n같은 저장소를 사용자가 여러 폴더로 나눠 쓰고 있습니다. 세션 폴더는 \`${session.cwd}\`입니다.\n${checkouts.map((item) => `- \`${item.path}\` — ${item.branch ? `브랜치 \`${item.branch}\`` : "detached"} @ ${item.head}`).join("\n")}\n사용자가 "기존꺼", "다른 폴더/워크트리", 브랜치 이름을 말하면 이 목록에서 찾아 확인하고 쓰세요. 배포·롤백 대상이 어느 폴더·브랜치인지 원격 브랜치와 비교해 정합니다.` : "";
    return `${siblings}\n\n## 워커 작업 위치 (git worktree)
이 세션 폴더는 git 저장소입니다. 파일을 고치는 워커는 각자 전용 git worktree와 브랜치(\`sinawi/${session.id.slice(0, 8)}/<워커 ID>\`)에서 일하고, 메인 폴더는 바뀌지 않습니다. 같은 라운드의 워커들은 서로의 변경을 보지 못하므로, 서로 의존하는 일은 한 워커에게 맡기거나 다음 라운드로 나누세요. 같은 워커는 다음 라운드에도 자기 worktree를 이어 씁니다. 워커 결과와 함께 각 worktree의 경로·브랜치·바뀐 파일을 알려 드립니다. 검토는 그 경로에서 하세요. ${session.steward ? `이 채팅은 프로젝트 담당입니다. ${mergeRule(this.stewardOf(session)?.mergePolicy)}` : session.parentId ? "이 세션은 총지휘의 목표라서, 체크리스트가 모두 끝나면 앱이 브랜치를 메인 폴더에 병합합니다." : "앱은 자동 병합하지 않습니다. 최종 답에 브랜치 이름을 적고, 병합은 개발자가 직접 한다고 알리세요."}${dirty ? "\n메인 폴더에 커밋되지 않은 변경이 있습니다. worktree는 마지막 커밋(HEAD) 기준이라 그 변경이 들어 있지 않습니다. 워커 브리프의 맥락에 이 사실을 적으세요." : ""}`;
  }

  /** Runs `task` while holding the session's worktree mutex (queued behind earlier holders). */
  private withWorktreeLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.worktreeLocks.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.worktreeLocks.set(sessionId, tail);
    void tail.then(() => { if (this.worktreeLocks.get(sessionId) === tail) this.worktreeLocks.delete(sessionId); });
    return run;
  }

  /** Resolves once every CLI run in flight for the session right now has finished (its process exited). */
  private async cliRunsSettled(sessionId: string): Promise<void> {
    const runs = [...(this.inflightRuns.get(sessionId) ?? [])];
    if (runs.length) await Promise.allSettled(runs);
  }

  /**
   * After a run ends: drop worktrees that hold nothing (no changed file, no commit). Waits for the
   * session's CLI processes to exit first (an aborted worker may still write during the SIGTERM
   * grace period), then holds the worktree mutex and re-checks, right before each deletion, that the
   * session is still idle; the status itself is re-read inside removeWorktree.
   */
  private async pruneWorktrees(session: Session): Promise<void> {
    if (!this.worktreeDataDir || !session.worktrees?.length) return;
    await this.cliRunsSettled(session.id);
    await this.withWorktreeLock(session.id, async () => {
      const idle = () => session.status !== "running" && this.sessions.get(session.id) === session;
      const before = session.worktrees;
      if (!before?.length || !idle()) return;
      const kept = new Set(await pruneEmptyWorktrees(before, { canRemove: idle }).catch(() => before));
      const removed = new Set(before.filter((info) => !kept.has(info)));
      if (!removed.size) return;
      const remaining = (session.worktrees ?? []).filter((info) => !removed.has(info));
      if (remaining.length) session.worktrees = remaining;
      else delete session.worktrees;
      this.broadcast(session);
    }).catch(() => undefined);
  }

  /** Stall detected: tell the user, stop only this worker's CLI, and let the orchestrator re-plan. */
  private tripStall(session: Session, guard: { kill: AbortController; stall?: StallSignal }, stall: StallSignal, agent: AgentId, workerId: string, label: string, delegationId?: string): void {
    if (guard.stall) return;
    guard.stall = stall;
    this.event(session, agent, "warning", `정체 감지: ${stall.reason} 작업자를 멈추고 총괄이 다시 계획합니다.`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", metadata: { stall: stall.kind } });
    guard.kill.abort();
  }

  private runSelection(session: Session, selection: AgentSelection, prompt: string, resumeSessionId: string | undefined, signal: AbortSignal) {
    return this.runAgent(session, selection.agent, prompt, selection.model, selection.reasoningEffort, resumeSessionId, signal, false, true, "planner");
  }

  private applyPendingInstructions(session: Session, role: SessionEvent["role"], workerId?: string): string {
    const { taken, rest } = takePending(session.pendingInstructions, role, workerId);
    if (!taken.length) return "";
    if (rest.length) session.pendingInstructions = rest;
    else delete session.pendingInstructions;
    return instructionSuffix(taken);
  }

  private liveWorkers(session: Session): LiveWorker[] {
    return normalizeWorkerConfigs(session.workers, session.workerConfigs).map((worker) => ({
      id: worker.id!,
      label: workerLabel(worker),
      agent: worker.agent,
    }));
  }

  /** Queues a message for the team's next turn; `answer` is the reply already given to it, shown above the note. */
  private enqueueInstruction(session: Session, text: string, targetWorkerId?: string, answer = ""): void {
    const item = { id: randomUUID(), text, targetWorkerId, createdAt: new Date().toISOString() };
    session.pendingInstructions = pushInstruction(session.pendingInstructions, item);
    const worker = this.liveWorkers(session).find((candidate) => candidate.id === targetWorkerId);
    const ack = worker
      ? `${worker.label}의 다음 턴에 전달합니다. 진행 중인 작업은 그대로 둡니다.`
      : "총괄의 다음 턴에 전달합니다. 진행 중인 작업은 그대로 둡니다.";
    this.event(session, "grok", "message", answer ? `${answer}\n\n${ack}` : ack, { metadata: { live: "directive", targetWorkerId } });
  }

  /**
   * A message typed while a session is already running. Like Claude Code, it never waits for the task:
   * a fast model answers it from the log and says whether it carries work, which then reaches the
   * lead or the named worker on its next turn. Never starts a second task.
   */
  async liveTurn(id: string, prompt: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status !== "running") return this.followup(id, prompt);
    const workers = this.liveWorkers(session);
    if (classifyLiveMessage(prompt, workers).intent === "stop") return this.stop(id);
    const digest = statusDigest(session);
    this.event(session, "user", "message", prompt);
    // The reply is a Grok CLI run, so it obeys the workspace policy; without Grok the message still reaches the lead.
    if (!this.agentAllowed(session.workspaceId, "grok")) {
      this.enqueueInstruction(session, prompt);
      return session;
    }
    const controller = new AbortController();
    // Ref'd on purpose: the abort is what ends the reply run if the CLI hangs; `finally` clears it.
    const timer = setTimeout(() => controller.abort(), 45_000);
    let text = "";
    try {
      const result = await this.runner({
        accountDir: accountDirFor(this.workspacePolicyResolver?.(session.workspaceId), "grok"),
        agent: "grok",
        prompt: liveReplyPrompt(prompt, digest, workers),
        cwd: session.cwd,
        model: STATUS_AGENT_MODEL,
        readOnly: true,
        signal: controller.signal,
        usageContext: { workspaceId: session.workspaceId, sessionId: session.id, role: "status", dataDir: this.usageDataDir },
        onLine: () => undefined,
      });
      text = result.finalText;
    } catch {
      text = "";
    } finally {
      clearTimeout(timer);
    }
    const reply = parseLiveReply(text, workers);
    let answer = reply.answer.length > 2000 ? `${reply.answer.slice(0, 1999)}…` : reply.answer;
    // No usable routing line: pass it on. A dropped instruction costs far more than an extra note to the lead.
    if (reply.forward || !reply.decided) {
      this.enqueueInstruction(session, prompt, reply.forward?.targetWorkerId, answer || (text ? "" : "지금 바로 답하지 못했습니다."));
      return session;
    }
    if (!answer) answer = "로그에서 상태를 정리하지 못했습니다. 작업은 그대로 진행 중입니다.";
    this.event(session, "grok", "message", answer, { metadata: { live: "status", ambiguous: false, prompt } });
    return session;
  }

  promoteLive(id: string, eventId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    const event = session.events.find((item) => item.id === eventId);
    if (!event?.metadata || event.metadata.live !== "status" || !event.metadata.ambiguous || !event.metadata.prompt) {
      throw new Error("이 응답은 지시로 바꿀 수 없습니다.");
    }
    if (event.metadata.promoted) return session;
    const prompt = event.metadata.prompt;
    event.metadata = { ...event.metadata, promoted: true };
    this.markEventsRewritten(session);
    const target = classifyLiveMessage(prompt, this.liveWorkers(session)).targetWorkerId;
    this.enqueueInstruction(session, prompt, target);
    return session;
  }

  private async runAgent(session: Session, agent: AgentId, prompt: string, model: string | undefined, reasoningEffort: string | undefined, resumeSessionId: string | undefined, signal: AbortSignal, trackPrimarySession = true, readOnly = false, role: SessionEvent["role"] = "orchestrator", delegationId?: string, workerId?: string, workerName?: string, requiresGrokMedia = false) {
    this.requireCurrentRun(session, signal);
    const pendingNote = this.applyPendingInstructions(session, role, workerId);
    if (pendingNote) prompt = `${prompt}\n\n${pendingNote}`;
    const priorAgent = agent;
    const mediaWorker = requiresGrokMedia && role === "worker";
    const grokMediaTask = agent === "grok" && requiresGrokMedia && !mediaWorker;
    // Media handoffs belong to an individual worker, never the Grok coordinator.
    const activeTarget = requiresGrokMedia ? agent : this.activeFallbackTarget(session, agent);
    const choose = (context: QuotaFallbackContext) => selectQuotaFallback(agent,
      mediaWorker ? this.mediaWorkers(session.workspaceId) : this.allowedAgents(session),
      context.authenticated, context.quotas, mediaWorker ? { [agent]: [agent === "grok" ? "codex" : "grok"] } : context.order, session.workspaceId, context.threshold);
    let mediaFallbackReason = "한도 소진";
    const switchAgent = (fallback: AgentId, resetsAt?: number) => mediaWorker
      ? this.switchMediaWorker(session, workerId, agent, fallback, model, reasoningEffort, delegationId, mediaFallbackReason)
      : this.switchExhaustedAgent(session, agent, fallback, model, reasoningEffort, resetsAt);
    if (activeTarget !== agent && (role !== "worker" || session.workers.includes(activeTarget))) {
      const mapped = equivalentFallbackModel(agent, activeTarget, model, reasoningEffort);
      agent = activeTarget;
      model = mapped.model;
      reasoningEffort = mapped.reasoningEffort;
      resumeSessionId = undefined;
      prompt = this.remapFallbackPrompt(prompt, priorAgent, agent, session, role);
    }
    const context = this.quotaFallbackResolver ? await this.quotaFallbackContext(session, signal) : undefined;
    this.requireCurrentRun(session, signal);
    const quotaState = exhaustionFromQuota(context?.quotas.find((quota) => quota.agent === agent), context?.threshold);
    if (context?.enabled && quotaState.exhausted) {
      if (grokMediaTask) throw new Error(mediaUnavailableMessage);
      const fallback = choose(context);
      if (fallback) {
        const mapped = switchAgent(fallback, quotaState.resetsAt);
        return this.runAgentOnce(session, fallback, this.remapFallbackPrompt(prompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
      }
    }

    let first;
    try {
      first = await this.runAgentOnce(session, agent, prompt, model, reasoningEffort, resumeSessionId, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
    } catch (error) {
      const missingCli = mediaWorker && /\b(?:ENOENT|EACCES)\b/.test(error instanceof Error ? error.message : String(error));
      if (!context?.enabled || !(isQuotaExhaustion(error) || missingCli) || signal.aborted) throw error;
      if (missingCli) mediaFallbackReason = "CLI 사용 불가";
      if (grokMediaTask) throw new Error(mediaUnavailableMessage, { cause: error });
      const fallback = choose(context);
      if (!fallback) throw error;
      const mapped = switchAgent(fallback, this.knownReset(context, agent));
      const retryPrompt = missingCli
        ? `${prompt}\n\n이전 워커의 CLI를 사용할 수 없어 작업을 이어받았습니다. 원래 작업을 계속 완료하세요.`
        : this.fallbackRetryPrompt(session, role, prompt, agent, error instanceof Error ? error.message : String(error), delegationId);
      try {
        return await this.runAgentOnce(session, fallback, this.remapFallbackPrompt(retryPrompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
      } catch (retryError) {
        if (isQuotaExhaustion(retryError)) Object.assign(retryError as object, { quotaFailure: true });
        throw retryError;
      }
    }

    const exhaustedEvidence = runExhausted(first);
    if (!context?.enabled || !exhaustedEvidence || signal.aborted) return first;
    if (grokMediaTask) throw new Error(mediaUnavailableMessage);
    const fallback = choose(context);
    if (!fallback) return { ...first, exitCode: first.exitCode || 1, quotaFailure: true };
    const mapped = switchAgent(fallback, this.knownReset(context, agent));
    const retryPrompt = this.fallbackRetryPrompt(session, role, prompt, agent, first.outputText, delegationId);
    const retried = await this.runAgentOnce(session, fallback, this.remapFallbackPrompt(retryPrompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
    const retryExhausted = runExhausted(retried);
    return retryExhausted ? { ...retried, exitCode: retried.exitCode || 1, quotaFailure: true } : retried;
  }

  private async runAgentOnce(session: Session, agent: AgentId, prompt: string, model: string | undefined, reasoningEffort: string | undefined, resumeSessionId: string | undefined, signal: AbortSignal, trackPrimarySession = true, readOnly = false, role: SessionEvent["role"] = "orchestrator", delegationId?: string, workerId?: string, workerName?: string) {
    this.requireCurrentRun(session, signal);
    this.assertPolicy(session.workspaceId, [agent]);
    const policy = this.workspacePolicyResolver?.(session.workspaceId);
    const permissionMode = this.permissionModeOf(session);
    if (permissionMode === "plan") readOnly = true;
    // Claude has no media generation tools, so the workspace's media worker hint does not apply to it.
    if (agent === "claude" && policy?.mediaPrompt) prompt = prompt.replace(`${policy.mediaPrompt}\n\n`, "");
    const originalDelegation = delegationId ? session.events.find((event) => event.id === delegationId) : undefined;
    if (role === "worker" && originalDelegation && originalDelegation.agent !== agent) {
      this.event(session, agent, "status", "작업을 이어받고 있습니다.", { role: "worker", workerId, workerLabel: workerName, delegationId, taskStatus: "running", model, reasoningEffort });
    }
    let lastCompleteMessage = "";
    const output: string[] = [];
    // What the CLI itself said. Tool output (a file, a grep, a screenshot read as base64) can contain
    // "429" or "quota" and is never the provider refusing the run.
    const cliOutput: string[] = [];
    const toolOutput: string[] = [];
    let quotaErrorEvidence = false;
    const disabledMcp = workspaceToolSettings(await loadToolSettings(this.usageDataDir), session.workspaceId).disabledMcp;
    this.requireCurrentRun(session, signal);
    const blockedMcp = disabledMcp.filter((key) => key.startsWith(`${agent}:`))
      .map((key) => `mcp__${key.slice(agent.length + 1)}__*`);
    const guard = role === "worker" ? this.workerGuards.get(guardKey(session.id, workerId ?? agent)) : undefined;
    const runSignal = guard ? AbortSignal.any([signal, guard.kill.signal]) : signal;
    // Workers run in their own worktree; read-only lead runs may read every worktree of the session.
    const cwd = role === "worker" && workerId ? session.worktrees?.find((item) => item.workerId === workerId)?.cwd ?? session.cwd : session.cwd;
    // Every run may also read the screenshots ao-browser/ao-computer save outside the worktree.
    const extraDirs = [...(readOnly && role === "orchestrator" ? session.worktrees?.map((item) => item.path) ?? [] : []), QUEUE_DIR, SHOT_DIR];
    // A worktree worker reads (never edits) the main checkout: uncommitted docs and node_modules live there.
    const worktreeRoot = role === "worker" && workerId ? session.worktrees?.find((item) => item.workerId === workerId)?.repoRoot : undefined;
    const pending = this.runner({
      // The workspace's CLI login for this agent (CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME), if it has one.
      accountDir: accountDirFor(policy, agent),
      blockedMcp: [...new Set([...blockedMcp, ...policyDenyPatterns(policy, agent)])],
      lockedMcp: lockedToolsFor(policy, agent),
      // Review/planning runs are read-only but must still be able to read files to verify (see readTools).
      agent, prompt, cwd, model, reasoningEffort, readOnly, readTools: readOnly, resumeSessionId, signal: runSignal,
      ...(permissionMode === "full" ? { fullAccess: true } : {}),
      extraDirs,
      ...(worktreeRoot ? { readOnlyDirs: [worktreeRoot] } : {}),
      // The lead's own writable run carries its tools (lead-tools.ts); reviews and plans do not.
      ...(role === "orchestrator" && !readOnly && session.steward && this.stewardDataDir && this.leadTurns.has(session.id) ? { leadTools: true } : {}),
      usageContext: { workspaceId: session.workspaceId, sessionId: session.id, role, dataDir: this.usageDataDir, ...(role === "worker" && workerId ? { workerId } : {}) },
      onActivity: () => this.heartbeat(session, signal, guard && !guard.stall ? guard.detector : undefined),
      onDraft: (text) => {
        if (this.controllers.get(session.id)?.signal !== signal && text) return;
        this.sessionDraft?.({ sessionId: session.id, agent, role, workerId, text });
      },
      onLine: (line) => {
        if (this.controllers.get(session.id)?.signal !== signal) return;
        if (line.type !== "message" && isPureNoise(line.text)) return;
        if (line.type !== "message") line = { ...line, text: stripToolNoise(line.text) };
        if (guard && !guard.stall) {
          const stall = guard.detector.observe(line);
          if (stall) this.tripStall(session, guard, stall, agent, workerId ?? agent, workerName ?? agent, delegationId);
        }
        output.push(line.text);
        if (line.type === "tool" || line.type === "command") toolOutput.push(line.text);
        if (line.type !== "tool" && line.type !== "command") cliOutput.push(line.text);
        if (line.type === "error" && isQuotaExhaustion(line.text)) quotaErrorEvidence = true;
        if (trackPrimarySession && line.sessionId && agent === session.agent) session.cliSessionId = line.sessionId;
        if (role === "worker" && workerId && line.sessionId) setWorkerSessionId(session, workerId, line.sessionId);
        if (line.type === "message" && !line.appendFinal) {
          if (line.text === lastCompleteMessage) return;
          lastCompleteMessage = line.text;
        }
        this.event(session, agent, line.type, line.text, { role, workerId, workerLabel: workerName, delegationId, model, reasoningEffort });
      },
    });
    const inflight = this.inflightRuns.get(session.id) ?? new Set<Promise<unknown>>();
    this.inflightRuns.set(session.id, inflight);
    inflight.add(pending);
    let result: Awaited<typeof pending>;
    try { result = await pending; }
    finally {
      inflight.delete(pending);
      if (!inflight.size && this.inflightRuns.get(session.id) === inflight) this.inflightRuns.delete(session.id);
    }
    // A run the stall guard stopped ended because the app killed it, not because a quota ran out.
    const stoppedByApp = Boolean(guard?.kill.signal.aborted);
    return { ...result, agent, model, reasoningEffort, outputText: `${output.join("\n")}\n${result.finalText}`, toolText: toolOutput.join("\n"), cliText: `${cliOutput.join("\n")}\n${result.finalText}`, quotaErrorEvidence, stoppedByApp, quotaFailure: false };
  }

  private async quotaFallbackContext(session: Session, signal?: AbortSignal): Promise<QuotaFallbackContext | undefined> {
    if (!this.quotaFallbackResolver) return;
    try { return await this.quotaFallbackResolver(session); }
    catch {
      if (signal && !this.isCurrentRun(session, signal)) return;
      const warning = "한도 정보를 불러오지 못해 자동 전환을 건너뜁니다.";
      if (!session.events.some((event) => event.type === "status" && event.text === warning)) {
        this.event(session, session.agent, "status", warning, { role: "orchestrator" });
      }
      return;
    }
  }

  private activeFallbackTarget(session: Session, initial: AgentId): AgentId {
    let current = initial;
    for (let step = 0; step < 3; step++) {
      const handoff = [...session.events].reverse().find((event) => event.metadata?.quotaFallback && !event.metadata.undone && event.metadata.from === current);
      if (!handoff?.metadata?.to || handoff.metadata.to === current) break;
      current = handoff.metadata.to;
    }
    return current;
  }

  private knownReset(context: QuotaFallbackContext, agent: AgentId): number | undefined {
    const now = Date.now() / 1_000;
    return context.quotas.find((quota) => quota.agent === agent)?.windows
      .map((window) => window.resetsAt)
      .filter((reset): reset is number => reset !== undefined && reset > now)
      .sort((left, right) => left - right)[0];
  }

  private remapFallbackPrompt(prompt: string, from: AgentId, to: AgentId, session: Session, role?: SessionEvent["role"]): string {
    const workers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    const roster = prompt.replace(/사용 가능한 워커: .*?(?=\. 워커에게 일을 맡길 때는)/u, `사용 가능한 워커: ${workerRoster(workers)}`);
    if (role !== "orchestrator" && role !== "worker") return roster;
    return retargetCliNotes(roster, from, to, role);
  }

  private switchMediaWorker(session: Session, workerId: string | undefined, from: AgentId, to: AgentId, model?: string, effort?: string, delegationId?: string, reason = "한도 소진") {
    const mapped = equivalentFallbackModel(from, to, model, effort);
    const before = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workerConfigs = before.map((worker) => worker.id === workerId
      ? { ...relabelForAgent(worker, from), agent: to, ...mapped, sessionMode: "new" }
      : worker);
    session.workers = session.workerConfigs.map((worker) => worker.agent);
    clearChangedWorkerSessions(session, before, session.workerConfigs);
    this.event(session, to, "status", `${agentNames[from]} ${reason} → ${agentNames[to]} 워커로 전환`, {
      role: "worker", workerId, delegationId, taskStatus: "running", ...mapped,
    });
    return mapped;
  }

  private switchExhaustedAgent(session: Session, exhausted: AgentId, fallback: AgentId, invocationModel?: string, invocationEffort?: string, resetsAt?: number): { model?: string; reasoningEffort?: string } {
    const previousConfig = this.teamConfig(session);
    const previousPlanner = session.planner ? structuredClone(session.planner) : undefined;
    const primaryMapped = equivalentFallbackModel(exhausted, fallback, session.model, session.reasoningEffort);
    if (session.agent === exhausted) {
      session.handoffContext = this.conversationSummary(session, exhausted);
      session.agent = fallback;
      session.model = primaryMapped.model;
      session.reasoningEffort = primaryMapped.reasoningEffort;
      delete session.cliSessionId;
    }
    const previousWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workers = session.workers.map((worker) => worker === exhausted ? fallback : worker);
    session.workerConfigs = session.workerConfigs?.map((config) => {
      if (config.agent !== exhausted) return config;
      return { ...relabelForAgent(config, exhausted), agent: fallback, ...equivalentFallbackModel(exhausted, fallback, config.model, config.reasoningEffort), sessionMode: "new" };
    });
    session.workerConfigs = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    if (session.planner?.agent === exhausted) {
      session.planner = { ...session.planner, agent: fallback, ...equivalentFallbackModel(exhausted, fallback, session.planner.model, session.planner.reasoningEffort), sessionMode: "new" };
    }
    clearChangedWorkerSessions(session, previousWorkers, session.workerConfigs);
    const resetLabel = resetsAt === undefined ? "" : ` (리셋 ${new Date(resetsAt * 1_000).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\. /gu, "/").replace(/\./gu, "")})`;
    this.event(session, fallback, "handoff", `${agentNames[exhausted]} 한도 소진 → ${agentNames[fallback]}로 전환${resetLabel}`, {
      role: "orchestrator",
      model: session.agent === fallback ? session.model : undefined,
      reasoningEffort: session.agent === fallback ? session.reasoningEffort : undefined,
      metadata: { auto: true, quotaFallback: true, from: exhausted, to: fallback, reason: "한도 소진", resetsAt, previousConfig, previousPlanner },
    });
    return equivalentFallbackModel(exhausted, fallback, invocationModel, invocationEffort);
  }

  private fallbackRetryPrompt(session: Session, role: SessionEvent["role"], originalPrompt: string, exhausted: AgentId, output: string, delegationId?: string): string {
    const partial = output.replace(/\s+/gu, " ").trim().slice(-2_000) || "기록된 진행 내용이 없습니다.";
    const task = role === "worker"
      ? session.events.find((event) => event.id === delegationId || event.delegationId === delegationId)?.text ?? originalPrompt
      : originalPrompt;
    const conversation = role === "orchestrator" ? `\n\n이전 대화 요약:\n${this.conversationSummary(session, exhausted)}` : "";
    const delegatedTask = role === "worker" ? `\n\n원래 위임 작업:\n${task}` : "";
    return `${originalPrompt}${delegatedTask}${conversation}\n\n한도 소진으로 작업을 이어받았습니다. 원래 작업을 계속 완료하세요.\n지금까지의 로그:\n${partial}`;
  }

  async followup(id: string, prompt: string, skills: string[] = [], settings: ConversationSettings = {}, alreadyLogged = false): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("세션이 이미 실행 중입니다.");
    // Left over from a run that was stopped or failed: older than this message, so it must not read as newer.
    const carried = session.pendingInstructions ?? [];
    delete session.pendingInstructions;
    const mediaRequest = await this.isMediaRequest(prompt, [...(session.skills ?? []), ...skills], session.workspaceId);
    if (mediaRequest) assertMediaAllowed(this.workspacePolicyResolver?.(session.workspaceId));
    this.assertSessionPolicy(session);
    this.assertPermissionMode(session.workspaceId, settings.permissionMode);
    session.status = "running";
    delete session.endedAt;
    const auto = this.goalAutoNext.delete(id);
    if (auto) this.goalAutoTurn.add(id);
    else this.goalAutoTurn.delete(id);
    // The user's own message restarts a goal loop that had stopped, with a fresh budget.
    // The setting decides for every message of a chat the user talks to; a goal chat always runs to the end.
    if (settings.autoRun !== undefined && !session.parentId && !session.steward && !auto) {
      if (settings.autoRun) session.goal ??= freshGoal();
      else delete session.goal;
    }
    if (session.goal && !auto) Object.assign(session.goal, { idleTurns: 0, autoTurns: 0, startedAt: new Date().toISOString(), stopped: undefined, outcome: undefined });
    if (session.commander && !alreadyLogged) this.retryGoals(session);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    if (settings.mode !== undefined) session.mode = settings.mode;
    if (settings.autoSwitch !== undefined) session.autoSwitch = settings.autoSwitch;
    if (settings.permissionMode !== undefined) session.permissionMode = settings.permissionMode;
    session.turnCount = (session.turnCount ?? session.events.filter((event) => event.agent === "user" && event.type === "message").length) + 1;
    // An empty chat (create without a prompt) takes its title from its first message.
    if (session.title === EMPTY_TITLE && !session.events.some((event) => event.agent === "user" && event.type === "message")) session.title = titleFrom(prompt);
    if (!alreadyLogged) this.event(session, "user", "message", prompt);
    const allowed = new Set(this.allowedAgents(session));
    // Media keywords pick Grok only while auto-switch is on: the user's own orchestrator choice wins.
    const mediaLead = mediaRequest && session.mode === "auto" && session.autoSwitch !== false;
    if (mediaLead && !allowed.has("grok")) {
      this.fail(session, new Error(mediaUnavailableMessage), controller);
      return session;
    }
    if (mediaLead && (session.agent !== "grok" || session.model !== "grok-4.7")) {
      const workers = session.agent === "grok" ? session.workers : this.mediaWorkers(session.workspaceId);
      this.applyTeam(session, {
        agent: "grok", model: "grok-4.7", workers,
        workerConfigs: normalizeWorkerConfigs(workers, session.workerConfigs),
      });
    }
    let mediaRoutingUnavailable = false;
    if (this.autoRouter && session.mode === "auto" && session.autoSwitch !== false &&
      (mediaRequest || session.lastAutoSwitchTurn === undefined || session.turnCount - session.lastAutoSwitchTurn > 2)) {
      try {
        const recommendation = await this.autoRouter(session, prompt, controller.signal);
        if (mediaRequest && (!recommendation || recommendation.agent !== "grok" || !allowed.has("grok"))) {
          mediaRoutingUnavailable = true;
        } else if (!controller.signal.aborted && recommendation && recommendation.confidence >= 0.85 &&
          (recommendation.agent !== session.agent || mediaRequest && (session.model !== "grok-4.7" || session.workers.join(",") !== recommendation.workers.filter((agent) => allowed.has(agent)).join(","))) && allowed.has(recommendation.agent)) {
          const previousConfig = this.teamConfig(session);
          const candidate = session.workerConfigs?.find((config) => config.agent === recommendation.agent);
          const workers = (mediaRequest ? recommendation.workers : session.workers).filter((agent) => allowed.has(agent));
          if (!workers.length) throw new Error("허용된 작업자를 한 명 이상 선택하세요.");
          session.lastAutoSwitchTurn = session.turnCount;
          this.applyTeam(session, {
            agent: recommendation.agent,
            model: mediaRequest ? "grok-4.7" : candidate?.model ?? (recommendation.agent === "grok" ? "grok-4.7" : undefined),
            reasoningEffort: mediaRequest ? undefined : candidate?.reasoningEffort,
            workers, workerConfigs: normalizeWorkerConfigs(workers, session.workerConfigs),
          }, { auto: true, from: session.agent, to: recommendation.agent, reason: recommendation.reason, previousConfig });
        }
      } catch { if (mediaRequest) mediaRoutingUnavailable = true; }
    }
    if (mediaRequest && session.mode === "auto" && session.autoSwitch !== false && mediaRoutingUnavailable) {
      this.fail(session, new Error(mediaUnavailableMessage), controller);
      return session;
    }
    if (controller.signal.aborted) return session;
    const config = this.turnConfig(session);
    const selectedSkills = [...new Set([...config.skills, ...skills, ...mediaSkills(prompt, await enabledPublicSkills(session.cwd, false, workspaceToolSettings(await loadToolSettings(this.usageDataDir), session.workspaceId).disabledSkills, this.accountsOf(session.workspaceId)))])];
    void this.execute(session, carriedOverPrompt(carried, prompt), selectedSkills, config.systemPrompt, controller, mediaLead || (mediaRequest && session.agent === "grok"))
      .catch((error) => this.fail(session, error, controller));
    return session;
  }

  setGroup(id: string, groupId?: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (groupId) session.groupId = groupId;
    else delete session.groupId;
    this.broadcast(session);
    return session;
  }

  setWorkspace(id: string, workspaceId: Session["workspaceId"], detachFromGroup = true): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") this.assertPolicy(workspaceId, [session.agent, ...session.workers, ...(session.planner ? [session.planner.agent] : [])]);
    // A lead and its chats share one workspace: moving one of its chats moves the lead and the rest.
    const steward = this.stewardOf(session);
    if (steward) {
      this.moveSteward(steward.id, workspaceId, detachFromGroup);
      if (detachFromGroup) delete session.groupId;
      this.broadcast(session);
      return session;
    }
    session.workspaceId = workspaceId;
    if (detachFromGroup) delete session.groupId;
    this.broadcast(session);
    return session;
  }

  rename(id: string, title: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    session.title = title;
    this.broadcast(session);
    return session;
  }

  updateTeam(id: string, input: UpdateTeamInput): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    this.assertPolicy(session.workspaceId, [input.agent, ...input.workers]);
    // Picking the orchestrator by hand pins it: auto-switch would otherwise undo it on the next turn.
    if (input.agent !== session.agent) session.autoSwitch = false;
    return this.applyTeam(session, input);
  }

  setAutoSwitch(id: string, enabled: boolean): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    session.autoSwitch = enabled;
    this.broadcast(session);
    return session;
  }

  private teamConfig(session: Session): UpdateTeamInput {
    return structuredClone({ agent: session.agent, model: session.model, reasoningEffort: session.reasoningEffort,
      workers: session.workers, workerConfigs: session.workerConfigs });
  }

  undoHandoff(id: string, eventId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    const latest = [...session.events].reverse().find((event) => event.type === "handoff");
    if (latest?.id !== eventId || !latest.metadata?.auto || latest.metadata.undone || !latest.metadata.previousConfig || latest.metadata.to !== session.agent) {
      throw new Error("되돌릴 수 있는 최신 자동 전환이 아닙니다.");
    }
    session.lastAutoSwitchTurn = session.turnCount ?? session.events.filter((event) => event.agent === "user" && event.type === "message").length;
    latest.metadata.undone = true;
    this.markEventsRewritten(session);
    return this.updateTeam(id, latest.metadata.previousConfig);
  }

  async returnFromQuotaFallback(id: string, eventId: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    const latest = [...session.events].reverse().find((event) => event.type === "handoff");
    if (latest?.id !== eventId || !latest.metadata?.quotaFallback || latest.metadata.undone || !latest.metadata.previousConfig || !latest.metadata.from) {
      throw new Error("돌아갈 수 있는 최신 한도 전환이 아닙니다.");
    }
    const context = await this.quotaFallbackContext(session);
    const originalQuota = context?.quotas.find((quota) => quota.agent === latest.metadata!.from);
    const resetPassed = latest.metadata.resetsAt !== undefined && latest.metadata.resetsAt <= Date.now() / 1_000;
    const now = Date.now();
    const quotaIsFresh = originalQuota && (!originalQuota.updatedAt || Date.parse(originalQuota.updatedAt) >= now - 24 * 60 * 60 * 1_000);
    const activeWindows = originalQuota?.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now / 1_000) ?? [];
    const freshQuotaAvailable = Boolean(quotaIsFresh && activeWindows.length
      && activeWindows.every((window) => window.remainingPercent > (context?.threshold ?? 3)));
    if (context && !context.authenticated.includes(latest.metadata.from)) throw new Error(`${agentNames[latest.metadata.from]} 인증이 필요합니다.`);
    if (exhaustionFromQuota(originalQuota, context?.threshold).exhausted || (!freshQuotaAvailable && !resetPassed)) throw new Error(`${agentNames[latest.metadata.from]} 한도가 아직 복구되지 않았습니다.`);

    const previous = latest.metadata.previousConfig;
    this.assertPolicy(session.workspaceId, [previous.agent, ...previous.workers, ...(latest.metadata.previousPlanner ? [latest.metadata.previousPlanner.agent] : [])]);
    const fallbackAgent = session.agent;
    const orchestratorChanged = fallbackAgent !== previous.agent;
    if (orchestratorChanged) session.handoffContext = this.conversationSummary(session, fallbackAgent);
    const currentWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.agent = previous.agent;
    session.model = previous.model;
    session.reasoningEffort = previous.reasoningEffort;
    session.workers = [...previous.workers];
    session.workerConfigs = normalizeWorkerConfigs(session.workers, previous.workerConfigs ? structuredClone(previous.workerConfigs) : undefined);
    session.planner = latest.metadata.previousPlanner ? structuredClone(latest.metadata.previousPlanner) : undefined;
    if (orchestratorChanged) delete session.cliSessionId;
    clearChangedWorkerSessions(session, currentWorkers, session.workerConfigs);
    latest.metadata.undone = true;
    this.markEventsRewritten(session);
    const restoredWorker = session.workerConfigs?.find((config) => config.agent === latest.metadata!.from);
    this.event(session, latest.metadata.from, "handoff", `${agentNames[latest.metadata.to ?? session.agent]} → ${agentNames[latest.metadata.from]}로 돌아왔습니다`, {
      role: orchestratorChanged ? "orchestrator" : "worker",
      model: orchestratorChanged ? session.model : restoredWorker?.model,
      reasoningEffort: orchestratorChanged ? session.reasoningEffort : restoredWorker?.reasoningEffort,
      metadata: { auto: false, from: latest.metadata.to, to: latest.metadata.from, reason: "한도 복구" },
    });
    return session;
  }

  private applyTeam(session: Session, input: UpdateTeamInput, metadata?: SessionEvent["metadata"]): Session {
    this.assertPolicy(session.workspaceId, [input.agent, ...input.workers]);
    const workers = [...input.workers];
    if (!workers.length) throw new Error("작업자를 한 명 이상 선택하세요.");
    const previousWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    const nextWorkers = normalizeWorkerConfigs(workers, input.workerConfigs);
    clearChangedWorkerSessions(session, previousWorkers, nextWorkers);
    if (session.planner && !this.allowedAgents(session).includes(session.planner.agent)) delete session.planner;
    const previous = session.agent;
    const switched = previous !== input.agent;
    if (switched) {
      session.handoffContext = this.conversationSummary(session, previous);
      for (const event of session.events) {
        if (!event.role && event.agent === previous && event.type === "message") event.role = "orchestrator";
      }
      this.markEventsRewritten(session);
      session.agent = input.agent;
      delete session.cliSessionId;
    }
    session.model = input.model;
    session.reasoningEffort = input.reasoningEffort;
    session.workers = workers;
    session.workerConfigs = nextWorkers;
    if (switched) {
      this.event(session, input.agent, "handoff", metadata?.auto
        ? `오케스트라 변경: ${agentNames[previous]} → ${agentNames[input.agent]} (${metadata.reason})`
        : `오케스트라가 ${agentNames[previous]} → ${agentNames[input.agent]}로 바뀌었습니다`, {
        metadata,
        role: "orchestrator", model: input.model, reasoningEffort: input.reasoningEffort,
      });
    } else this.broadcast(session);
    return session;
  }

  private conversationSummary(session: Session, orchestrator: AgentId): string {
    const lines = session.events
      .filter((event) => event.type === "message" && (event.agent === "user" || event.role === "orchestrator" || (!event.role && event.agent === orchestrator)))
      .slice(-12)
      .map((event) => `${event.agent === "user" ? "사용자" : agentNames[event.agent as AgentId]}: ${event.text.replace(/\s+/g, " ").trim()}`);
    const summary = lines.join("\n");
    return summary.length > 4_000 ? `…${summary.slice(-3_999)}` : summary || "이전 대화 내용이 없습니다.";
  }

  /** "/compact", like Claude Code's: the next turn starts fresh CLI sessions that get a summary instead of the full history. */
  compact(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("작업 중에는 압축할 수 없습니다. 끝난 뒤 다시 시도하세요.");
    session.handoffContext = this.conversationSummary(session, session.agent);
    delete session.cliSessionId;
    delete session.workerSessionIds;
    this.event(session, session.agent, "status", "대화를 압축했습니다. 다음 메시지부터 요약을 이어받은 새 CLI 세션으로 시작합니다.");
    return session;
  }

  /** Replaces the session's worktree list (after a worktree was removed from the UI). */
  setWorktrees(id: string, worktrees: NonNullable<Session["worktrees"]>): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (worktrees.length) session.worktrees = worktrees;
    else delete session.worktrees;
    this.broadcast(session);
    return session;
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중인 세션은 삭제할 수 없습니다.");
    this.sessions.delete(id);
    this.controllers.delete(id);
    this.clearInactivityTimer(id);
    this.lastEventAt.delete(id);
    // Background servers the session's CLIs left running end with the session (see cli.ts orphanGroups).
    killSessionProcessGroups(id);
    this.sessionRemoved?.(id);
    this.rewrittenEvents.delete(id);
    this.configs.delete(id);
    this.publishRemoval(id);
    void Promise.resolve(this.persist(this.list(), [])).catch(() => undefined);
  }

  /**
   * Deletes one worker sub-session from a chat. The chat history keeps its delegation
   * cards (marked deletedWorker) but drops the worker's own log, and the stored CLI
   * session id is cleared so the next delegation starts a fresh worker session.
   */
  removeWorker(id: string, workerId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    const keyOf = (event: SessionEvent) => event.workerId ?? event.agent;
    const delegations = session.events.filter((event) => event.type === "delegation" && !event.metadata?.deletedWorker && keyOf(event) === workerId);
    if (!delegations.length) throw new Error("워커를 찾을 수 없습니다.");
    const delegationIds = new Set(delegations.map((event) => event.id));
    const running = session.status === "running" && delegations.some((event) => {
      const thread = session.events.filter((item) => item.delegationId === event.id && item.type !== "delegation");
      return !thread.some((item) => item.taskStatus && item.taskStatus !== "running");
    });
    if (running) {
      this.controllers.get(id)?.abort();
      this.finishStopped(session);
    }
    session.events = session.events.filter((event) => {
      if (event.type === "delegation") return true;
      if (event.delegationId && delegationIds.has(event.delegationId)) return false;
      if (!event.delegationId && event.role === "worker" && event.workerId === workerId) return false;
      return true;
    });
    for (const event of delegations) event.metadata = { ...event.metadata, deletedWorker: true };
    setWorkerSessionId(session, workerId);
    const config = session.workerConfigs?.find((worker) => worker.id === workerId);
    if (config?.agent && config.agent !== workerId) setWorkerSessionId(session, config.agent);
    this.markEventsRewritten(session);
    this.broadcast(session);
    return session;
  }

  /**
   * Stops the chat's run and its loop: no further turn opens by itself. A chat that split its work
   * also stops every goal chat still running and leaves the waiting ones unstarted.
   */
  stop(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    // Settle the board first, so the tick that the stopped turns run starts nothing and reports nothing.
    const goals = session.commander?.goals.filter((goal) => goal.state === "waiting" || goal.state === "running") ?? [];
    const children: Session[] = [];
    if (goals.length) {
      session.commander!.reported = true;
      for (const goal of goals) {
        const child = goal.childId ? this.sessions.get(goal.childId) : undefined;
        if (child) children.push(child);
        goal.state = "stopped";
        goal.merge = { ok: false, text: child ? "사용자가 중지했습니다. 작업 브랜치는 병합하지 않고 남겨 두었습니다." : "사용자가 중지해 시작하지 않았습니다." };
        goal.endedAt ??= new Date().toISOString();
      }
    }
    this.goalAutoNext.delete(id);
    this.controllers.get(id)?.abort();
    this.finishStopped(session);
    if (session.goal && !session.goal.stopped && session.goal.items.length) this.endGoal(session, "사용자가 중지했습니다.", "stopped");
    for (const child of children) this.stop(child.id);
    if (goals.length) {
      this.event(session, session.agent, "warning", `나눠 맡긴 일 ${goals.length}개를 멈췄습니다.`);
      this.broadcast(session);
    }
    return session;
  }

  async conversation(input: ConversationInput, bots: Bot[]): Promise<Session> {
    const botA = bots.find((bot) => bot.id === input.botA);
    const botB = bots.find((bot) => bot.id === input.botB);
    if (!botA || !botB) throw new Error("대화할 봇 두 개를 선택하세요.");
    const workspaceId = input.workspaceId ?? "personal";
    const conversationPolicy = this.workspacePolicyResolver?.(workspaceId);
    if (conversationPolicy && !conversationPolicy.mediaGeneration && await this.isMediaRequest(input.prompt, [...botA.skills, ...botB.skills], workspaceId)) assertMediaAllowed(conversationPolicy);
    this.assertPolicy(workspaceId, [botA.agent, botB.agent]);
    this.assertPermissionMode(workspaceId, input.permissionMode);
    const cwd = resolve(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
    const session: Session = { id: randomUUID(), title: `${botA.name} ↔ ${botB.name}`, agent: botA.agent, workers: [botB.agent], cwd, status: "running", createdAt: new Date().toISOString(), events: [], workspaceId, ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) };
    this.sessions.set(session.id, session);
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    this.event(session, botA.agent, "status", `${Math.min(Math.max(input.turns, 1), 20)}턴 봇 대화를 시작했습니다.`);
    void this.executeConversation(session, botA, botB, input.prompt, input.turns, controller).catch((error) => this.fail(session, error, controller));
    return session;
  }

  private async executeConversation(session: Session, botA: Bot, botB: Bot, initial: string, turns: number, controller: AbortController) {
    let message = initial;
    for (let index = 0; index < Math.min(Math.max(turns, 1), 20); index++) {
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      const bot = index % 2 === 0 ? botA : botB;
      const skills = await resolveSkillPrompt(bot.skills, session.cwd, workspaceToolSettings(await loadToolSettings(this.usageDataDir), session.workspaceId).disabledSkills, this.accountsOf(session.workspaceId));
      const prompt = `${bot.systemPrompt}${skills}\n\n상대 봇의 메시지에 응답하세요. 현재 ${index + 1}/${turns}턴입니다.\n\n${message}`;
      const result = await this.runAgent(session, bot.agent, prompt, bot.model, undefined, undefined, controller.signal);
      if (result.exitCode !== 0) throw new Error(`${bot.name} 실행 실패 (코드 ${result.exitCode})`);
      message = result.finalText || "(응답 없음)";
    }
    this.finish(session);
  }

  private finish(session: Session, blocked = false) {
    if (session.status !== "running") return;
    session.status = blocked ? "error" : "done"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    this.heartbeats.delete(session.id); this.lastEventAt.delete(session.id); delete session.lastActivityAt; void this.pruneWorktrees(session);
    const tracking = this.trackingChecklist(session);
    if (blocked && !tracking) this.event(session, session.agent, "error", "워커가 막힌 채로 끝났고 총괄이 다시 맡기지 않았습니다. 작업은 끝나지 않았습니다.");
    else this.event(session, session.agent, "status", tracking ? "이번 턴을 마쳤습니다." : "세션이 완료되었습니다.");
    // A project lead's work goes into the main checkout before anything else starts.
    if (session.steward) {
      void this.stewardTurnEnded(session, "done")
        .catch((error) => this.event(session, session.agent, "warning", error instanceof Error ? error.message : String(error)))
        .finally(() => { if (session.status !== "running") this.afterFinish(session); });
      return;
    }
    this.afterFinish(session);
  }

  private afterFinish(session: Session) {
    // A message typed during this run that no turn picked up is the user's next request, not a note for later.
    const leftover = session.pendingInstructions ?? [];
    this.afterTurn(session, "done", leftover.length > 0);
    if (!leftover.length) return this.stewardIdle(session, "done");
    delete session.pendingInstructions;
    this.event(session, session.agent, "status", "진행 중에 받은 메시지를 이어서 처리합니다.");
    const latest = leftover[leftover.length - 1];
    void this.followup(session.id, carriedOverPrompt(leftover.slice(0, -1), latest.text), [], {}, true)
      .catch((error) => this.event(session, session.agent, "error", error instanceof Error ? error.message : String(error)));
  }
  private finishStopped(session: Session, controller?: AbortController) {
    if (controller && this.controllers.get(session.id) !== controller) return;
    if (session.status !== "running") return;
    session.status = "stopped"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    this.heartbeats.delete(session.id); this.lastEventAt.delete(session.id); delete session.lastActivityAt; void this.pruneWorktrees(session);
    this.event(session, session.agent, "status", "중지됨");
    if (session.steward) void this.stewardTurnEnded(session, "stopped").catch(() => undefined);
    this.afterTurn(session, "stopped", false);
    this.stewardIdle(session, "stopped");
  }
  private fail(session: Session, error: unknown, controller?: AbortController) {
    if (controller && this.controllers.get(session.id) !== controller) return;
    if (session.status !== "running") return;
    session.status = "error"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    this.heartbeats.delete(session.id); this.lastEventAt.delete(session.id); delete session.lastActivityAt; void this.pruneWorktrees(session);
    const message = error instanceof Error ? error.message : String(error);
    this.event(session, session.agent, "error", message);
    if (session.steward) void this.stewardTurnEnded(session, "error").catch(() => undefined);
    this.afterTurn(session, "error", false);
    this.stewardIdle(session, "error");
  }

  // -------------------------------------------------------------------------------------------
  // The project lead (server/steward.ts)

  /** Makes a chat the project lead, or an ordinary chat again. A lead always runs work to the end. */
  setSteward(id: string, enabled: boolean): Session {
    return this.updateSteward(id, { enabled });
  }

  /** Turns the lead on or off, renames it, and sets or clears its daily report time ("HH:MM"). */
  updateSteward(id: string, patch: { enabled?: boolean; name?: string; report?: string | null; acceptWork?: boolean }): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.parentId) throw new Error("나눠 맡긴 채팅은 담당이 될 수 없습니다.");
    const newName = patch.name?.trim().slice(0, 80);
    const existing = this.stewardEntities.get(session.steward?.id ?? session.disabledStewardId ?? session.id);
    const enabled = patch.enabled ?? Boolean(session.steward);
    const destination = existing?.workspaceId ?? session.workspaceId;
    const enabledName = newName || existing?.name || basename(session.cwd) || session.cwd;
    if (enabled && !session.steward) {
      this.assertStewardNameFree(enabledName, existing?.id, destination);
      if (existing?.workspaceId && existing.workspaceId !== session.workspaceId && session.status === "running") {
        this.assertSessionPolicy({ ...session, workspaceId: existing.workspaceId });
      }
    } else if (newName) {
      this.assertStewardNameFree(newName, session.steward?.id, destination);
    }
    if (enabled && !session.steward) {
      // A disabled former lead may have been moved as an ordinary chat. Restoring the lead restores
      // the entity's workspace too, keeping every thread of a lead in one space.
      if (existing?.workspaceId) {
        session.workspaceId = existing.workspaceId;
        delete session.groupId;
      }
      session.steward = {
        turns: 0, since: new Date().toISOString(),
        ...(existing ? { id: existing.id, name: existing.name } : newName ? { name: newName } : {}),
      };
      session.goal ??= freshGoal();
      this.adoptSteward(session);
      delete session.disabledStewardId;
      this.event(session, session.agent, "status", stewardStartText(this.stewardOf(session)?.mergePolicy));
    } else if (!enabled && session.steward) {
      if (session.steward.answering) this.settleStewardAnswer(session, "stopped");
      session.disabledStewardId = session.steward.id ?? session.id;
      delete session.steward;
      this.stewardLastAnswer.delete(id);
      this.event(session, session.agent, "status", "프로젝트 담당을 해제했습니다.");
    }
    const steward = session.steward;
    if (steward && patch.name !== undefined) {
      const entity = this.stewardOf(session);
      // The name is the entity's: every thread of the lead shows the new one.
      if (entity) this.patchSteward(entity.id, { name: newName || basename(session.cwd) || session.cwd });
      else if (newName) steward.name = newName;
      else delete steward.name;
    }
    if (steward && patch.acceptWork !== undefined) {
      if (patch.acceptWork) steward.acceptWork = true;
      else delete steward.acceptWork;
    }
    // Reports are the lead's now: a chat's report time (the old API) sets its lead's.
    if (steward && patch.report !== undefined) {
      const entity = this.stewardOf(session);
      if (entity) this.setStewardReport(entity.id, patch.report);
    }
    this.broadcast(session);
    return session;
  }

  /**
   * Other leads, one chat each: a lead with several threads answers in its latest one. `except` is
   * a chat; its own lead's other threads are not "other leads".
   */
  private stewards(except?: string): Session[] {
    const asker = except ? this.sessions.get(except) : undefined;
    const own = asker?.steward?.id;
    const latest = new Map<string, Session>();
    for (const item of this.sessions.values()) {
      if (!item.steward || item.id === except) continue;
      // Leads only see the leads of their own workspace (공간).
      if (asker && item.workspaceId !== asker.workspaceId) continue;
      const key = item.steward.id ?? item.id;
      if (own && key === own) continue;
      const seen = latest.get(key);
      if (!seen || item.createdAt > seen.createdAt) latest.set(key, item);
    }
    return [...latest.values()];
  }

  /** Every lead chat, threads included (daily reports and waiting messages are per chat). */
  private stewardChats(): Session[] {
    return [...this.sessions.values()].filter((item) => item.steward);
  }

  /** Leads are found by name inside a workspace, so names only need to be unique there. */
  private assertStewardNameFree(name: string, except?: string, workspaceId?: Session["workspaceId"]): void {
    const wanted = name.toLowerCase();
    const entity = [...this.stewardEntities.values()].find((item) => item.id !== except && item.workspaceId === workspaceId && item.name.toLowerCase() === wanted);
    const chat = entity ? undefined : this.stewardChats().find((peer) => (peer.steward!.id ?? peer.id) !== except && peer.workspaceId === workspaceId && stewardName(peer).toLowerCase() === wanted);
    const taken = entity?.name ?? (chat ? stewardName(chat) : undefined);
    if (taken) throw new Error(`이미 「${taken}」 담당이 있습니다. 다른 이름을 정하세요.`);
  }

  // Lead entities (Steward): what a lead is, apart from any one chat.

  /** Every lead, or only those of one workspace. */
  listStewards(workspaceId?: Session["workspaceId"]): Steward[] {
    return [...this.stewardEntities.values()]
      .filter((steward) => workspaceId === undefined || steward.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Gives every lead without a workspace one: the workspace of its latest chat, else `fallback`.
   * A lead's chats that sit in another workspace move to the lead's, so a lead is in one place.
   * Returns whether any lead changed and the chats moved.
   */
  private placeStewardsInWorkspaces(fallback?: Session["workspaceId"]): { stewards: boolean; sessions: string[] } {
    let stewards = false;
    const sessions: string[] = [];
    for (const steward of this.listStewards()) {
      let workspaceId = steward.workspaceId;
      if (!workspaceId) {
        workspaceId = this.latestThread(steward.id)?.workspaceId ?? fallback;
        if (!workspaceId) continue;
        this.stewardEntities.set(steward.id, { ...steward, workspaceId });
        stewards = true;
      }
      for (const thread of this.stewardThreads(steward.id)) {
        if (thread.workspaceId === workspaceId) continue;
        thread.workspaceId = workspaceId;
        delete thread.groupId;
        sessions.push(thread.id);
      }
    }
    return { stewards, sessions };
  }

  /**
   * Moves a lead and all its chats to another workspace. A running chat may move only when the
   * new workspace allows its agents. `detachFromGroup`: false when the groups move along (a deleted
   * workspace's contents). Returns the chats moved.
   */
  moveSteward(id: string, workspaceId: Session["workspaceId"], detachFromGroup = true): Session[] {
    const steward = this.stewardEntities.get(id);
    if (!steward) throw new Error("담당을 찾을 수 없습니다.");
    this.assertStewardNameFree(steward.name, id, workspaceId);
    const threads = this.stewardThreads(id);
    for (const session of threads) if (session.status === "running") this.assertSessionPolicy({ ...session, workspaceId });
    if (steward.workspaceId !== workspaceId) this.saveStewardEntity({ ...steward, workspaceId, updatedAt: new Date().toISOString() });
    const moved: Session[] = [];
    for (const session of threads) {
      if (session.workspaceId === workspaceId) continue;
      session.workspaceId = workspaceId;
      if (detachFromGroup) delete session.groupId;
      this.broadcast(session);
      moved.push(session);
    }
    return moved;
  }

  getSteward(id: string): Steward | undefined { return this.stewardEntities.get(id); }

  /**
   * Resolves a lead ID or name for an API/MCP caller. Names prefer the caller's workspace. A name
   * that exists in several other workspaces is deliberately rejected so the caller can use an ID.
   */
  resolveSteward(idOrName: string, workspaceId?: Session["workspaceId"]): Steward | undefined {
    const exact = this.stewardEntities.get(idOrName);
    if (exact) return exact;
    const wanted = idOrName.trim().toLowerCase();
    if (!wanted) return;
    const matches = this.listStewards().filter((item) => item.name.toLowerCase() === wanted);
    const local = workspaceId ? matches.find((item) => item.workspaceId === workspaceId) : undefined;
    if (local) return local;
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`「${idOrName}」 담당이 여러 공간에 있습니다. 담당 ID를 사용하세요.`);
    return;
  }

  /** The lead a chat is a thread of. */
  stewardOf(session: Session): Steward | undefined {
    return session.steward ? this.stewardEntities.get(session.steward.id ?? session.id) : undefined;
  }

  /** The chats that are threads of a lead, newest first. */
  stewardThreads(id: string): Session[] {
    return this.list().filter((session) => session.steward && (session.steward.id ?? session.id) === id);
  }

  private saveStewardEntity(steward: Steward): Steward {
    this.stewardEntities.set(steward.id, steward);
    void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
    return steward;
  }

  /** A chat that just became a lead: its own entity, made from what the chat runs with. */
  private adoptSteward(session: Session): Steward {
    const id = session.steward?.id ?? session.id;
    // Made a lead again after it was unset: the entity it had (and its edits) comes back.
    const existing = this.stewardEntities.get(id);
    if (existing) {
      session.steward!.id = id;
      session.steward!.name = existing.name;
      return existing;
    }
    const steward = stewardFromSession(session, { id, mergePolicy: DEFAULT_MERGE_POLICY });
    // Creation performs async discovery before reaching here. Recheck and reserve synchronously so
    // concurrent creates, plus implicit folder-derived names, cannot both enter the same workspace.
    this.assertStewardNameFree(steward.name, id, session.workspaceId);
    session.steward!.id = steward.id;
    session.steward!.name = steward.name;
    return this.saveStewardEntity(steward);
  }

  createSteward(input: StewardPatch & { name: string; workspaceId?: Session["workspaceId"] }): Steward {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error("담당 이름이 필요합니다.");
    this.assertStewardNameFree(name, undefined, input.workspaceId);
    const now = new Date().toISOString();
    const base: Steward = { id: randomUUID(), name, agent: input.agent ?? "claude", skills: [], systemPrompt: "", workers: [], mergePolicy: DEFAULT_MERGE_POLICY, cwds: [], ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), createdAt: now };
    const steward = applyStewardPatch(base, { ...input, name }, now);
    delete steward.updatedAt;
    steward.workers = normalizeWorkerConfigs(steward.workers.map((worker) => worker.agent), steward.workers);
    return this.saveStewardEntity(steward);
  }

  /**
   * Edits a lead. Instructions and skills apply from each thread's next turn (they are read when a
   * turn starts); a new name shows in every thread; a new team goes to every thread not running now.
   */
  patchSteward(id: string, patch: StewardPatch, workspaceId?: Session["workspaceId"]): Steward {
    const current = this.stewardEntities.get(id);
    if (!current) throw new Error("담당을 찾을 수 없습니다.");
    const name = patch.name?.trim().slice(0, 80);
    if (patch.name !== undefined && !name) throw new Error("담당 이름이 필요합니다.");
    const destination = workspaceId ?? current.workspaceId;
    this.assertStewardNameFree(name ?? current.name, id, destination);
    if (workspaceId) {
      for (const session of this.stewardThreads(id)) if (session.status === "running") this.assertSessionPolicy({ ...session, workspaceId });
    }
    const next = applyStewardPatch(current, { ...patch, ...(name ? { name } : {}) });
    if (workspaceId) next.workspaceId = workspaceId;
    if (patch.workers) next.workers = normalizeWorkerConfigs(next.workers.map((worker) => worker.agent), next.workers);
    if (patch.mergePolicy !== undefined) next.mergePolicyChosen = true;
    const teamChanged = patch.agent !== undefined || patch.workers !== undefined || patch.model !== undefined || patch.reasoningEffort !== undefined;
    this.saveStewardEntity(next);
    for (const session of this.stewardThreads(id)) {
      session.steward!.name = next.name;
      if (workspaceId && session.workspaceId !== workspaceId) {
        session.workspaceId = workspaceId;
        delete session.groupId;
      }
      if (teamChanged && session.status !== "running" && next.workers.length) {
        try {
          this.applyTeam(session, { agent: next.agent, model: next.model, reasoningEffort: next.reasoningEffort, workers: next.workers.map((worker) => worker.agent), workerConfigs: structuredClone(next.workers) });
        } catch (error) {
          this.event(session, session.agent, "warning", `담당의 기본 팀을 이 채팅에 적용하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.broadcast(session);
    }
    return next;
  }

  /**
   * Moves report settings left on lead chats (from before reports were per lead) to their lead. When
   * its chats had different times the earliest wins, and the latest chat says so. Returns the chats changed.
   */
  private moveThreadReports(): string[] {
    const changed: string[] = [];
    for (const steward of this.listStewards()) {
      const threads = this.stewardThreads(steward.id);
      const carrying = threads.filter((session) => session.steward!.report || session.steward!.reportedAt || session.steward!.reportState !== undefined);
      if (!carrying.length) continue;
      const merged = mergeThreadReports([...(steward.report ? [{ report: steward.report, reportedAt: steward.reportedAt, reportState: steward.reportState }] : []), ...carrying.map((session) => session.steward!)]);
      const next: Steward = { ...steward };
      for (const key of ["report", "reportedAt", "reportState"] as const) { if (merged[key] !== undefined) next[key] = merged[key]; }
      this.stewardEntities.set(steward.id, next);
      for (const session of carrying) {
        delete session.steward!.report;
        delete session.steward!.reportedAt;
        delete session.steward!.reportState;
        changed.push(session.id);
      }
      if (merged.times.length > 1) {
        const latest = this.latestThread(steward.id) ?? carrying[0];
        const text = `채팅마다 달랐던 정기 보고 시각(${merged.times.join(", ")})을 담당 「${steward.name}」 하나로 합쳐 가장 이른 ${merged.report}로 정했습니다. 담당 패널에서 바꿀 수 있습니다.`;
        latest.events.push({ id: randomUUID(), sessionId: latest.id, agent: latest.agent, type: "status", text, time: new Date().toISOString() });
        console.warn(`[steward] ${text}`);
      }
    }
    return changed;
  }

  /** The lead's chat used last (latest event, else newest): where its report opens. */
  latestThread(id: string): Session | undefined {
    const at = (session: Session) => session.events.at(-1)?.time ?? session.createdAt;
    return this.stewardThreads(id).sort((a, b) => at(b).localeCompare(at(a)) || b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** Sets or clears a lead's daily report time ("HH:MM"); a time already past today waits for tomorrow. */
  setStewardReport(id: string, report: string | null): Steward {
    const steward = this.stewardEntities.get(id);
    if (!steward) throw new Error("담당을 찾을 수 없습니다.");
    const next: Steward = { ...steward, updatedAt: new Date().toISOString() };
    if (report) {
      if (steward.report !== report) next.reportedAt = new Date().toISOString();
      next.report = report;
    } else {
      delete next.report;
      delete next.reportedAt;
      delete next.reportState;
    }
    this.saveStewardEntity(next);
    for (const session of this.stewardThreads(id)) this.broadcast(session);
    return next;
  }

  /** Sets every lead's merge policy at once (the settings' one-click action). Returns how many changed. */
  setAllMergePolicies(policy: MergePolicy): number {
    let changed = 0;
    for (const steward of this.listStewards()) {
      if (steward.mergePolicy !== policy) changed++;
      this.stewardEntities.set(steward.id, { ...steward, mergePolicy: policy, mergePolicyChosen: true, updatedAt: new Date().toISOString() });
    }
    void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
    return changed;
  }

  /**
   * The user changed what migrated leads get: it applies to every migrated lead whose policy nobody
   * picked by hand, and to leads migrated from now on. Returns how many changed.
   */
  setLegacyMergePolicy(policy: MergePolicy): number {
    let changed = 0;
    for (const steward of this.listStewards()) {
      if (!steward.migrated || steward.mergePolicyChosen || steward.mergePolicy === policy) continue;
      this.stewardEntities.set(steward.id, { ...steward, mergePolicy: policy, updatedAt: new Date().toISOString() });
      changed++;
    }
    if (changed) void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
    return changed;
  }

  /** Removes a lead; its chats stay as ordinary chats (their notes stay on disk). */
  // ---------- the project lead's tools (lead-tools.ts, POST /api/lead-mcp) ----------

  /** One tool call from a lead's CLI run. `touch` tells the run it is still working while it waits. */
  async leadToolCall(sessionId: string, name: string, args: Record<string, unknown>, touch?: () => void): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session?.steward) throw new Error("담당 채팅이 아닙니다.");
    const stewardId = this.stewardOf(session)?.id;
    const own = (id: unknown) => {
      const schedule = typeof id === "string" ? this.schedules.get(id) : undefined;
      if (!schedule || schedule.stewardId !== stewardId) throw new Error(`일정을 찾을 수 없습니다: ${String(id)}. schedule_list로 ID를 확인하세요.`);
      return schedule;
    };
    switch (name) {
      case "delegate_task": return this.delegateTask(session, args);
      case "check_task": return this.checkTasks(session, args);
      case "collect_results": return this.collectResults(session, args, touch);
      case "write_skill": return this.writeLeadSkill(session, args, false);
      case "update_skill": return this.writeLeadSkill(session, args, true);
      case "list_skills": return this.leadSkillList(session);
      case "schedule_create":
        if (!stewardId) throw new Error("담당을 찾을 수 없습니다.");
        return this.scheduleView(this.createLeadSchedule(stewardId, args as ScheduleInput, "lead", session));
      case "schedule_list":
        return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toISOString(), schedules: stewardId ? this.listSchedules(stewardId).map((item) => this.scheduleView(item)) : [] };
      case "schedule_update":
        return this.scheduleView(this.updateLeadSchedule(own(args.id).id, args as ScheduleInput, "lead", session));
      case "schedule_delete":
        this.deleteLeadSchedule(own(args.id).id, "lead", session);
        return { deleted: args.id };
      default: throw new Error(`알 수 없는 도구: ${name}`);
    }
  }

  private scheduleView(schedule: Schedule) {
    const { id, title, prompt, at, cron, timezone, enabled, nextRunAt, lastRunAt, createdBy } = schedule;
    return { id, title, prompt, ...(at ? { at } : {}), ...(cron ? { cron } : {}), timezone, enabled, ...(nextRunAt ? { nextRunAt } : {}), ...(lastRunAt ? { lastRunAt } : {}), createdBy };
  }

  private liveLeadTurn(session: Session): LeadTurn {
    const turn = this.leadTurns.get(session.id);
    if (!turn || turn.controller.signal.aborted || !this.isCurrentRun(session, turn.controller.signal)) throw new Error("이 담당은 지금 진행 중인 턴이 없어 워커 일을 다룰 수 없습니다.");
    return turn;
  }

  /** Worker for a delegate_task: the named one, or an idle one of the CLI, or a new one of it (parallel). */
  private pickLeadWorker(session: Session, turn: LeadTurn, args: Record<string, unknown>): AgentSelection | Promise<AgentSelection> {
    const workers = turn.workers;
    const busy = (id: string) => turn.tasks.some((task) => task.workerId === id && task.status === "running");
    const isAgent = (value: unknown): value is AgentId => value === "claude" || value === "codex" || value === "grok";
    const requested = typeof args.worker === "string" ? args.worker.trim() : "";
    const model = typeof args.model === "string" && args.model.trim() ? args.model.trim().slice(0, 100) : undefined;
    let agent = isAgent(args.agent) ? args.agent : undefined;
    if (requested) {
      const exact = workers.find((worker) => worker.id === requested);
      if (exact) {
        if (model) exact.model = model;
        return { ...exact };
      }
      const named = requested.toLowerCase();
      if (!isAgent(named)) throw new Error(`워커 ${requested}가 없습니다. 있는 워커: ${workers.map((worker) => worker.id).join(", ")}. agent로 CLI를 정하면 새 워커를 만듭니다.`);
      agent = named;
    }
    if (!agent) {
      const any = workers.find((worker) => !busy(worker.id!)) ?? workers[0];
      if (!any) throw new Error("팀에 워커가 없습니다. agent를 정하세요.");
      if (model) any.model = model;
      return { ...any };
    }
    const idle = workers.find((worker) => worker.agent === agent && (!model || worker.model === model) && !busy(worker.id!));
    if (idle) return { ...idle };
    // Every worker of that CLI is busy (or none has the model): another one joins so both run at once.
    return this.addStewardWorker(session, workers, agent, model).then((added) => {
      if (!added) throw new Error(`${agentNames[agent]} 워커를 쓸 수 없습니다. 이 작업공간에서 허용된 에이전트: ${this.allowedAgents(session).join(", ")}`);
      return { ...added };
    });
  }

  private async delegateTask(session: Session, args: Record<string, unknown>) {
    const turn = this.liveLeadTurn(session);
    if (turn.answerOnly) throw new Error("다른 담당의 질문에 답하는 중이라 워커에게 일을 맡길 수 없습니다. 사용자가 담당 패널에서 '다른 담당의 부탁으로 작업하기'를 켜야 합니다.");
    const brief = typeof args.brief === "string" ? args.brief.trim().slice(0, 40_000) : "";
    if (!brief) throw new Error("brief가 비었습니다. 워커에게 줄 지시를 적으세요.");
    if (turn.tasks.filter((task) => task.status === "running").length >= maxDelegations * 2) throw new Error(`동시에 맡길 수 있는 일은 ${maxDelegations * 2}건입니다. collect_results로 끝난 일을 받은 뒤 맡기세요.`);
    const picked = this.pickLeadWorker(session, turn, args);
    const worker = picked instanceof Promise ? await picked : picked;
    const names = Array.isArray(args.skills) ? args.skills.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 10) : [];
    const skillText = names.length ? await this.leadSkillText(session, names) : { text: "", missing: [] as string[] };
    const kind = args.kind === "design" || args.kind === "research" ? args.kind : undefined;
    const group = typeof args.group === "string" && args.group.trim() ? args.group.trim().slice(0, 60) : undefined;
    const label = workerLabel(worker);
    const task: LeadTask = { id: `t${turn.tasks.length + 1}-${randomUUID().slice(0, 6)}`, workerId: worker.id!, label, agent: worker.agent, brief, ...(group ? { group } : {}), ...(kind ? { kind } : {}), status: "running", collected: false, startedAt: new Date().toISOString(), done: Promise.resolve() };
    const extra = `${names.length ? `\n\n스킬: ${names.join(", ")}` : ""}${skillText.text}${kind === "design" ? `\n\n${DESIGN_BRIEF}` : ""}`;
    task.done = this.runBrief(session, turn, brief, worker, turn.worktrees, extra).then((out) => {
      if (out === STOPPED) { task.status = "stopped"; task.result = `[${label} 결과 — 멈춤]`; }
      else { task.status = "done"; task.result = out; }
    }, (error: unknown) => {
      task.status = "error";
      task.result = `[${label} 결과 — 실패]\n${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => { task.endedAt = new Date().toISOString(); });
    turn.tasks.push(task);
    return { task_id: task.id, worker: worker.id, agent: worker.agent, status: "running", ...(skillText.missing.length ? { missing_skills: skillText.missing } : {}), next: "다른 일도 맡기고, collect_results(wait)로 결과를 받으세요." };
  }

  private checkTasks(session: Session, args: Record<string, unknown>) {
    const turn = this.leadTurns.get(session.id);
    const id = typeof args.task_id === "string" ? args.task_id : undefined;
    const tasks = (turn?.tasks ?? []).filter((task) => !id || task.id === id);
    if (id && !tasks.length) throw new Error(`맡긴 일을 찾을 수 없습니다: ${id}`);
    return { tasks: tasks.map((task) => ({ task_id: task.id, worker: task.workerId, agent: task.agent, status: task.status, ...(task.group ? { group: task.group } : {}), collected: task.collected, started_at: task.startedAt, ...(task.endedAt ? { ended_at: task.endedAt } : {}), brief: task.brief.slice(0, 200) })) };
  }

  private async collectResults(session: Session, args: Record<string, unknown>, touch?: () => void) {
    const turn = this.liveLeadTurn(session);
    const ids = Array.isArray(args.task_ids) ? args.task_ids.filter((item): item is string => typeof item === "string") : [];
    const group = typeof args.group === "string" && args.group ? args.group : undefined;
    const picked = turn.tasks.filter((task) => (ids.length ? ids.includes(task.id) : !task.collected) && (!group || task.group === group));
    if (args.wait !== false && picked.some((task) => task.status === "running")) {
      const seconds = Math.min(LEAD_WAIT_LIMIT_SEC, Math.max(1, Number(args.timeout_sec) || LEAD_WAIT_LIMIT_SEC));
      let timer: NodeJS.Timeout | undefined;
      const keepAlive = touch ? setInterval(touch, 20_000) : undefined;
      keepAlive?.unref();
      const stopped = new Promise<void>((done) => turn.controller.signal.addEventListener("abort", () => done(), { once: true }));
      try {
        await Promise.race([Promise.all(picked.map((task) => task.done)), new Promise<void>((done) => { timer = setTimeout(done, seconds * 1_000); timer.unref(); }), stopped]);
      } finally {
        if (timer) clearTimeout(timer);
        if (keepAlive) clearInterval(keepAlive);
      }
    }
    const finished = picked.filter((task) => task.status !== "running");
    const worktrees = [...new Map(finished.flatMap((task) => { const info = turn.worktrees.get(task.workerId); return info ? [[info.path, info] as const] : []; })).values()];
    const note = worktrees.length ? await worktreeReviewNote(worktrees, mergeRule(this.stewardOf(session)?.mergePolicy)).catch(() => "") : "";
    for (const task of finished) task.collected = true;
    const running = picked.filter((task) => task.status === "running");
    return {
      results: finished.map((task) => ({ task_id: task.id, worker: task.workerId, status: task.status, result: task.result ?? "" })),
      ...(running.length ? { still_running: running.map((task) => task.id) } : {}),
      ...(note ? { worktrees: note } : {}),
      ...(!picked.length ? { note: "받을 결과가 없습니다." } : {}),
    };
  }

  private leadSkillRoot(session: Session): string {
    const id = this.stewardOf(session)?.id;
    if (!id || !this.stewardDataDir) throw new Error("담당 스킬을 둘 곳이 없습니다.");
    return join(this.stewardDataDir, "stewards", id, "skills");
  }

  /** Skills the lead can attach: its own (lead scope) first, then the project's and installed ones. */
  private async leadSkillRecords(session: Session): Promise<SkillRecord[]> {
    const own = this.stewardDataDir && this.stewardOf(session) ? await scanSkillRoot(this.leadSkillRoot(session), "담당", ["claude", "codex", "grok"]) : [];
    return [...own, ...await loadSkills(session.cwd, false, this.accountsOf(session.workspaceId)).catch(() => [] as SkillRecord[])];
  }

  private async leadSkillText(session: Session, names: string[]): Promise<{ text: string; missing: string[] }> {
    const records = await this.leadSkillRecords(session);
    const ids: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const wanted = name.trim().toLowerCase();
      const record = records.find((item) => item.id === name || item.name.toLowerCase() === wanted);
      if (record) ids.push(record.id); else missing.push(name);
    }
    return { text: formatSkillPrompt(records, ids), missing };
  }

  private async leadSkillList(session: Session) {
    const records = await this.leadSkillRecords(session);
    const view = (items: SkillRecord[]) => items.slice(0, 80).map((item) => ({ name: item.name, description: item.description, source: item.source }));
    return { lead: view(records.filter((item) => item.source === "담당")), others: view(records.filter((item) => item.source !== "담당")) };
  }

  private async writeLeadSkill(session: Session, args: Record<string, unknown>, update: boolean): Promise<{ name: string; scope: "lead" | "project"; path: string; action: "created" | "updated" }> {
    const name = skillSlug(typeof args.name === "string" ? args.name : "");
    if (!name) throw new Error("스킬 이름은 영문 소문자·숫자·하이픈으로 정하세요 (예: api-review).");
    const scope = args.scope === "project" ? "project" : "lead";
    const directory = scope === "project" ? join(session.cwd, ".claude", "skills", name) : join(this.leadSkillRoot(session), name);
    const file = join(directory, "SKILL.md");
    let existing = await readFile(file, "utf8").catch(() => undefined);
    // update_skill without scope: the lead's own skill, else the project's.
    if (update && existing === undefined && args.scope === undefined) {
      const projectFile = join(session.cwd, ".claude", "skills", name, "SKILL.md");
      const project = await readFile(projectFile, "utf8").catch(() => undefined);
      if (project !== undefined) return this.writeLeadSkill(session, { ...args, scope: "project" }, true);
    }
    if (update && existing === undefined) throw new Error(`스킬 ${name}이 없습니다. write_skill로 만드세요.`);
    if (!update && existing !== undefined) throw new Error(`스킬 ${name}이 이미 있습니다. update_skill로 고치세요.`);
    existing ??= "";
    const front = /^---\n([\s\S]*?)\n---\n?/u.exec(existing);
    const oldDescription = front?.[1].match(/^description:\s*(.*)$/mu)?.[1]?.trim() ?? "";
    const oldBody = front ? existing.slice(front[0].length).trim() : existing.trim();
    const description = (typeof args.description === "string" && args.description.trim() ? args.description : oldDescription).replace(/\s+/gu, " ").trim().slice(0, 300);
    const content = (typeof args.content === "string" && args.content.trim() ? args.content : oldBody).trim().slice(0, 30_000);
    if (!description || !content) throw new Error("스킬에는 설명(description)과 본문(content)이 필요합니다.");
    await mkdir(directory, { recursive: true });
    await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`);
    if (scope === "project") clearSkillsCache(session.cwd);
    const action = update ? "updated" : "created";
    this.event(session, session.agent, "status", `담당이 ${scope === "project" ? "프로젝트" : "담당"} 스킬 ${name}을 ${update ? "고쳤습니다" : "만들었습니다"}.`, { role: "orchestrator", metadata: { leadSkill: { name, scope, action } } });
    return { name, scope, path: file, action };
  }

  // ---------- schedules ----------

  restoreSchedules(list: Schedule[]): void {
    for (const schedule of list) if (this.stewardEntities.has(schedule.stewardId)) this.schedules.set(schedule.id, schedule);
  }

  listSchedules(stewardId?: string): Schedule[] {
    return [...this.schedules.values()].filter((item) => !stewardId || item.stewardId === stewardId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  createLeadSchedule(stewardId: string, input: ScheduleInput, by: Schedule["createdBy"], via?: Session): Schedule {
    if (!this.stewardEntities.has(stewardId)) throw new Error("담당을 찾을 수 없습니다.");
    if (this.listSchedules(stewardId).length >= SCHEDULE_LIMIT) throw new Error(`담당 한 명의 일정은 ${SCHEDULE_LIMIT}개까지입니다. 지난 일정을 지우세요.`);
    const schedule = createSchedule(stewardId, input, by);
    this.schedules.set(schedule.id, schedule);
    this.saveSchedules();
    this.scheduleCard(schedule, "created", by, via);
    return schedule;
  }

  updateLeadSchedule(id: string, input: ScheduleInput, by: Schedule["createdBy"], via?: Session): Schedule {
    const current = this.schedules.get(id);
    if (!current) throw new Error("일정을 찾을 수 없습니다.");
    const next = applySchedulePatch(current, input);
    this.schedules.set(id, next);
    this.saveSchedules();
    this.scheduleCard(next, "updated", by, via);
    return next;
  }

  deleteLeadSchedule(id: string, by: Schedule["createdBy"], via?: Session): void {
    const current = this.schedules.get(id);
    if (!current) throw new Error("일정을 찾을 수 없습니다.");
    this.schedules.delete(id);
    this.saveSchedules();
    this.scheduleCard(current, "deleted", by, via);
  }

  private saveSchedules(): void {
    void Promise.resolve(this.persistSchedules?.(this.listSchedules())).catch(() => undefined);
  }

  /** The small card in the lead's chat: in the chat that changed it, else the lead's latest chat. */
  private scheduleCard(schedule: Schedule, action: ScheduleCard["action"], by: "user" | "lead" | "app", via?: Session): void {
    const target = via ?? this.latestThread(schedule.stewardId);
    if (!target) return;
    const verb = { created: "만들었습니다", updated: "고쳤습니다", deleted: "지웠습니다", fired: "시각이 되어 담당에게 보냈습니다", missed: "앱이 꺼져 있던 동안 시각이 지나 건너뛰었습니다" }[action];
    const who = by === "lead" ? "담당이 일정을 " : by === "user" ? "사용자가 일정을 " : "일정: ";
    this.event(target, target.agent, "status", `${who}${verb} — ${describeSchedule(schedule)}`, {
      role: "orchestrator",
      metadata: { schedule: { id: schedule.id, title: schedule.title, action, by, ...(schedule.at ? { at: schedule.at } : {}), ...(schedule.cron ? { cron: schedule.cron } : {}), timezone: schedule.timezone, ...(schedule.nextRunAt ? { nextRunAt: schedule.nextRunAt } : {}), enabled: schedule.enabled } },
    });
  }

  /** Due schedules: each sends its prompt to the lead's latest chat (queued behind running work). */
  private scheduleTick(now: Date): void {
    const due = dueSchedules(this.schedules.values(), now);
    if (!due.length) return;
    for (const { schedule, action } of due) {
      const target = this.latestThread(schedule.stewardId);
      this.scheduleCard(schedule, action === "fire" ? "fired" : "missed", "app", target);
      if (action === "fire" && target) this.deliverToSteward(target, { prompt: `[일정 "${schedule.title}"]\n${schedule.prompt}` });
    }
    this.saveSchedules();
  }

  /** Lead (Claude when allowed) and one worker per allowed agent: what a lead with no team starts with. */
  private defaultTeam(workspaceId: string, lead?: AgentId): { agent: AgentId; workers: AgentId[]; workerConfigs?: undefined } {
    const allowed = this.allowedAgents({ workspaceId });
    if (!allowed.length) throw new Error("이 작업공간에서 허용된 에이전트가 없습니다.");
    return { agent: lead ?? (allowed.includes("claude") ? "claude" : allowed[0]), workers: [...allowed], workerConfigs: undefined };
  }

  deleteSteward(id: string): void {
    if (!this.stewardEntities.has(id)) throw new Error("담당을 찾을 수 없습니다.");
    for (const session of this.stewardThreads(id)) this.updateSteward(session.id, { enabled: false });
    this.stewardEntities.delete(id);
    void Promise.resolve(this.persistStewards?.(this.listStewards())).catch(() => undefined);
    const owned = this.listSchedules(id);
    for (const schedule of owned) this.schedules.delete(schedule.id);
    if (owned.length) this.saveSchedules();
  }

  /** The instructions and skills a turn starts with: a lead's are its entity's, as they are now. */
  private turnConfig(session: Session): { skills: string[]; systemPrompt: string } {
    const entity = this.stewardOf(session);
    if (entity) return { skills: [...entity.skills], systemPrompt: entity.systemPrompt };
    return this.configs.get(session.id) ?? { skills: [], systemPrompt: "" };
  }

  /** One chat at a glance (GET /api/sessions/:id/summary). */
  summary(id: string): SessionSummary {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    return sessionSummary(session, this.stewardOf(session));
  }

  /**
   * A lead delegated to an agent its team does not have. When the workspace allows that agent, a
   * worker for it joins the team (kept for later turns) and the user is told; otherwise it is refused.
   */
  private async addStewardWorker(session: Session, workers: AgentSelection[], agent: AgentId, model?: string): Promise<AgentSelection | undefined> {
    if (!this.agentAllowed(session.workspaceId, agent)) {
      this.event(session, session.agent, "warning", `${agentNames[agent]}는 이 작업공간에서 허용되지 않은 에이전트라 위임하지 않았습니다. 작업공간 설정에서 허용하거나 팀에 있는 워커에게 맡기세요.`);
      return undefined;
    }
    if (this.workerReadiness) {
      const readiness = await this.workerReadiness(session, agent);
      if (!readiness.installed || !readiness.authenticated) {
        this.event(session, session.agent, "warning", readiness.detail);
        throw new Error(readiness.detail);
      }
    }
    const nextAgents = [...session.workers, agent];
    const configs = normalizeWorkerConfigs(nextAgents, [...(session.workerConfigs ?? []), { agent, ...(model ? { model } : {}) }]);
    const added = configs.find((config) => config.agent === agent && !workers.some((worker) => worker.id === config.id));
    if (!added) return undefined;
    session.workers = nextAgents;
    session.workerConfigs = configs;
    workers.push(added);
    this.event(session, agent, "status", `팀에 없던 ${agentNames[agent]} 워커(${added.id})를 추가해 맡깁니다. 다음 턴에도 이 팀으로 이어 갑니다.`, { metadata: { addedWorker: agent } });
    return added;
  }

  /** Approves the lead's held branches (mergePolicy "ask"): merges them into the main checkout now. */
  async approveMerge(id: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (!session.steward?.pendingMerge) throw new Error("병합을 기다리는 작업이 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 병합할 수 없습니다. 이번 턴이 끝난 뒤 승인하세요.");
    delete session.steward.pendingMerge;
    const { failed } = await this.mergeStewardWork(session, "사용자가 승인해 ");
    // A failed merge waits for approval again; nothing goes in by itself.
    if (failed && session.steward && session.worktrees?.length) session.steward.pendingMerge = this.pendingFrom(session.worktrees);
    this.broadcast(session);
    return session;
  }

  /** Declines the held branches: nothing is merged, the branches stay, and the next turn's end asks again. */
  rejectMerge(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    const pending = session.steward?.pendingMerge;
    if (!pending) throw new Error("병합을 기다리는 작업이 없습니다.");
    delete session.steward!.pendingMerge;
    const branches = pending.branches.map((item) => item.branch).join(", ");
    this.event(session, session.agent, "status", `병합하지 않았습니다. 작업 브랜치(${branches})는 남겨 두었고, 다음 턴이 끝나면 다시 묻습니다.`);
    session.steward!.appNotes = [...(session.steward!.appNotes ?? []), `사용자가 작업 브랜치(${branches}) 병합을 거절했습니다. 메인 폴더에는 들어가지 않았습니다.`];
    this.broadcast(session);
    return session;
  }

  private pendingFrom(infos: NonNullable<Session["worktrees"]>): NonNullable<NonNullable<Session["steward"]>["pendingMerge"]> {
    return { branches: infos.map((info) => ({ workerId: info.workerId, ...(info.workerLabel ? { workerLabel: info.workerLabel } : {}), branch: info.branch, path: info.path })), createdAt: new Date().toISOString() };
  }

  /** mergePolicy "ask" or "never": the turn's branches with work stay; the user approves them, or merges by hand. */
  private async holdStewardWork(session: Session, policy: Exclude<MergePolicy, "auto">): Promise<void> {
    if (!session.worktrees?.length) {
      if (session.steward) delete session.steward.pendingMerge;
      return;
    }
    await this.cliRunsSettled(session.id);
    await this.withWorktreeLock(session.id, async () => {
      const held: NonNullable<Session["worktrees"]> = [];
      for (const info of session.worktrees ?? []) {
        const status = await worktreeStatus(info).catch(() => undefined);
        if (!status || status.changedFiles > 0 || status.commits > 0) held.push(info);
      }
      const steward = session.steward;
      if (!steward) return;
      if (!held.length) { delete steward.pendingMerge; return; }
      const branches = held.map((info) => info.branch).join(", ");
      if (policy === "ask") {
        steward.pendingMerge = this.pendingFrom(held);
        this.event(session, session.agent, "status", `작업 브랜치(${branches})가 병합 승인을 기다립니다. 담당 패널에서 승인하면 메인 폴더에 병합합니다.`, { metadata: { mergeHold: "ask" } });
        steward.appNotes = [...(steward.appNotes ?? []), `워커 작업(${branches})은 사용자의 병합 승인을 기다리고 있습니다. 메인 폴더에는 아직 없습니다.`];
      } else {
        delete steward.pendingMerge;
        this.event(session, session.agent, "status", `병합하지 않는 담당이라 작업을 브랜치에 남겨 두었습니다: ${branches}. 직접 병합하세요.`, { metadata: { mergeHold: "never" } });
        steward.appNotes = [...(steward.appNotes ?? []), `워커 작업은 브랜치(${branches})에 남아 있습니다. 앱은 병합하지 않습니다.`];
      }
      this.broadcast(session);
    });
  }

  /**
   * Called every minute: opens each lead's daily report once its time has passed (skipped when the
   * project and the chat are unchanged since the last one), and runs messages left waiting.
   */
  async stewardTick(now = new Date()): Promise<void> {
    this.scheduleTick(now);
    // One report per lead, in the chat it used last; it covers the lead's other chats too.
    for (const steward of this.listStewards()) {
      if (!steward.report || !reportDue(steward.report, steward.reportedAt, now)) continue;
      const target = this.latestThread(steward.id);
      if (!target) continue;
      const threads = this.stewardThreads(steward.id);
      const since = steward.reportedAt;
      steward.reportedAt = now.toISOString();
      const folders = [...new Set(threads.map((session) => session.cwd))].sort();
      const state = (await Promise.all(folders.map((cwd) => projectState(cwd)))).join("\n--\n");
      const talked = threads.some((session) => session.events.some((event) => event.agent === "user" && event.type === "message" && (!since || event.time > since) && !isReportPrompt(event.text)));
      if (steward.reportState === undefined || state !== steward.reportState || talked) {
        steward.reportState = state;
        const others = threads.filter((session) => session !== target).map((session) => ({ title: session.title, status: session.status, ...(this.stewardDataDir ? { transcript: transcriptPath(this.stewardDataDir, session.id) } : {}) }));
        this.deliverToSteward(target, { prompt: reportPrompt(others) });
      }
      this.saveStewardEntity(steward);
      this.broadcast(target);
    }
    // Left from before a restart, or found the lead busy and nothing ran it since.
    for (const session of this.stewardChats()) {
      if (session.steward!.inbox?.length) this.drainIfIdle(session);
    }
  }

  /** Runs the message now when the lead is free, else after its current work. Kept with the session. */
  private deliverToSteward(session: Session, delivery: StewardDelivery, run = true): void {
    if (!session.steward) return;
    session.steward.inbox = [...(session.steward.inbox ?? []), delivery];
    this.broadcast(session);
    if (run) this.drainIfIdle(session);
  }

  private drainIfIdle(session: Session): void {
    if (session.status !== "running" && !this.goalAutoNext.has(session.id) && !this.stewardStarting.has(session.id)) this.drainStewardInbox(session);
  }

  private drainStewardInbox(session: Session): void {
    const steward = session.steward;
    const next = steward?.inbox?.shift();
    if (!steward || !next) return;
    if (!steward.inbox?.length) delete steward.inbox;
    if (next.replyTo) steward.answering = next.replyTo;
    this.stewardDepth.set(session.id, next.replyTo?.depth ?? next.depth ?? 0);
    this.stewardStarting.add(session.id);
    void this.followup(session.id, next.prompt).catch((error) => {
      this.stewardDepth.delete(session.id);
      const current = session.steward;
      if (session.status === "running" && current) {
        // The user's own message got there first: this one waits for that turn to end.
        if (next.replyTo) delete current.answering;
        current.inbox = [next, ...(current.inbox ?? [])];
        return;
      }
      this.event(session, session.agent, "warning", `다른 담당의 메시지를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      this.settleStewardAnswer(session, "error");
    }).finally(() => this.stewardStarting.delete(session.id));
  }

  /**
   * A lead's work ended and nothing else follows on its own: answer the lead that asked, then take
   * the next waiting message. A stop answers but takes nothing new; the user stopped it.
   */
  private stewardIdle(session: Session, outcome: "done" | "error" | "stopped"): void {
    if (!session.steward || session.status === "running" || this.goalAutoNext.has(session.id)) return;
    this.settleStewardAnswer(session, outcome);
    if (outcome !== "stopped") this.drainStewardInbox(session);
  }

  /** `run` false while restoring: the message waits for the first stewardTick. */
  private settleStewardAnswer(session: Session, outcome: "done" | "error" | "stopped", run = true): void {
    const asked = session.steward?.answering;
    if (!asked) return;
    delete session.steward!.answering;
    const asker = this.sessions.get(asked.id);
    if (!asker?.steward) return;
    const answer = outcome === "done"
      ? stripLeadBlocks(this.stewardLastAnswer.get(session.id) ?? "") || "(답이 비어 있습니다)"
      : `(이 담당이 답하지 못했습니다: ${outcome === "stopped" ? "사용자가 중지했습니다" : "실행 중 오류가 났습니다"})`;
    this.deliverToSteward(asker, { prompt: replyPrompt(stewardName(session), asked.question, answer), depth: asked.depth }, run);
  }

  /** Sends the `<<ASK>>` blocks of a finished lead turn to the leads they name. */
  private sendStewardAsks(session: Session, asks: StewardAsk[], depth: number): void {
    const from = stewardName(session);
    for (const ask of asks) {
      const peers = this.stewards(session.id);
      const wanted = ask.to.toLowerCase();
      const matches = peers.filter((peer) => stewardName(peer).toLowerCase() === wanted);
      if (matches.length > 1) {
        this.event(session, session.agent, "warning", `「${ask.to}」라는 담당이 ${matches.length}개라 보내지 않았습니다. 담당 패널에서 이름을 서로 다르게 바꿔 주세요.`);
        continue;
      }
      const target = matches[0];
      if (!target) {
        this.event(session, session.agent, "warning", `「${ask.to}」 담당을 찾지 못해 보내지 않았습니다. 지금 담당: ${peers.map((peer) => `「${stewardName(peer)}」`).join(", ") || "없음"}`);
        continue;
      }
      if (depth >= MAX_ASK_DEPTH) {
        this.event(session, session.agent, "warning", `담당끼리 주고받은 횟수가 ${MAX_ASK_DEPTH}번을 넘어 「${stewardName(target)}」에게 보내지 않았습니다. 필요하면 사용자에게 물어보세요.`);
        continue;
      }
      this.event(session, session.agent, "status", `「${stewardName(target)}」 담당에게 물었습니다. 답이 오면 이 채팅에서 이어 갑니다.`);
      this.deliverToSteward(target, { prompt: askPrompt(from, ask.text, Boolean(target.steward!.acceptWork)), replyTo: { id: session.id, question: ask.text, depth: depth + 1 } });
    }
  }

  private async stewardContext(session: Session): Promise<string> {
    if (!session.steward || !this.stewardDataDir) return "";
    const [notes, preferences] = await Promise.all([readNotes(this.stewardDataDir, stewardNotesId(session)), readUserPreferences(this.stewardDataDir)]);
    const peers = this.stewards(session.id).map((peer) => ({ name: stewardName(peer), cwd: peer.cwd }));
    return `\n\n${stewardRules(notes, transcriptPath(this.stewardDataDir, session.id), peers, session.steward.appNotes, { mergePolicy: this.stewardOf(session)?.mergePolicy, preferences, allowedAgents: this.allowedAgents(session) })}`;
  }

  /**
   * After every lead turn: keep the transcript, merge the finished turn's work into the main
   * checkout, and hand a long chat to a fresh CLI session with the notes and recent conversation.
   */
  private async stewardTurnEnded(session: Session, outcome: "done" | "error" | "stopped"): Promise<void> {
    const steward = session.steward;
    if (!steward) return;
    steward.turns++;
    const asks = this.stewardAsks.get(session.id) ?? [];
    this.stewardAsks.delete(session.id);
    const depth = this.stewardDepth.get(session.id) ?? 0;
    this.stewardDepth.delete(session.id);
    if (outcome === "done" && asks.length) this.sendStewardAsks(session, asks, depth);
    // This turn saw what the app did after the last one; the merge below writes the next note.
    delete steward.appNotes;
    if (this.stewardDataDir) await saveTranscript(this.stewardDataDir, session).catch(() => undefined);
    if (outcome === "done" && !commanderActive(session) && this.permissionModeOf(session) !== "plan") {
      const policy = this.stewardOf(session)?.mergePolicy ?? DEFAULT_MERGE_POLICY;
      if (policy === "auto") await this.mergeStewardWork(session);
      else await this.holdStewardWork(session, policy);
    }
    if (steward.turns < STEWARD_ROLLOVER_TURNS || session.status === "running") return;
    const notes = this.stewardDataDir ? await readNotes(this.stewardDataDir, stewardNotesId(session)) : "";
    session.handoffContext = rolloverContext(notes, this.conversationSummary(session, session.agent), this.stewardDataDir ? transcriptPath(this.stewardDataDir, session.id) : "(없음)");
    // Only the lead's CLI session starts fresh. Workers keep theirs: each gets a full brief per task,
    // their CLIs compact their own context, and a session that cannot be resumed already falls back
    // to a fresh one (execute: "이전 세션에 연결하지 못해"). Dropping them would cost every worker its
    // knowledge of the files it worked on for nothing the lead gains.
    delete session.cliSessionId;
    Object.assign(steward, { turns: 0, since: new Date().toISOString() });
    this.event(session, session.agent, "status", "대화가 길어져 다음 턴부터 새 세션으로 이어 갑니다. 대화 기록은 그대로 이어 갑니다.");
  }

  /** Merges every worker branch of the lead's chat that holds work; a failed merge keeps its branch for the next turn. */
  private async mergeStewardWork(session: Session, prefix = ""): Promise<{ merged: number; failed: number }> {
    if (!session.worktrees?.length) return { merged: 0, failed: 0 };
    await this.cliRunsSettled(session.id);
    return this.withWorktreeLock(session.id, async () => {
      const merged: string[] = [];
      const failed: string[] = [];
      for (const info of [...(session.worktrees ?? [])]) {
        const result = await mergeWorktree(info, `sinawi: 담당 — ${session.title}`);
        if (!result.ok) { failed.push(result.text); continue; }
        if (!result.empty && result.commit) merged.push(result.commit);
        session.worktrees = session.worktrees?.filter((item) => item !== info);
      }
      if (!session.worktrees?.length) delete session.worktrees;
      const notes: string[] = [];
      if (merged.length) {
        this.event(session, session.agent, "status", `${prefix}이번 턴의 작업을 메인 폴더에 병합했습니다 (${merged.join(", ")}).`);
        notes.push(`워커 작업을 메인 폴더에 병합했습니다 (${merged.join(", ")}). 작업 브랜치는 정리했습니다.`);
      }
      if (failed.length) {
        const retry = prefix ? "충돌을 풀고 다시 승인하세요" : "다음 턴이 끝날 때 다시 시도합니다";
        this.event(session, session.agent, "warning", `메인 폴더에 병합하지 못했습니다: ${[...new Set(failed)].join(" ")} 작업 브랜치는 남겨 두었고 ${retry}.`);
        notes.push(`메인 폴더 병합에 실패했습니다: ${[...new Set(failed)].join(" ")} 작업 브랜치는 남아 있고, ${retry}.`);
      }
      if (notes.length && session.steward) session.steward.appNotes = [...(session.steward.appNotes ?? []), ...notes];
      this.broadcast(session);
      return { merged: merged.length, failed: failed.length };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Run-to-completion and the commander (server/goals.ts)

  private noteChecklist(session: Session, text: string): void {
    const items = session.goal ? parseChecklist(text) : undefined;
    if (items) this.turnChecklists.set(session.id, items);
    if (session.steward) {
      if (text.trim()) this.stewardLastAnswer.set(session.id, text);
      const asks = parseAsks(text);
      // The review often restates the first answer's question: send each one once.
      const known = this.stewardAsks.get(session.id) ?? [];
      const fresh = asks.filter((ask) => !known.some((item) => item.to === ask.to && item.text === ask.text));
      if (fresh.length) this.stewardAsks.set(session.id, [...known, ...fresh]);
    }
    const notes = session.steward && this.stewardDataDir ? parseNotes(text) : undefined;
    if (notes) void saveNotes(this.stewardDataDir!, stewardNotesId(session), notes).catch((error) => this.event(session, session.agent, "warning", `담당 노트를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The lead keeps a checklist for this request (this turn or before), so the app runs it to the end. */
  private trackingChecklist(session: Session): boolean {
    return Boolean(session.goal && (this.turnChecklists.get(session.id)?.length || session.goal.items.length));
  }

  /**
   * After every turn of a goal session: take the lead's latest checklist, then open the next turn
   * unless the checklist is settled, the user stopped the run or a limit was reached. A failed turn
   * (CLI error, watchdog) counts as a turn without progress, so a run that keeps failing still ends.
   */
  private afterTurn(session: Session, outcome: "done" | "error" | "stopped", userMessageWaiting: boolean): void {
    const items = this.turnChecklists.get(session.id);
    this.turnChecklists.delete(session.id);
    if (session.commander) {
      this.commanderTick(session);
      if (commanderActive(session)) return;
    }
    const goal = session.goal;
    if (!goal || goal.stopped) return;
    const auto = this.goalAutoTurn.delete(session.id);
    const before = settledCount(goal.items);
    if (items) goal.items = items;
    const progressed = settledCount(goal.items) > before || !before && Boolean(items) && !auto;
    goal.idleTurns = progressed ? 0 : goal.idleTurns + 1;
    if (outcome === "stopped") return this.endGoal(session, "사용자가 중지했습니다.", "stopped");
    // The user's waiting message runs next (finish starts it); the loop resumes after that turn.
    if (userMessageWaiting) return;
    const step = nextGoalStep(session);
    // No checklist: an ordinary answer. Only a goal chat must keep one, and gets one more turn to write it.
    if (!step.continue && step.reason === "no-checklist" && !session.parentId) return;
    if (!step.continue && step.reason === "no-checklist" && goal.autoTurns === 0 && outcome === "done") {
      goal.autoTurns++;
      this.goalAutoNext.add(session.id);
      void this.followup(session.id, "[앱] 체크리스트가 없습니다. 사용자 요청 전체를 <<CHECKLIST>> 형식으로 나누고, 지금까지 한 일을 확인해 표시한 뒤 남은 항목을 위임하세요.", [], {}, true).catch(() => this.goalAutoNext.delete(session.id));
      return;
    }
    if (!step.continue) return this.endGoal(session, GOAL_STOP_TEXT[step.reason], step.reason === "complete" ? "complete" : "unfinished");
    goal.autoTurns++;
    this.event(session, session.agent, "status", `남은 항목 ${goal.items.filter((item) => item.status === "open").length}개 — 이어서 진행합니다 (${goal.autoTurns}번째).`);
    this.goalAutoNext.add(session.id);
    void this.followup(session.id, goalTurnPrompt(goal.items, goal.autoTurns), [], {}, true).catch((error) => {
      this.goalAutoNext.delete(session.id);
      this.endGoal(session, `다음 턴을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "unfinished");
    });
  }

  private endGoal(session: Session, text: string, outcome: NonNullable<NonNullable<Session["goal"]>["outcome"]>): void {
    const goal = session.goal;
    if (!goal || goal.stopped) return;
    goal.stopped = text;
    goal.outcome = outcome;
    const blocked = goal.items.filter((item) => item.status === "blocked");
    this.event(session, session.agent, outcome === "complete" && !blocked.length ? "status" : "warning", `${text}${goal.items.length ? ` (${settledCount(goal.items)}/${goal.items.length} 항목)` : ""}${blocked.length ? `\n사람이 풀어야 할 것:\n${blocked.map((item) => `- ${item.text}${item.note ? ` — ${item.note}` : ""}`).join("\n")}` : ""}`);
    if (session.parentId) void this.childSettled(session);
  }

  private commanderGoal(child: Session): { parent: Session; goal: CommanderGoal } | undefined {
    const parent = child.parentId ? this.sessions.get(child.parentId) : undefined;
    const goal = parent?.commander?.goals.find((item) => item.childId === child.id);
    return parent && goal ? { parent, goal } : undefined;
  }

  /** A goal session's loop ended: merge its branches when every item is settled, then tell the commander. */
  private async childSettled(child: Session): Promise<void> {
    const found = this.commanderGoal(child);
    if (!found) return;
    const { parent, goal } = found;
    const outcome = child.goal?.outcome;
    const blocked = child.goal?.items.some((item) => item.status === "blocked");
    if (outcome === "complete") {
      const merge = await this.mergeChild(child, goal);
      goal.merge = merge;
      goal.state = merge.ok ? (merge.merged ? "merged" : "done") : "blocked";
      if (merge.ok && blocked) goal.merge = { ...merge, text: `${merge.text} 일부 항목은 사람이 풀어야 합니다.` };
    } else {
      goal.state = outcome === "stopped" ? "stopped" : blocked ? "blocked" : "failed";
      goal.merge = { ok: false, text: `${child.goal?.stopped ?? "끝나지 않았습니다."} 작업 브랜치는 병합하지 않고 남겨 두었습니다.` };
    }
    goal.endedAt = new Date().toISOString();
    this.event(parent, parent.agent, goal.state === "merged" || goal.state === "done" ? "status" : "warning", `목표 [${goal.key}] ${goal.title}: ${goalStateLabel(goal.state)} — ${goal.merge?.text ?? ""}`);
    this.commanderTick(parent);
  }

  private async mergeChild(child: Session, goal: CommanderGoal): Promise<{ ok: boolean; text: string; commit?: string; merged?: boolean }> {
    if (!child.worktrees?.length) return { ok: true, text: "작업 브랜치가 없습니다(세션 폴더에서 직접 작업했거나 바뀐 파일이 없음)." };
    await this.cliRunsSettled(child.id);
    return this.withWorktreeLock(child.id, async () => {
      const texts: string[] = [];
      let commit: string | undefined;
      let ok = true;
      let merged = false;
      for (const info of [...(child.worktrees ?? [])]) {
        const result = await mergeWorktree(info, `sinawi: 목표 ${goal.key} ${goal.title}`);
        texts.push(result.text);
        if (!result.ok) { ok = false; continue; }
        if (!result.empty) { merged = true; commit = result.commit ?? commit; }
        child.worktrees = child.worktrees?.filter((item) => item !== info);
      }
      if (!child.worktrees?.length) delete child.worktrees;
      this.broadcast(child);
      return { ok, merged, commit, text: [...new Set(texts)].join(" ") };
    });
  }

  /**
   * Starts every waiting goal whose prerequisites merged (up to commanderParallelGoals at once),
   * gives up on goals whose prerequisite did not finish, and once all goals are settled hands the
   * board to the commander for its summary. Runs after every commander turn and child result.
   */
  private commanderTick(commander: Session): void {
    const state = commander.commander;
    if (!state || this.sessions.get(commander.id) !== commander) return;
    const byKey = new Map(state.goals.map((goal) => [goal.key, goal]));
    let running = state.goals.filter((goal) => goal.state === "running").length;
    for (const goal of state.goals) {
      if (goal.state !== "waiting") continue;
      const deps = goal.after.map((key) => byKey.get(key)).filter((dep): dep is CommanderGoal => Boolean(dep));
      const failed = deps.find((dep) => dep.state === "blocked" || dep.state === "failed" || dep.state === "stopped");
      if (failed) {
        goal.state = "blocked";
        goal.merge = { ok: false, text: `선행 목표 [${failed.key}]가 끝나지 못해 시작하지 않았습니다.` };
        goal.endedAt = new Date().toISOString();
        this.event(commander, commander.agent, "warning", `목표 [${goal.key}] ${goal.title}: ${goal.merge.text}`);
        continue;
      }
      if (deps.some((dep) => dep.state !== "merged" && dep.state !== "done") || running >= this.commanderParallelGoals) continue;
      running++;
      goal.state = "running";
      void this.launchGoal(commander, goal).catch((error) => {
        goal.state = "failed";
        goal.merge = { ok: false, text: `세션을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
        goal.endedAt = new Date().toISOString();
        this.event(commander, commander.agent, "error", `목표 [${goal.key}] ${goal.title}: ${goal.merge.text}`);
        this.commanderTick(commander);
      });
    }
    this.broadcast(commander);
    const settled = state.goals.length > 0 && state.goals.every((goal) => goal.state !== "waiting" && goal.state !== "running");
    if (!settled || state.reported || commander.status === "running" || commander.pendingInstructions?.length) return;
    state.reported = true;
    state.reporting = true;
    this.event(commander, commander.agent, "status", "나눠 맡긴 일이 모두 끝났습니다. 결과를 정리합니다.");
    void this.followup(commander.id, `[앱] 모든 목표가 끝났습니다. 아래 보드를 보고 목표별 결과, 병합 여부, 막힌 것과 사용자가 해야 할 일을 짧게 정리하세요. 새 목표는 만들지 마세요.\n\n${commanderBoard(commander, (id) => this.sessions.get(id))}`, [], {}, true)
      .catch((error) => this.event(commander, commander.agent, "error", error instanceof Error ? error.message : String(error)));
  }

  /**
   * The user wrote to the commander again: goals whose work finished but whose merge failed get
   * another merge, and goals that never started because of them wait again. The tick after this
   * turn runs them.
   */
  private retryGoals(commander: Session): void {
    const goals = commander.commander?.goals ?? [];
    const retried = new Set<string>();
    for (const goal of goals) {
      const child = goal.childId ? this.sessions.get(goal.childId) : undefined;
      if (goal.state === "blocked" && goal.merge?.ok === false && child?.goal?.outcome === "complete" && child.status !== "running") {
        goal.state = "waiting";
        retried.add(goal.key);
      }
    }
    for (const goal of goals) {
      if (goal.state === "blocked" && !goal.childId && goal.after.some((key) => retried.has(key) || goals.find((dep) => dep.key === key)?.state === "waiting")) {
        goal.state = "waiting";
        delete goal.merge;
        delete goal.endedAt;
        retried.add(goal.key);
      }
    }
    if (!retried.size) return;
    commander.commander!.reported = false;
    this.event(commander, commander.agent, "status", `막혔던 목표를 다시 시도합니다: ${[...retried].join(", ")}`);
  }

  private async launchGoal(commander: Session, goal: CommanderGoal): Promise<void> {
    const existing = goal.childId ? this.sessions.get(goal.childId) : undefined;
    // Its work is done and only the merge failed: merge again without another turn.
    if (existing?.goal?.outcome === "complete") {
      await this.childSettled(existing);
      return;
    }
    // Interrupted by an app restart: resume in the goal's own session, keeping its checklist and branches.
    if (existing) {
      if (existing.goal) Object.assign(existing.goal, { stopped: undefined, outcome: undefined });
      await this.followup(existing.id, "[앱] 앱이 다시 시작되어 끊긴 작업을 이어 갑니다. 작업 트리의 파일·커밋으로 어디까지 했는지 확인하고 체크리스트를 이어 가세요.");
      return;
    }
    const config = this.configs.get(commander.id) ?? { skills: [], systemPrompt: "" };
    const child = await this.create({
      prompt: `${goal.brief}\n\n(총지휘 목표 [${goal.key}] ${goal.title}. 다른 목표는 다른 세션이 맡습니다. 이 목표만 끝내세요.)`,
      agent: commander.agent, workers: commander.workers, workerConfigs: commander.workerConfigs,
      model: commander.model, reasoningEffort: commander.reasoningEffort, planner: commander.planner,
      cwd: commander.cwd, workspaceId: commander.workspaceId, groupId: commander.groupId,
      mode: commander.mode, autoSwitch: commander.autoSwitch, permissionMode: commander.permissionMode,
      skills: config.skills, systemPrompt: config.systemPrompt,
      goal: true, parentId: commander.id,
    });
    child.title = `[${goal.key}] ${goal.title}`.slice(0, 80);
    goal.childId = child.id;
    this.broadcast(child);
    this.event(commander, commander.agent, "status", `목표 [${goal.key}] ${goal.title}: 세션을 시작했습니다.`);
  }

  /** A commander turn: read-only; its answer's goals join the board and the tick starts them. */
  private async executeCommander(session: Session, userPrompt: string, systemPrompt: string, controller: AbortController) {
    const state = session.commander!;
    const board = commanderBoard(session, (id) => this.sessions.get(id));
    const handoff = session.handoffContext ? `\n\n이전 대화 요약:\n${session.handoffContext}` : session.cliSessionId ? "" : `\n\n이전 대화 요약:\n${this.conversationSummary(session, session.agent)}`;
    const prompt = `${systemPrompt ? `${systemPrompt}\n\n` : ""}${COMMANDER_RULES}\n\n${cliNotes(session.agent, "orchestrator")}${board ? `\n\n${board}` : ""}${handoff}\n\n사용자 요청:\n${userPrompt}`;
    const result = await this.runAgent(session, session.agent, prompt, session.model, session.reasoningEffort, session.cliSessionId, controller.signal, true, true, "orchestrator");
    if (controller.signal.aborted) return this.finishStopped(session, controller);
    if (result.sessionId) session.cliSessionId = result.sessionId;
    if (result.exitCode !== 0) throw new Error(`${agentNames[session.agent]} CLI가 종료 코드 ${result.exitCode}로 끝났습니다.`);
    delete session.handoffContext;
    state.reporting = false;
    this.addGoals(session, result.finalText);
    this.finish(session);
  }

  /** Puts the goals of a lead's answer on the chat's board (the tick starts them); returns how many. */
  private addGoals(session: Session, text: string): number {
    const state = session.commander ??= { goals: [] };
    const taken = new Set(state.goals.map((goal) => goal.key));
    const renamed = new Map<string, string>();
    // A goal the board already has is not added again (the commander tends to restate goals when
    // the user asks to carry on); only a stopped or failed one may come back as a new goal.
    const sameTitle = (title: string) => title.replace(/\s+/gu, " ").trim().toLowerCase();
    const live = new Map(state.goals.filter((goal) => goal.state !== "stopped" && goal.state !== "failed").map((goal) => [sameTitle(goal.title), goal.key]));
    const duplicates: string[] = [];
    const added = parseGoals(text, taken).filter((parsed) => {
      const existing = live.get(sameTitle(parsed.title));
      if (!existing) return true;
      renamed.set(parsed.key, existing);
      duplicates.push(existing);
      return false;
    }).map((parsed) => {
      let key = parsed.key;
      for (let n = state.goals.length + 1; taken.has(key); n++) key = `g${n}`;
      taken.add(key);
      renamed.set(parsed.key, key);
      return { ...parsed, key };
    }).map((parsed): CommanderGoal => ({
      key: parsed.key, title: parsed.title, brief: parsed.brief,
      // A new goal may wait on an older goal of the board too.
      after: parsed.after.map((key) => renamed.get(key) ?? key),
      state: "waiting", createdAt: new Date().toISOString(),
    }));
    if (added.length) {
      state.goals.push(...added);
      state.reported = false;
      this.event(session, session.agent, "status", `목표 ${added.length}개를 등록했습니다: ${added.map((goal) => `[${goal.key}] ${goal.title}${goal.after.length ? ` (${goal.after.join(", ")} 다음)` : ""}`).join(", ")}`);
    }
    if (duplicates.length) this.event(session, session.agent, "status", `이미 보드에 있는 목표는 다시 만들지 않았습니다: ${duplicates.map((key) => `[${key}]`).join(", ")}`);
    return added.length;
  }
}
