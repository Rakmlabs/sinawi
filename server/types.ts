export type AgentId = "codex" | "claude" | "grok";
/** User-defined workspace id: 1–64 chars of `[a-z0-9-]`. Legacy installs keep "personal" and "company". */
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
  metadata?: { auto?: boolean; from?: AgentId; to?: AgentId; reason?: string; previousConfig?: UpdateTeamInput; previousPlanner?: AgentSelection; undone?: boolean; deletedWorker?: boolean; quotaFallback?: boolean; resetsAt?: number; live?: "status" | "directive"; ambiguous?: boolean; promoted?: boolean; prompt?: string; targetWorkerId?: string; briefAutofilled?: string[]; phase?: "verify" | "replan" | "self-work"; round?: number; stall?: "repeated-error" | "repeated-command" | "no-progress" | "tool-family-loop" | "no-success" };
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

export interface WorkspaceState {
  currentWorkspaceId: WorkspaceId;
  /** Ordered list of user-defined workspaces; never empty. */
  workspaces: WorkspaceInfo[];
  defaults: Record<string, WorkspaceDefaults>;
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
