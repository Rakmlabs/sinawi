import type { AgentId, Session, WorkspaceId } from "./types.js";
import type { NotificationInput } from "./notification-types.js";
import { mcpAuthAction, mcpAuthTitle } from "./tools.js";
import { stewardName, stripLeadBlocks } from "./steward.js";

const mcpAuthFailure = /\bmcp\b[^\n]*(?:needs? authentication|requires? authentication|authentication required|unauthori[sz]ed|not logged in|401)|(?:needs? authentication|authentication required|not logged in)[^\n]*\bmcp\b/i;
const mcpNameIn = (text: string) => /(?:mcp(?:\s+server)?|server)\s*[`'"“]([^`'"”\n]{1,120})[`'"”]/i.exec(text)?.[1]?.trim();

export function authNotification(workspaceId: WorkspaceId, agent: AgentId, status?: string, detail?: string): NotificationInput | undefined {
  if (status !== "unauthenticated") return;
  return { workspaceId, key: `auth:${agent}`, type: "auth", title: `${agent === "grok" ? "Grok" : agent === "claude" ? "Claude" : "Codex"} 로그인 필요`, body: detail || "CLI에서 로그인한 뒤 인증 상태를 다시 확인합니다.", action: { label: "터미널에서 로그인", command: agent === "grok" ? "grok" : agent === "claude" ? "claude auth login" : "codex login" } };
}

export function sessionNotifications(session: Session): NotificationInput[] {
  const action = { label: "채팅으로 이동", sessionId: session.id };
  const notes: NotificationInput[] = [];
  const seenMcp = new Set<string>();
  for (const event of session.events) {
    if (mcpAuthFailure.test(event.text)) {
      const agent = event.agent === "user" ? session.agent : event.agent;
      const name = mcpNameIn(event.text);
      const dedupe = `${agent}:${name ?? "?"}`;
      if (seenMcp.has(dedupe)) continue;
      seenMcp.add(dedupe);
      const auth = mcpAuthAction(agent, name ?? "<서버>");
      notes.push({ workspaceId: session.workspaceId, key: `mcp-run-auth:${session.id}:${dedupe}`, type: "auth",
        title: name ? mcpAuthTitle(agent, [name]) : `${agent === "grok" ? "Grok" : agent === "claude" ? "Claude" : "Codex"}의 MCP 인증이 필요해요`,
        body: `작업이 MCP 인증 때문에 실패했어요. ${auth.hint}`, action: { label: "터미널에서 인증", command: auth.command } });
      continue;
    }
    let type: NotificationInput["type"] | undefined;
    let title = "";
    if (/권한 거부|permission denied/i.test(event.text)) { type = "permission"; title = "명령 실행 권한이 필요합니다"; }
    else if (event.metadata?.quotaFallback || /quota|한도.*소진|rate.limit/i.test(event.text)) { type = "quota"; title = "사용 한도 · 에이전트 전환"; }
    else if (event.type === "error") { type = "error"; title = /응답|정체|inactiv|stalled/i.test(event.text) ? "작업 응답이 멈췄습니다" : "작업 오류"; }
    if (type) notes.push({ workspaceId: session.workspaceId, key: `event:${event.id}`, type, title, body: event.text.slice(0, 2000), action });
  }
  // A project lead reads like a message from it: its name and what it said last.
  if (session.status === "done" && session.steward) {
    const said = [...session.events].reverse().find((event) => event.type === "message" && event.role === "orchestrator");
    const body = stripLeadBlocks(said?.text ?? "").replace(/\s+/gu, " ").slice(0, 300) || session.title;
    notes.push({ workspaceId: session.workspaceId, key: `lead:${session.id}:${session.endedAt ?? session.turnCount ?? 0}`, type: "lead", title: `「${stewardName(session)}」 담당`, body, action });
  } else if (session.status === "done") notes.push({ workspaceId: session.workspaceId, key: `finished:${session.id}:${session.endedAt ?? session.turnCount ?? 0}`, type: "run-finished", title: "작업 완료", body: session.title, action });
  return notes;
}
