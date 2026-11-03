import type { RefObject } from "react";
import { runPhase } from "../run-activity";
import { ArrowRight, CalendarClock, UserCheck } from "lucide-react";
import { isReportPrompt, leadMessage } from "../lead";
import { Beat } from "../Beat";
import { AgentMark } from "../AgentMark";
import { CopyButton } from "../CopyButton";
import { Markdown } from "../Markdown";
import { MessageFold, UserMessageBody } from "../media-ui";
import { canPromoteLive, canUndoAutoHandoff, conversationText, liveBadgeLabel, type DelegationTask } from "../conversation";
import { parseAttachmentMessage } from "../viewer-model";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session, SessionDraft, SessionEvent } from "../../server/types";
import { useSmoothText } from "../smooth-text";
import { cleanBriefTitle } from "../worker-log";
import { t } from "../i18n";
import { ComputerTrail } from "../ComputerUse";
import { QuietIndicator } from "./QuietIndicator";
import { WorktreePanel } from "./WorktreePanel";
import { GoalPanel } from "./GoalPanel";

export type MessageListProps = {
  active: Session;
  /** Other sessions by id (a commander's goal sessions). */
  lookupSession: (id: string) => Session | undefined;
  onOpenSession?: (id: string) => void;
  /** Stops the chat's run and the work it runs by itself (its goal chats too). */
  onStop?: () => void;
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
  /** The lead's message still being written, shown live below the last event. */
  draft?: SessionDraft;
};

/** A message that is still arriving: revealed smoothly with a caret, replaced by the stored message when done. */
function DraftMessage({ draft, continued }: { draft: SessionDraft; continued: boolean }) {
  const text = useSmoothText(draft.text);
  return <article className={`message assistant-message streaming-message${continued ? " continued" : ""}`} aria-busy="true">
    {!continued && <div className="message-author"><AgentMark agent={draft.agent} /><strong>{names[draft.agent] || draft.agent}</strong></div>}
    <div className="message-text"><Markdown text={text} /></div>
  </article>;
}

/** An assistant message right after another one from the same agent reads as one reply: no second header. */
function continuesPrevious(events: SessionEvent[], index: number): boolean {
  const current = events[index], previous = events[index - 1];
  if (!current || !previous || current.agent === "user" || previous.agent !== current.agent) return false;
  const plain = (event: SessionEvent) => event.type !== "delegation" && event.type !== "handoff" && !event.metadata?.live;
  return plain(current) && plain(previous);
}

const delegationBrief = (text: string) => text.replace(/^.*?에게 위임:\s*/, "");

/** The brief is often a long Markdown document: a clean one-line title, the whole brief on request. */
function DelegationBrief({ text }: { text: string }) {
  const title = cleanBriefTitle(text);
  if (title === text.trim()) return <h3>{title}</h3>;
  return <details className="delegation-brief">
    <summary><h3>{title}</h3><span className="delegation-brief-toggle">{t("worker.showBrief")}</span></summary>
    <div className="delegation-brief-body"><Markdown text={text} /></div>
  </details>;
}

function DelegationCard({ e, task, active, onOpenWorker }: { e: SessionEvent; task: DelegationTask; active: Session; onOpenWorker: (workerId: string) => void }) {
  const config = task.event.role ? task.event : active.workerConfigs?.find((item) => item.agent === task.event.agent);
  if (e.metadata?.deletedWorker) return <article className="delegation-card deleted-worker" aria-label={t("deleg.deletedLabel")}>
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>{t("deleg.deletedHeading")}</span><strong>{task.event.workerLabel ?? names[task.event.agent]} <em>{t("deleg.deletedWorker")}</em></strong></div><span className="status-label stopped">{t("deleg.deleted")}</span></div>
    <h3>{cleanBriefTitle(delegationBrief(e.text))}</h3>
    <div className="delegation-bottom"><p>{t("deleg.logDeleted")}</p></div>
  </article>;
  const workerId = task.event.workerId ?? task.event.agent;
  return <article className="delegation-card" aria-label={t("deleg.label")}>
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>{t("deleg.label")}</span><strong>{task.event.workerLabel ?? names[task.event.agent]} · {config?.model || t("usage.cliDefaultModel")} · {config?.reasoningEffort || t("team.defaultReasoning")}</strong></div><span className={`status-label ${task.status}`}>{task.status === "running" && <Beat />}{statusLabels[task.status]}</span><Elapsed start={task.startedAt} end={task.endedAt} /></div>
    <DelegationBrief text={delegationBrief(e.text)} />
    <div className="delegation-bottom"><p title={task.activity}>{task.activity}</p><button className="button light" aria-controls={`sidebar-worker-${active.id}-${workerId}`} onClick={() => onOpenWorker(workerId)}>{t("deleg.view")}<ArrowRight size={13} /></button></div>
  </article>;
}

/** The main conversation of the active session: messages, handoffs and delegation cards. */
export function MessageList({ active, events, tasksById, latestHandoffId, latestAssistantId, choiceOptions, streamingMessageId, busy, bottomRef, onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan, draft, lookupSession, onOpenSession, onStop }: MessageListProps) {
  const last = events.at(-1);
  const draftContinues = Boolean(draft && last && last.agent === draft.agent && last.type !== "delegation" && last.type !== "handoff" && !last.metadata?.live);
  return <div className="messages">
    <GoalPanel session={active} lookup={lookupSession} onOpenSession={onOpenSession} onStop={onStop} />
    {events.flatMap((e, index) => [(() => {
      if (e.type === "handoff") return <div className="handoff-divider" key={e.id}>
        <span className="agent-label"><AgentMark agent={e.agent} size="small" />{e.text}</span>
        {e.metadata?.auto && !e.metadata.quotaFallback && e.id === latestHandoffId && <button className="handoff-undo" disabled={busy || !canUndoAutoHandoff(e, active.status, latestHandoffId)} onClick={() => onUndoHandoff(e.id)}>{e.metadata.undone ? t("msg.undone") : t("msg.undo")}</button>}
      </div>;
      if (e.type === "delegation") return <DelegationCard key={e.id} e={e} task={tasksById.get(e.id)!} active={active} onOpenWorker={onOpenWorker} />;
      const isUser = e.agent === "user";
      // What the app put in a project lead's chat for it: another lead's message, or its daily report.
      if (isUser && isReportPrompt(e.text)) return <div className="handoff-divider steward-divider" key={e.id}><span className="agent-label"><CalendarClock size={13} aria-hidden="true" />{t("steward.reportTurn")}</span></div>;
      const lead = isUser ? leadMessage(e.text) : undefined;
      if (lead) return <article className="message assistant-message lead-message" key={e.id}>
        <div className="message-author"><UserCheck size={15} aria-hidden="true" /><strong>{t(lead.kind === "ask" ? "steward.askFrom" : "steward.replyFrom", { name: lead.from })}</strong>
          <time dateTime={e.time} title={new Date(e.time).toLocaleString("ko-KR")}>{new Date(e.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></div>
        <div className="message-text"><MessageFold text={lead.body} streaming={false}><Markdown text={lead.body} /></MessageFold></div>
      </article>;
      const text = isUser ? e.text : conversationText(e.text);
      const copied = isUser ? (parseAttachmentMessage(text).body || text) : text;
      const liveBadge = liveBadgeLabel(e);
      const continued = continuesPrevious(events, index);
      const time = <time dateTime={e.time} title={new Date(e.time).toLocaleString("ko-KR")}>{new Date(e.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>;
      const copy = <CopyButton text={copied} className="message-copy" ariaLabel={t("msg.copy", { agent: names[e.agent] || e.agent })} />;
      return <article className={`message ${isUser ? "user-message" : "assistant-message"}${continued ? " continued" : ""}${streamingMessageId === e.id && !draft ? " streaming-message" : ""}`} key={e.id}>
        {/* The user's own messages are a plain bubble (like Claude / ChatGPT); time and copy appear on hover. */}
        {!isUser && !continued && <div className="message-author">
          <AgentMark agent={e.agent} />
          <strong>{names[e.agent] || e.agent}</strong>
          {liveBadge && <em className={`live-status-badge${e.metadata?.live === "directive" ? " directive" : ""}`}>{liveBadge}</em>}
          {time}
          {copy}
        </div>}
        {isUser && liveBadge && <em className={`live-status-badge${e.metadata?.live === "directive" ? " directive" : ""}`}>{liveBadge}</em>}
        <div className={`message-text ${e.type === "error" ? "error-banner" : e.type === "warning" ? "warning-banner" : ""}`} role={e.type === "error" || e.type === "warning" ? "alert" : undefined}>{isUser ? <UserMessageBody text={text} /> : <MessageFold text={text} streaming={streamingMessageId === e.id}><Markdown text={text} /></MessageFold>}</div>
        {(isUser || continued) && <div className="message-actions">{time}{copy}</div>}
        {!isUser && e.id === latestAssistantId && active.permissionMode === "plan" && active.status !== "running" && onExecutePlan && e.type === "message" &&
          <button type="button" className="button primary execute-plan" disabled={busy} title={t("msg.executePlanTitle")} onClick={onExecutePlan}>{t("msg.executePlan")}</button>}
        {canPromoteLive(e) && <button type="button" className="button light live-promote" onClick={() => onPromote(e.id)}>{t("msg.promote")}</button>}
        {!isUser && e.id === latestAssistantId && choiceOptions.length > 0 && <div className="message-options" aria-label={t("msg.options")}>
          {choiceOptions.map((option, index) => <button type="button" key={option} onClick={() => onChoose(option)}><span>{index + 1}</span>{option}</button>)}
        </div>}
      </article>;
    })(), <ComputerTrail key={`cu-${e.id}`} sessionId={active.id} from={e.time} to={events[index + 1]?.time} />])}
    {draft?.text && <DraftMessage draft={draft} continued={draftContinues} />}
    <WorktreePanel session={active} />
    {active.status === "running" && (
      <div className="thinking" role="status">
        <Beat /> {t(runPhase(active) === "verify" ? "msg.leadVerifying" : "msg.teamWorking")} <QuietIndicator session={active} />
      </div>
    )}
    <div ref={bottomRef} />
  </div>;
}
