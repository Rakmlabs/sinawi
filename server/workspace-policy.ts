import type { AgentId, WorkspaceId } from "./types.js";

const allAgents: AgentId[] = ["codex", "claude", "grok"];

export type AllowedAgentResolver = (workspaceId: WorkspaceId) => readonly AgentId[];

export function allowedAgentsForWorkspace(workspaceId: WorkspaceId, configured?: readonly AgentId[]): AgentId[] {
  const source = configured ?? (workspaceId === "company" ? ["claude", "grok"] : allAgents);
  return [...new Set(source)].filter((agent): agent is AgentId =>
    allAgents.includes(agent) && !(workspaceId === "company" && agent === "codex"),
  );
}

export function assertAgentsAllowed(workspaceId: WorkspaceId, agents: readonly AgentId[], allowed?: readonly AgentId[]): void {
  const enabled = new Set(allowedAgentsForWorkspace(workspaceId, allowed));
  const blocked = agents.find((agent) => !enabled.has(agent));
  if (!blocked) return;
  const name = blocked === "codex" ? "Codex" : blocked === "claude" ? "Claude" : "Grok Build";
  if (workspaceId === "company" && blocked === "codex") throw new Error("회사 공간에서는 Codex를 사용할 수 없습니다.");
  throw new Error(`이 공간에서는 ${name}를 사용할 수 없습니다.`);
}
