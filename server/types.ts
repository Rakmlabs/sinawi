export type AgentId = "codex" | "claude" | "grok";
/** User-defined workspace id: 1–64 chars of `[a-z0-9-]`. */
export type WorkspaceId = string;
export type SessionStatus = "running" | "done" | "error" | "stopped";
export type EventType = "warning" | "message" | "tool" | "command" | "edit" | "status" | "error" | "delegation" | "handoff";

export interface AgentSelection {
  id?: string;
  label?: string;
  agent: AgentId;
  model?: string;
  reasoningEffort?: string;
  reason?: string;
  sessionMode?: "new" | "resume";
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  available: boolean;
  detail: string;
}

export interface SkillInfo {
  agents?: AgentId[];
  id: string;
  name: string;
  source: string;
  description: string;
}

export interface Bot {
  id: string;
  name: string;
  agent: AgentId;
  model?: string;
  skills: string[];
  systemPrompt: string;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  createdAt: string;
  workspaceId: WorkspaceId;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  agent: AgentId | "user";
  type: EventType;
  text: string;
  time: string;
  role?: "orchestrator" | "worker" | "planner";
  delegationId?: string;
  taskStatus?: SessionStatus;
  model?: string;
  reasoningEffort?: string;
  workerId?: string;
  workerLabel?: string;
  metadata?: { auto?: boolean; from?: AgentId; to?: AgentId; reason?: string; previousConfig?: UpdateTeamInput; previousPlanner?: AgentSelection; undone?: boolean; deletedWorker?: boolean; quotaFallback?: boolean; resetsAt?: number; live?: "status" | "directive"; ambiguous?: boolean; promoted?: boolean; prompt?: string; targetWorkerId?: string; briefAutofilled?: string[]; phase?: "verify" | "replan" | "self-work" | "worker-report" | "verify-cut"; round?: number; stall?: "repeated-error" | "repeated-command" | "no-progress" | "tool-family-loop" | "no-success"; mergeHold?: "ask" | "never"; addedWorker?: AgentId; schedule?: ScheduleCard; leadSkill?: { name: string; scope: "lead" | "project"; action: "created" | "updated" } };
}

export interface PendingInstruction {
  id: string;
  text: string;
  targetWorkerId?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string;
  agent: AgentId;
  workers: AgentId[];
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  workerConfigs?: AgentSelection[];
  planner?: AgentSelection;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  cliSessionId?: string;
  workerSessionIds?: Record<string, string>;
  events: SessionEvent[];
  groupId?: string;
  skills?: string[];
  systemPrompt?: string;
  handoffContext?: string;
  mode?: "auto" | "manual";
  autoSwitch?: boolean;
  /** Unset on sessions from before modes: they follow the workspace's full-access switch. */
  permissionMode?: PermissionMode;
  turnCount?: number;
  lastAutoSwitchTurn?: number;
  workspaceId: WorkspaceId;
  pendingInstructions?: PendingInstruction[];
  /** Git worktrees the session's workers ran in (git repositories only). */
  worktrees?: WorktreeInfo[];
  /** Last raw CLI output of the running step, including output that renders nothing (thinking). */
  lastActivityAt?: string;
  /** Run-to-completion: the app keeps opening turns until the lead's checklist is settled (server/goals.ts). */
  goal?: GoalState;
  /** This session only splits work into goal sessions and reports on them (server/goals.ts). */
  commander?: CommanderState;
  /** The project lead: the chat the user keeps giving work to (server/steward.ts). */
  steward?: StewardState;
  /** Lead entity this ordinary chat belonged to before lead mode was disabled. */
  disabledStewardId?: string;
  /** The commander session this goal session was started for. */
  parentId?: string;
}

export interface GoalItem {
  text: string;
  status: "open" | "done" | "blocked";
  note?: string;
}

export interface GoalState {
  items: GoalItem[];
  startedAt: string;
  /** Turns the app opened by itself. */
  autoTurns: number;
  /** Auto turns in a row that settled no item. */
  idleTurns: number;
  /** Why the loop ended; unset while it runs. */
  stopped?: string;
  /** How it ended: every item settled, the user stopped it, or a limit or error cut it short. */
  outcome?: "complete" | "stopped" | "unfinished";
}

export type CommanderGoalState = "waiting" | "running" | "done" | "merged" | "blocked" | "failed" | "stopped";

export interface CommanderGoal {
  key: string;
  title: string;
  brief: string;
  after: string[];
  state: CommanderGoalState;
  childId?: string;
  merge?: { ok: boolean; text: string; commit?: string };
  createdAt: string;
  endedAt?: string;
}

/** What happens to a lead's finished worker branches at the end of a turn (server/steward.ts). */
export type MergePolicy = "auto" | "ask" | "never";

/**
 * A project lead as its own thing, like a Bot: its name, instructions, skills, default team and
 * merge policy. Chats are its threads (`Session.steward.id`). Stored in stewards.json.
 * `agent`/`model`/`reasoningEffort` are the lead's own CLI; `workers` uses the workerConfigs form.
 */
export interface Steward extends Bot {
  reasoningEffort?: string;
  workers: AgentSelection[];
  mergePolicy: MergePolicy;
  /** Project folders this lead works in; its threads start in the first one by default. */
  cwds: string[];
  /** The workspace (공간) the lead and all its threads belong to. Unset only on leads saved before
   * leads were per workspace; Orchestra.restore fills it in (its chats' workspace, else the first one). */
  workspaceId?: WorkspaceId;
  /** A daily report at this local time ("HH:MM"), one per lead, opened in its latest chat (server/steward.ts reportDue). */
  report?: string;
  reportedAt?: string;
  /** The lead's projects' git state when the last report opened: unchanged and quiet, the next is skipped. */
  reportState?: string;
  /** Made from a lead chat saved before leads were entities (Orchestra.restore). */
  migrated?: true;
  /** The user picked this lead's merge policy (here or for all leads): the legacy default no longer moves it. */
  mergePolicyChosen?: true;
  updatedAt?: string;
}

/** App-wide lead settings, kept in workspaces.json. */
export interface StewardSettings {
  /** Merge policy of leads migrated from older lead chats; unset means "auto" (how they always worked). */
  legacyMergePolicy?: Exclude<MergePolicy, "never">;
}

/** Worker branches a lead finished, held for the user to approve (mergePolicy "ask"). */
export interface PendingMerge {
  branches: { workerId: string; workerLabel?: string; branch: string; path: string }[];
  createdAt: string;
}

export interface StewardState {
  /** The Steward entity this chat is a thread of; set on every lead chat once loaded (old ones migrate). */
  id?: string;
  /** Worker branches waiting for the user's approval before they go into the main checkout. */
  pendingMerge?: PendingMerge;
  /** Lead turns on the current CLI session; at STEWARD_ROLLOVER_TURNS the app starts a fresh one. */
  turns: number;
  since: string;
  /** What other leads and the sidebar call it; the project folder's name when unset. */
  name?: string;
  /**
   * Before reports were per lead: this chat's own report time. Moved to the Steward on load
   * (Orchestra.restore) and removed here; kept in the type so older files still read.
   */
  report?: string;
  reportedAt?: string;
  /** The project's git state when the last report opened: an unchanged, quiet project skips the next. */
  reportState?: string;
  /** Messages waiting for this lead (other leads' questions and answers, its report). Kept across restarts. */
  inbox?: StewardDelivery[];
  /** The lead whose question this lead is answering now; its answer goes back when the work ends. */
  answering?: { id: string; question: string; depth: number };
  /** Lets another lead's request change this project; off, the lead only looks and answers. */
  acceptWork?: boolean;
  /** What the app did after the last turn (merges), told to the lead at the start of the next. */
  appNotes?: string[];
}

export interface StewardDelivery {
  prompt: string;
  /** A question from another lead: the answer goes back to `replyTo.id`. */
  replyTo?: { id: string; question: string; depth: number };
  /** Lead-to-lead hops so far (server/steward.ts MAX_ASK_DEPTH). */
  depth?: number;
}

export interface CommanderState {
  goals: CommanderGoal[];
  /** The commander was told every goal settled; reset when goals are added. */
  reported?: boolean;
  /** The app's summary turn is running. */
  reporting?: boolean;
  /** Started as a commander (StartSessionInput.commander) rather than split by its lead. */
  forced?: boolean;
}

/** A worker's own git worktree and branch (see server/worktrees.ts). */
export interface WorktreeInfo {
  workerId: string;
  workerLabel?: string;
  branch: string;
  /** Worktree root. */
  path: string;
  /** Where the worker runs: the session folder's counterpart inside the worktree. */
  cwd: string;
  repoRoot: string;
  /** Commit the branch started from. */
  base: string;
  createdAt: string;
  /** The main tree had uncommitted changes when the worktree was made; they are not in it. */
  mainDirty?: boolean;
}

export interface WorktreeStatus extends WorktreeInfo {
  exists: boolean;
  /** Files that differ from `base`, committed or not (tracked and untracked). */
  changedFiles: number;
  files: string[];
  /** Files with uncommitted changes in the worktree. */
  uncommitted: number;
  /** Commits on the branch after `base`. */
  commits: number;
  mergeCommand: string;
}

export interface WorkspaceDefaults {
  cwd?: string;
  mode?: "auto" | "manual";
  agent?: AgentId;
  workers?: AgentId[];
  model?: string;
  reasoningEffort?: string;
  workerConfigs?: AgentSelection[];
  autoSwitch?: boolean;
  allowedAgents?: AgentId[];
  quotaFallback?: boolean;
  quotaThreshold?: number;
  fallbackOrder?: Partial<Record<AgentId, AgentId[]>>;
  permissionMode?: PermissionMode;
}

export interface WorkspaceInfo {
  id: WorkspaceId;
  name: string;
}

/**
 * Per-workspace rules any user can configure. Which agents may run lives in
 * `WorkspaceDefaults.allowedAgents`; everything else a workspace may restrict lives here.
 */
export interface WorkspacePolicy {
  /** Image/video generation requests (media routing) are allowed. */
  mediaGeneration: boolean;
  /** Agents may see the screen and use mouse/keyboard through Sinawi (needs macOS Screen Recording and Accessibility). */
  computerUse: boolean;
  /**
   * Opt-in, set by the user: agents run without approval prompts (Claude
   * --dangerously-skip-permissions, Codex without sandbox, Grok bypassPermissions), like an
   * interactive CLI session where every prompt is accepted. Blocked tools stay blocked.
   * Read-only review runs are not affected.
   */
  fullAccess?: boolean;
  /** Grok may call MCP tools at all. Off adds a blanket MCP deny to every Grok run. */
  grokMcp: boolean;
  /**
   * MCP servers locked off in this workspace: `"name"` for every agent or `"agent:name"` for one.
   * Locked tools cannot be turned on from the tools panel and are denied on every CLI run.
   */
  blockedTools: string[];
  /** MCP servers whose missing login raises a notification in this workspace. */
  authAlertTools: string[];
  /** Extra instructions given to media workers (e.g. which media tools exist and how to use them). */
  mediaPrompt?: string;
  /**
   * Per-agent CLI account folders for this workspace: every CLI run of that agent here gets
   * CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME set to it (server/cli.ts accountEnv). Unset: the default login.
   */
  accounts?: WorkspaceAccounts;
}

/** An absolute folder per agent holding that CLI's login, settings, sessions and skills. */
export type WorkspaceAccounts = Partial<Record<AgentId, string>>;

export interface WorkspaceState {
  currentWorkspaceId: WorkspaceId;
  /** Ordered list of user-defined workspaces; never empty. */
  workspaces: WorkspaceInfo[];
  defaults: Record<string, WorkspaceDefaults>;
  /** Policy of every listed workspace. The store always fills it in; older payloads may lack it. */
  settings?: Record<string, WorkspacePolicy>;
  /** App-wide project lead settings (server/steward.ts). */
  stewardSettings?: StewardSettings;
}

export interface ToolWorkspaceSettings {
  disabledSkills: string[];
  disabledMcp: string[];
}

export type ToolSettings = Record<string, ToolWorkspaceSettings>;

export interface UpdateTeamInput extends AgentSelection {
  workers: AgentId[];
  workerConfigs?: AgentSelection[];
}

/**
 * How much a run may do without asking, like Claude Code's modes. "plan": every CLI read-only, the
 * lead answers with a plan; "auto": the default sandboxes and approval rules; "full": no approvals
 * (only where the workspace allows it, WorkspacePolicy.fullAccess).
 */
export type PermissionMode = "plan" | "auto" | "full";

export interface ConversationSettings {
  mode?: "auto" | "manual";
  autoSwitch?: boolean;
  permissionMode?: PermissionMode;
  /** Run multi-step requests to completion and split big ones into chats (server/goals.ts). */
  autoRun?: boolean;
}

export interface StartSessionInput extends ConversationSettings {
  /** Empty: an empty chat that starts with its first follow-up. */
  prompt: string;
  /** Title to open with (otherwise from the prompt). */
  title?: string;
  agent: AgentId;
  workers?: AgentId[];
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  workerConfigs?: AgentSelection[];
  planner?: AgentSelection;
  skills?: string[];
  systemPrompt?: string;
  resumeSessionId?: string;
  groupId?: string;
  workspaceId?: WorkspaceId;
  /** A goal chat a commander started: runs to completion and never splits (server/goals.ts). */
  goal?: boolean;
  /** Starts as a commander that only splits the request into goal chats (server/goals.ts). */
  commander?: boolean;
  /** Starts as the project lead (server/steward.ts): a new one, or a new thread of Steward `id`. */
  steward?: { name?: string; id?: string };
  parentId?: string;
}

export interface ConversationInput {
  botA: string;
  botB: string;
  turns: number;
  prompt: string;
  cwd: string;
  workspaceId?: WorkspaceId;
  /** Left out: the workspace's switch decides (the app's own screen). MCP tools always send one. */
  permissionMode?: PermissionMode;
}

/** A message an agent is still writing, streamed to the app as it grows (never stored; see NormalizedLine.draft). */
export interface SessionDraft {
  sessionId: string;
  agent: AgentId;
  role?: SessionEvent["role"];
  workerId?: string;
  /** Text so far; "" ends the draft (the whole message is now an event, or the run moved on). */
  text: string;
}

export interface NormalizedLine {
  type: EventType;
  text: string;
  finalText?: string;
  appendFinal?: boolean;
  delta?: boolean;
  /** A fragment of a message still being written: shown live in the app, never stored (the whole message follows). */
  draft?: boolean;
  sessionId?: string;
  /** A tool result's own verdict (is_error, status): true failed, false succeeded, absent when the CLI does not say. */
  failed?: boolean;
}

/** A schedule change or run shown as a small card in the lead's chat (SessionEvent.metadata.schedule). */
export interface ScheduleCard {
  id: string;
  title: string;
  action: "created" | "updated" | "deleted" | "fired" | "missed";
  by: "user" | "lead" | "app";
  at?: string;
  cron?: string;
  timezone?: string;
  nextRunAt?: string;
  enabled?: boolean;
}
