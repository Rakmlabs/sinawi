import type { AgentId, WorkspaceId, WorkspacePolicy, WorkspaceState } from "./types.js";

const allAgents: AgentId[] = ["codex", "claude", "grok"];

export type AllowedAgentResolver = (workspaceId: WorkspaceId) => readonly AgentId[];
export type WorkspacePolicyResolver = (workspaceId: WorkspaceId) => WorkspacePolicy;

/** Error raised when this workspace's settings forbid an action; the API reports it with this code. */
export const workspacePolicyErrorCode = "workspace-policy";

export class WorkspacePolicyError extends Error {
  readonly code = workspacePolicyErrorCode;
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePolicyError";
  }
}

/** Invalid workspace settings sent to the API. */
export class WorkspacePolicyInputError extends Error {}

/** Every policy message points the user here; the client recognizes it to offer a link to the setting. */
export const workspacePolicyHint = "설정 › 작업 공간";
export const isWorkspacePolicyMessage = (text: string | undefined) => Boolean(text?.includes(`이 작업 공간 설정에서`) && text.includes(workspacePolicyHint));

export const mediaBlockedMessage = "이 작업 공간 설정에서 이미지·영상 생성이 꺼져 있습니다. 설정 › 작업 공간에서 켤 수 있습니다.";
export const blockedToolMessage = (name: string) => `이 작업 공간 설정에서 차단된 도구입니다: ${name}. 설정 › 작업 공간에서 차단을 풀 수 있습니다.`;

/** A fresh workspace: every agent, media generation and tool allowed. */
export function defaultWorkspacePolicy(): WorkspacePolicy {
  // Computer control is the one opt-in: it reaches outside the project, so it starts off.
  // Full access (no approval prompts) is opt-in for the same reason; absent means off.
  return { mediaGeneration: true, computerUse: false, grokMcp: true, blockedTools: [], authAlertTools: [] };
}

/** MCP server names are CLI config keys; agent-scoped entries are `agent:name`. */
export const toolNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

function toolEntry(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const [prefix, ...rest] = trimmed.split(":");
  if (rest.length === 0) return toolNamePattern.test(trimmed) ? trimmed : undefined;
  const name = rest.join(":");
  return rest.length === 1 && allAgents.includes(prefix as AgentId) && toolNamePattern.test(name) ? `${prefix}:${name}` : undefined;
}

function toolList(value: unknown, strict: boolean, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    if (strict) throw new WorkspacePolicyInputError(`${label} 목록이 올바르지 않습니다.`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const entry = toolEntry(item);
    if (!entry) {
      if (strict) throw new WorkspacePolicyInputError(`${label} 이름이 올바르지 않습니다: ${String(item).slice(0, 100)}`);
      continue;
    }
    if (!result.some((known) => known.toLocaleLowerCase() === entry.toLocaleLowerCase())) result.push(entry);
  }
  return result;
}

/**
 * Validates a policy. `strict` (API input) throws on bad values; otherwise (stored data) bad values
 * fall back to the defaults. Missing fields take `base` (the stored policy for partial updates).
 */
export function normalizeWorkspacePolicy(value: unknown, strict = false, base: WorkspacePolicy = defaultWorkspacePolicy()): WorkspacePolicy {
  if (value == null) return structuredClone(base);
  if (typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new WorkspacePolicyInputError("작업 공간 설정이 올바르지 않습니다.");
    return structuredClone(base);
  }
  const input = value as Record<string, unknown>;
  const flag = (key: "mediaGeneration" | "computerUse" | "grokMcp" | "fullAccess", label: string): boolean => {
    if (input[key] == null) return base[key] ?? false;
    if (typeof input[key] === "boolean") return input[key] as boolean;
    if (strict) throw new WorkspacePolicyInputError(`${label} 설정이 올바르지 않습니다.`);
    return base[key] ?? false;
  };
  let mediaPrompt = base.mediaPrompt;
  if (input.mediaPrompt !== undefined) {
    if (input.mediaPrompt === null || input.mediaPrompt === "") mediaPrompt = undefined;
    else if (typeof input.mediaPrompt === "string" && input.mediaPrompt.length <= 4_000) mediaPrompt = input.mediaPrompt.trim() || undefined;
    else if (strict) throw new WorkspacePolicyInputError("미디어 작업 안내는 4000자 이하 문자열이어야 합니다.");
  }
  return {
    mediaGeneration: flag("mediaGeneration", "이미지·영상 생성"),
    computerUse: flag("computerUse", "컴퓨터 조작"),
    grokMcp: flag("grokMcp", "Grok MCP 도구"),
    ...(flag("fullAccess", "전체 권한") ? { fullAccess: true } : {}),
    blockedTools: input.blockedTools === undefined ? [...base.blockedTools] : toolList(input.blockedTools, strict, "차단 도구"),
    authAlertTools: input.authAlertTools === undefined ? [...base.authAlertTools] : toolList(input.authAlertTools, strict, "인증 알림 도구"),
    ...(mediaPrompt ? { mediaPrompt } : {}),
  };
}

/** MCP server names locked off for `agent` in this workspace. */
export function lockedToolsFor(policy: WorkspacePolicy | undefined, agent: AgentId): string[] {
  if (!policy) return [];
  return [...new Set(policy.blockedTools.flatMap((entry) => {
    const [prefix, name] = entry.includes(":") ? entry.split(":") : [undefined, entry];
    return !prefix || prefix === agent ? [name] : [];
  }))];
}

export function isToolLocked(policy: WorkspacePolicy | undefined, agent: AgentId, name: string): boolean {
  const lowered = name.toLocaleLowerCase();
  return lockedToolsFor(policy, agent).some((item) => item.toLocaleLowerCase() === lowered);
}

/** CLI deny patterns this workspace adds to a run of `agent`. */
export function policyDenyPatterns(policy: WorkspacePolicy | undefined, agent: AgentId): string[] {
  const patterns = lockedToolsFor(policy, agent).map((name) => `mcp__${name}__*`);
  if (agent === "grok" && policy && !policy.grokMcp) patterns.push("mcp__*");
  return patterns;
}

/** Whether agents in this workspace may see the screen and use mouse/keyboard through Sinawi. Off unless the user turned it on. */
export function isComputerUseAllowed(state: Pick<WorkspaceState, "settings"> | undefined, workspaceId: WorkspaceId): boolean {
  return state?.settings?.[workspaceId]?.computerUse === true;
}

export const computerUseBlockedMessage = "이 작업 공간 설정에서 컴퓨터 조작이 꺼져 있습니다. 설정 › 작업 공간에서 켤 수 있습니다.";

export function assertMediaAllowed(policy: WorkspacePolicy | undefined): void {
  if (policy && !policy.mediaGeneration) throw new WorkspacePolicyError(mediaBlockedMessage);
}

export function allowedAgentsForWorkspace(_workspaceId: WorkspaceId, configured?: readonly AgentId[]): AgentId[] {
  return [...new Set(configured ?? allAgents)].filter((agent): agent is AgentId => allAgents.includes(agent));
}

export function assertAgentsAllowed(workspaceId: WorkspaceId, agents: readonly AgentId[], allowed?: readonly AgentId[]): void {
  const enabled = new Set(allowedAgentsForWorkspace(workspaceId, allowed));
  const blocked = agents.find((agent) => !enabled.has(agent));
  if (!blocked) return;
  const name = blocked === "codex" ? "Codex" : blocked === "claude" ? "Claude" : "Grok Build";
  throw new WorkspacePolicyError(`이 작업 공간 설정에서 ${name} 사용이 꺼져 있습니다. 설정 › 작업 공간에서 허용할 수 있습니다.`);
}
