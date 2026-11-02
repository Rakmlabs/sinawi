import type { RefObject } from "react";
import { runPhase } from "../run-activity";
import { ArrowRight } from "lucide-react";
import { Beat } from "../Beat";
import { AgentMark } from "../AgentMark";
import { CopyButton } from "../CopyButton";
import { Markdown } from "../Markdown";
import { MessageFold, UserMessageBody } from "../media-ui";
import { canPromoteLive, canUndoAutoHandoff, conversationText, liveBadgeLabel, type DelegationTask } from "../conversation";
import { parseAttachmentMessage } from "../viewer-model";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session, SessionEvent } from "../../server/types";
import { t } from "../i18n";
import { ComputerTrail } from "../ComputerUse";
import { QuietIndicator } from "./QuietIndicator";
import { WorktreePanel } from "./WorktreePanel";

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
  /** Runs the plan a plan-mode turn just wrote. */
  onExecutePlan?: () => void;
};

const delegationTitle = (text: string) => text.replace(/^.*?에게 위임:\s*/, "");

function DelegationCard({ e, task, active, onOpenWorker }: { e: SessionEvent; task: DelegationTask; active: Session; onOpenWorker: (workerId: string) => void }) {
  const config = task.event.role ? task.event : active.workerConfigs?.find((item) => item.agent === task.event.agent);
  if (e.metadata?.deletedWorker) return <article className="delegation-card deleted-worker" aria-label={t("deleg.deletedLabel")}>
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>{t("deleg.deletedHeading")}</span><strong>{task.event.workerLabel ?? names[task.event.agent]} <em>{t("deleg.deletedWorker")}</em></strong></div><span className="status-label stopped">{t("deleg.deleted")}</span></div>
    <h3>{delegationTitle(e.text)}</h3>
    <div className="delegation-bottom"><p>{t("deleg.logDeleted")}</p></div>
  </article>;
  const workerId = task.event.workerId ?? task.event.agent;
  return <article className="delegation-card" aria-label={t("deleg.label")}>
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>{t("deleg.label")}</span><strong>{task.event.workerLabel ?? names[task.event.agent]} · {config?.model || t("usage.cliDefaultModel")} · {config?.reasoningEffort || t("team.defaultReasoning")}</strong></div><span className={`status-label ${task.status}`}>{task.status === "running" && <Beat />}{statusLabels[task.status]}</span><Elapsed start={task.startedAt} end={task.endedAt} /></div>
    <h3>{delegationTitle(e.text)}</h3>
    <div className="delegation-bottom"><p title={task.activity}>{task.activity}</p><button className="button light" aria-controls={`sidebar-worker-${active.id}-${workerId}`} onClick={() => onOpenWorker(workerId)}>{t("deleg.view")}<ArrowRight size={13} /></button></div>
  </article>;
}

/** The main conversation of the active session: messages, handoffs and delegation cards. */
export function MessageList({ active, events, tasksById, latestHandoffId, latestAssistantId, choiceOptions, streamingMessageId, busy, bottomRef, onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan }: MessageListProps) {
  return <div className="messages">
    {events.flatMap((e, index) => [(() => {
      if (e.type === "handoff") return <div className="handoff-divider" key={e.id}>
        <span className="agent-label"><AgentMark agent={e.agent} size="small" />{e.text}</span>
        {e.metadata?.auto && !e.metadata.quotaFallback && e.id === latestHandoffId && <button className="handoff-undo" disabled={busy || !canUndoAutoHandoff(e, active.status, latestHandoffId)} onClick={() => onUndoHandoff(e.id)}>{e.metadata.undone ? t("msg.undone") : t("msg.undo")}</button>}
      </div>;
      if (e.type === "delegation") return <DelegationCard key={e.id} e={e} task={tasksById.get(e.id)!} active={active} onOpenWorker={onOpenWorker} />;
      const isUser = e.agent === "user";
      const text = isUser ? e.text : conversationText(e.text);
      const copied = isUser ? (parseAttachmentMessage(text).body || text) : text;
      const liveBadge = liveBadgeLabel(e);
      return <article className={`message ${isUser ? "user-message" : "assistant-message"}${streamingMessageId === e.id ? " streaming-message" : ""}`} key={e.id}>
        <div className="message-author">
          {isUser ? <span className="user-avatar">{t("names.user")}</span> : <AgentMark agent={e.agent} />}
          <strong>{names[e.agent] || e.agent}</strong>
          {liveBadge && <em className={`live-status-badge${e.metadata?.live === "directive" ? " directive" : ""}`}>{liveBadge}</em>}
          <time>{new Date(e.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
          <CopyButton text={copied} className="message-copy" ariaLabel={t("msg.copy", { agent: names[e.agent] || e.agent })} />
        </div>
        <div className={`message-text ${e.type === "error" ? "error-banner" : e.type === "warning" ? "warning-banner" : ""}`} role={e.type === "error" || e.type === "warning" ? "alert" : undefined}>{isUser ? <UserMessageBody text={text} /> : <MessageFold text={text} streaming={streamingMessageId === e.id}><Markdown text={text} /></MessageFold>}</div>
        {!isUser && e.id === latestAssistantId && active.permissionMode === "plan" && active.status !== "running" && onExecutePlan && e.type === "message" &&
          <button type="button" className="button primary execute-plan" disabled={busy} title={t("msg.executePlanTitle")} onClick={onExecutePlan}>{t("msg.executePlan")}</button>}
        {canPromoteLive(e) && <button type="button" className="button light live-promote" onClick={() => onPromote(e.id)}>{t("msg.promote")}</button>}
        {!isUser && e.id === latestAssistantId && choiceOptions.length > 0 && <div className="message-options" aria-label={t("msg.options")}>
          {choiceOptions.map((option, index) => <button type="button" key={option} onClick={() => onChoose(option)}><span>{index + 1}</span>{option}</button>)}
        </div>}
      </article>;
    })(), <ComputerTrail key={`cu-${e.id}`} sessionId={active.id} from={e.time} to={events[index + 1]?.time} />])}
    <WorktreePanel session={active} />
    {active.status === "running" && (
      <div className="thinking" role="status">
        <Beat /> {t(runPhase(active) === "verify" ? "msg.leadVerifying" : "msg.teamWorking")} <QuietIndicator session={active} />
      </div>
    )}
    <div ref={bottomRef} />
  </div>;
}
