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
  metadata?: { auto?: boolean; from?: AgentId; to?: AgentId; reason?: string; previousConfig?: UpdateTeamInput; previousPlanner?: AgentSelection; undone?: boolean; deletedWorker?: boolean; quotaFallback?: boolean; resetsAt?: number; live?: "status" | "directive"; ambiguous?: boolean; promoted?: boolean; prompt?: string; targetWorkerId?: string; briefAutofilled?: string[]; phase?: "verify" | "replan" | "self-work" | "worker-report" | "verify-cut"; round?: number; stall?: "repeated-error" | "repeated-command" | "no-progress" | "tool-family-loop" | "no-success" };
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
  turnCount?: number;
  lastAutoSwitchTurn?: number;
  workspaceId: WorkspaceId;
  pendingInstructions?: PendingInstruction[];
  /** Git worktrees the session's workers ran in (git repositories only). */
  worktrees?: WorktreeInfo[];
  /** Last raw CLI output of the running step, including output that renders nothing (thinking). */
  lastActivityAt?: string;
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
}

export interface WorkspaceState {
  currentWorkspaceId: WorkspaceId;
  /** Ordered list of user-defined workspaces; never empty. */
  workspaces: WorkspaceInfo[];
  defaults: Record<string, WorkspaceDefaults>;
  /** Policy of every listed workspace. The store always fills it in; older payloads may lack it. */
  settings?: Record<string, WorkspacePolicy>;
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

export interface ConversationSettings {
  mode?: "auto" | "manual";
  autoSwitch?: boolean;
}

export interface StartSessionInput extends ConversationSettings {
  prompt: string;
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
}

export interface ConversationInput {
  botA: string;
  botB: string;
  turns: number;
  prompt: string;
  cwd: string;
  workspaceId?: WorkspaceId;
}

export interface NormalizedLine {
  type: EventType;
  text: string;
  finalText?: string;
  appendFinal?: boolean;
  delta?: boolean;
  sessionId?: string;
}
