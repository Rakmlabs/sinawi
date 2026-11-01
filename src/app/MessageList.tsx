import type { RefObject } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { CopyButton } from "../CopyButton";
import { Markdown } from "../Markdown";
import { MessageFold, UserMessageBody } from "../media-ui";
import { canPromoteLive, canUndoAutoHandoff, conversationText, liveBadgeLabel, type DelegationTask } from "../conversation";
import { parseAttachmentMessage } from "../viewer-model";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session, SessionEvent } from "../../server/types";

export type MessageListProps = {
  active: Session;
  events: SessionEvent[];
  tasksById: Map<string, DelegationTask>;
  latestHandoffId: string | undefined;
  latestAssistantId: string | undefined;
  choiceOptions: string[];
  streamingMessageId: string | undefined;
  busy: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
  onUndoHandoff: (eventId: string) => void;
  onOpenWorker: (workerId: string) => void;
  onPromote: (eventId: string) => void;
  onChoose: (option: string) => void;
};

const delegationTitle = (text: string) => text.replace(/^.*?에게 위임:\s*/, "");

function DelegationCard({ e, task, active, onOpenWorker }: { e: SessionEvent; task: DelegationTask; active: Session; onOpenWorker: (workerId: string) => void }) {
  const config = task.event.role ? task.event : active.workerConfigs?.find((item) => item.agent === task.event.agent);
  if (e.metadata?.deletedWorker) return <article className="delegation-card deleted-worker" aria-label="삭제된 워커의 작업 위임">
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>작업 위임 · 삭제된 워커</span><strong>{task.event.workerLabel ?? names[task.event.agent]} <em>(삭제된 워커)</em></strong></div><span className="status-label stopped">삭제됨</span></div>
    <h3>{delegationTitle(e.text)}</h3>
    <div className="delegation-bottom"><p>작업 로그가 삭제되었습니다. 다음 위임은 새 세션으로 시작합니다.</p></div>
  </article>;
  const workerId = task.event.workerId ?? task.event.agent;
  return <article className="delegation-card" aria-label="작업 위임">
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>작업 위임</span><strong>{task.event.workerLabel ?? names[task.event.agent]} · {config?.model || "CLI 기본 모델"} · {config?.reasoningEffort || "기본 추론"}</strong></div><span className={`status-label ${task.status}`}>{statusLabels[task.status]}</span><Elapsed start={task.startedAt} end={task.endedAt} /></div>
    <h3>{delegationTitle(e.text)}</h3>
    <div className="delegation-bottom"><p title={task.activity}>{task.activity}</p><button className="button light" aria-controls={`sidebar-worker-${active.id}-${workerId}`} onClick={() => onOpenWorker(workerId)}>작업 보기<ArrowRight size={13} /></button></div>
  </article>;
}

/** The main conversation of the active session: messages, handoffs and delegation cards. */
export function MessageList({ active, events, tasksById, latestHandoffId, latestAssistantId, choiceOptions, streamingMessageId, busy, bottomRef, onUndoHandoff, onOpenWorker, onPromote, onChoose }: MessageListProps) {
  return <div className="messages">
    {events.map((e) => {
      if (e.type === "handoff") return <div className="handoff-divider" key={e.id}>
        <span className="agent-label"><AgentMark agent={e.agent} size="small" />{e.text}</span>
        {e.metadata?.auto && !e.metadata.quotaFallback && e.id === latestHandoffId && <button className="handoff-undo" disabled={busy || !canUndoAutoHandoff(e, active.status, latestHandoffId)} onClick={() => onUndoHandoff(e.id)}>{e.metadata.undone ? "되돌림" : "되돌리기"}</button>}
      </div>;
      if (e.type === "delegation") return <DelegationCard key={e.id} e={e} task={tasksById.get(e.id)!} active={active} onOpenWorker={onOpenWorker} />;
      const isUser = e.agent === "user";
      const text = isUser ? e.text : conversationText(e.text);
      const copied = isUser ? (parseAttachmentMessage(text).body || text) : text;
      const liveBadge = liveBadgeLabel(e);
      return <article className={`message ${isUser ? "user-message" : "assistant-message"}${streamingMessageId === e.id ? " streaming-message" : ""}`} key={e.id}>
        <div className="message-author">
          {isUser ? <span className="user-avatar">나</span> : <AgentMark agent={e.agent} />}
          <strong>{names[e.agent] || e.agent}</strong>
          {liveBadge && <em className={`live-status-badge${liveBadge === "지시" ? " directive" : ""}`}>{liveBadge}</em>}
          <time>{new Date(e.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
          <CopyButton text={copied} className="message-copy" ariaLabel={`${names[e.agent] || e.agent} 메시지 복사`} />
        </div>
        <div className={`message-text ${e.type === "error" ? "error-banner" : e.type === "warning" ? "warning-banner" : ""}`} role={e.type === "error" || e.type === "warning" ? "alert" : undefined}>{isUser ? <UserMessageBody text={text} /> : <MessageFold text={text} streaming={streamingMessageId === e.id}><Markdown text={text} /></MessageFold>}</div>
        {canPromoteLive(e) && <button type="button" className="button light live-promote" onClick={() => onPromote(e.id)}>지시로 넣을까요?</button>}
        {!isUser && e.id === latestAssistantId && choiceOptions.length > 0 && <div className="message-options" aria-label="응답 선택지">
          {choiceOptions.map((option, index) => <button type="button" key={option} onClick={() => onChoose(option)}><span>{index + 1}</span>{option}</button>)}
        </div>}
      </article>;
    })}
    {active.status === "running" && (
      <div className="thinking" role="status">
        <LoaderCircle size={14} className="spin" /> 팀이 작업 중입니다…
      </div>
    )}
    <div ref={bottomRef} />
  </div>;
}
