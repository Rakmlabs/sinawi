import { accountLoginCommand } from "./workspace-policy.js";
import type { AgentId, Session, WorkspaceId, WorkspacePolicy } from "./types.js";
import type { NotificationInput } from "./notification-types.js";
import { mcpAuthAction, mcpAuthTitle } from "./tools.js";
import { stewardName, stripLeadBlocks } from "./steward.js";

const mcpAuthFailure = /\bmcp\b[^\n]*(?:needs? authentication|requires? authentication|authentication required|unauthori[sz]ed|not logged in|401)|(?:needs? authentication|authentication required|not logged in)[^\n]*\bmcp\b/i;
const mcpNameIn = (text: string) => /(?:mcp(?:\s+server)?|server)\s*[`'"“]([^`'"”\n]{1,120})[`'"”]/i.exec(text)?.[1]?.trim();

export function authNotification(workspaceId: WorkspaceId, agent: AgentId, status?: string, detail?: string, accountDir?: string): NotificationInput | undefined {
  if (status !== "unauthenticated") return;
  return { workspaceId, key: `auth:${agent}`, type: "auth", title: `${agent === "grok" ? "Grok" : agent === "claude" ? "Claude" : "Codex"} 로그인 필요`, body: detail || "CLI에서 로그인한 뒤 인증 상태를 다시 확인합니다.", action: { label: "터미널에서 로그인", command: accountDir ? accountLoginCommand(agent, accountDir) : agent === "grok" ? "grok" : agent === "claude" ? "claude auth login" : "codex login" } };
}

export function sessionNotifications(session: Session, accounts?: WorkspacePolicy["accounts"]): NotificationInput[] {
  const action = { label: "채팅으로 이동", sessionId: session.id };
  const notes: NotificationInput[] = [];
  const seenMcp = new Set<string>();
  let requestId = "initial";
  for (const event of session.events) {
    if (event.agent === "user" && event.type === "message") requestId = event.id;
    if (event.type === "error" && mcpAuthFailure.test(event.text)) {
      const agent = event.agent === "user" ? session.agent : event.agent;
      const name = mcpNameIn(event.text);
      const dedupe = `${agent}:${name ?? "?"}`;
      if (seenMcp.has(dedupe)) continue;
      seenMcp.add(dedupe);
      const auth = mcpAuthAction(agent, name ?? "<서버>", accounts?.[agent]);
      notes.push({ workspaceId: session.workspaceId, key: `mcp-run-auth:${session.id}:${dedupe}`, type: "auth",
        title: name ? mcpAuthTitle(agent, [name]) : `${agent === "grok" ? "Grok" : agent === "claude" ? "Claude" : "Codex"}의 MCP 인증이 필요해요`,
        body: `작업이 MCP 인증 때문에 실패했어요. ${auth.hint}`, action: { label: "터미널에서 인증", command: auth.command } });
      continue;
    }
    let type: NotificationInput["type"] | undefined;
    let title = "";
    let key = `event:${event.id}`;
    // A lead's finished work held back from the main checkout: the user has to approve it, or merge it by hand.
    if (event.metadata?.mergeHold && session.steward) {
      notes.push({ workspaceId: session.workspaceId, key: `event:${event.id}`, type: "lead", title: `「${stewardName(session)}」 ${event.metadata.mergeHold === "ask" ? "병합 승인 대기" : "작업 브랜치에 남김"}`, body: event.text.slice(0, 2000), action });
      continue;
    }
    if ((event.type === "error" || event.type === "warning") && /권한 거부|permission denied/i.test(event.text)) {
      type = "permission"; title = "명령 실행 권한이 필요합니다"; key = `permission-run:${session.id}:${requestId}`;
    } else if (event.metadata?.quotaFallback || event.type === "error" && /quota|한도.*소진|rate.limit/i.test(event.text)) {
      type = "quota"; title = "사용 한도 · 에이전트 전환"; key = `quota-run:${session.id}:${requestId}`;
    }
    if (type) notes.push({ workspaceId: session.workspaceId, key, type, title, body: event.text.slice(0, 2000), action });
  }
  // CLI streams contain error events for failed tool calls, worker retries and stderr even when the
  // orchestrator recovers. Only the session's terminal error is a task failure worth interrupting the user for.
  if (session.status === "error") {
    const failure = [...session.events].reverse().find((event) => event.type === "error");
    if (failure && !mcpAuthFailure.test(failure.text)
      && !/권한 거부|permission denied|quota|한도.*소진|rate.limit/i.test(failure.text)) notes.push({
      workspaceId: session.workspaceId,
      key: `failed:${session.id}:${session.endedAt ?? session.turnCount ?? 0}`,
      type: "error",
      title: /응답|정체|inactiv|stalled/i.test(failure.text) ? "작업 응답이 멈췄습니다" : "작업 오류",
      body: failure.text.slice(0, 2000),
      action,
    });
  }
  // A project lead reads like a message from it: its name and what it said last.
  if (session.status === "done" && session.steward) {
    const said = [...session.events].reverse().find((event) => event.type === "message" && event.role === "orchestrator");
    const body = stripLeadBlocks(said?.text ?? "").replace(/\s+/gu, " ").slice(0, 300) || session.title;
    notes.push({ workspaceId: session.workspaceId, key: `lead:${session.id}:${session.endedAt ?? session.turnCount ?? 0}`, type: "lead", title: `「${stewardName(session)}」 담당`, body, action });
  } else if (session.status === "done") notes.push({ workspaceId: session.workspaceId, key: `finished:${session.id}:${session.endedAt ?? session.turnCount ?? 0}`, type: "run-finished", title: "작업 완료", body: session.title, action });
  return notes;
}
