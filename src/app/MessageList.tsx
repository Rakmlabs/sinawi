import { memo, useMemo, type RefObject } from "react";
import { currentActivity, runPhase } from "../run-activity";
import { ArrowRight, CalendarClock, LogIn, Plug, SquareTerminal, UserCheck, WandSparkles } from "lucide-react";
import { openTerminal } from "../terminal-events";
import { originLabel } from "../origin";
import "../lead-tabs.css";
import { isReportPrompt, leadMessage, schedulePrompt, scheduleWhen } from "../lead";
import { Beat } from "../Beat";
import { AgentMark } from "../AgentMark";
import { CopyButton } from "../CopyButton";
import { Markdown } from "../Markdown";
import { MessageFold, UserMessageBody } from "../media-ui";
import { canPromoteLive, conversationText, liveBadgeLabel, streamingText, type DelegationTask } from "../conversation";
import { messageRowProps, type MessageRowProps, type RowHandlers } from "./message-rows";
import { parseAttachmentMessage } from "../viewer-model";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session, SessionEvent } from "../../server/types";
import { useDraft, useDraftAgent } from "./draft-store";
import { useSmoothText } from "../smooth-text";
import { cleanBriefTitle } from "../worker-log";
import { dateLocale, t, useT, type MessageKey } from "../i18n";
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
  /** Key of the lead's message still being written (draft-store), shown live below the last event. */
  draftKey?: string;
};

/** A message that is still arriving: revealed smoothly with a caret, replaced by the stored message when done. */
function DraftMessage({ draftKey, continued }: { draftKey: string; continued: boolean }) {
  // Only this component subscribes to the draft text, so a ~50ms draft frame re-renders just it.
  const draft = useDraft(draftKey);
  const text = streamingText(useSmoothText(draft?.text ?? ""));
  if (!draft?.text) return null;
  return <article className={`message assistant-message streaming-message${continued ? " continued" : ""}`} aria-busy="true">
    {!continued && <div className="message-author"><AgentMark agent={draft.agent} /><strong>{names[draft.agent] || draft.agent}</strong></div>}
    <div className="message-text"><Markdown text={text} /></div>
  </article>;
}

const delegationBrief = (text: string) => text.replace(/^.*?에게 위임:\s*/, "");

function DelegationCard({ e, task, sessionId, workerConfigs, onOpenWorker }: { e: SessionEvent; task: DelegationTask; sessionId: string; workerConfigs: Session["workerConfigs"]; onOpenWorker: (workerId: string) => void }) {
  const config = task.event.role ? task.event : workerConfigs?.find((item) => item.agent === task.event.agent);
  if (e.metadata?.deletedWorker) return <article className="delegation-card deleted-worker" aria-label={t("deleg.deletedLabel")}>
    <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>{t("deleg.deletedHeading")}</span><strong>{task.event.workerLabel ?? names[task.event.agent]} <em>{t("deleg.deletedWorker")}</em></strong></div><span className="status-label stopped">{t("deleg.deleted")}</span></div>
    <h3>{cleanBriefTitle(delegationBrief(e.text))}</h3>
    <div className="delegation-bottom"><p>{t("deleg.logDeleted")}</p></div>
  </article>;
  const workerId = task.event.workerId ?? task.event.agent;
  const brief = delegationBrief(e.text);
  const title = cleanBriefTitle(brief);
  return <article className="delegation-card" aria-label={t("deleg.label")}>
    <div className="delegation-summary">
      <details className="delegation-details">
        <summary>
          <AgentMark agent={task.event.agent} />
          <strong title={title}>{title}</strong>
          <span className={`status-label ${task.status}`}>{task.status === "running" && <Beat />}{statusLabels[task.status]}</span>
          <Elapsed start={task.startedAt} end={task.endedAt} />
        </summary>
        <p>{task.event.workerLabel ?? names[task.event.agent]} · {config?.model || t("usage.cliDefaultModel")} · {config?.reasoningEffort || t("team.defaultReasoning")}</p>
        {task.activity && <p>{task.activity}</p>}
        {title !== brief.trim() && <div className="delegation-brief-body"><Markdown text={brief} /></div>}
      </details>
      <button className="button light" aria-controls={`sidebar-worker-${sessionId}-${workerId}`} onClick={() => onOpenWorker(workerId)}>{t("deleg.view")}<ArrowRight size={13} /></button>
    </div>
  </article>;
}

/** A schedule the lead (or the user) made, changed or that ran: one line with when it runs next. */
function ScheduleCardView({ e }: { e: SessionEvent }) {
  const card = e.metadata!.schedule!;
  const locale = dateLocale();
  const next = card.nextRunAt && card.enabled !== false && card.action !== "deleted" ? t("steward.scheduleNext", { time: new Date(card.nextRunAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) }) : "";
  return <article className={`schedule-card ${card.action}`} aria-label={t(`steward.scheduleCard.${card.action}` as MessageKey)}>
    <CalendarClock size={14} aria-hidden="true" />
    <div>
      <span>{t(`steward.scheduleCard.${card.action}` as MessageKey)} · {t(`steward.scheduleCard.${card.by}` as MessageKey)}</span>
      <strong>{card.title}</strong>
      <small>{[scheduleWhen(card, locale), next, card.enabled === false && card.action !== "deleted" ? t("steward.scheduleOff") : ""].filter(Boolean).join(" · ")}</small>
    </div>
    <time dateTime={e.time}>{new Date(e.time).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
  </article>;
}

/** One conversation event and the computer actions that followed it. Memoized: see `MessageRowProps`. */
/** A CLI that is not signed in (first-run #4): what happened, the CLI's own words, and the way out. */
function LoginNeeded({ login, text }: { login: NonNullable<NonNullable<SessionEvent["metadata"]>["loginNeeded"]>; text: string }) {
  useT();
  return <div className="message-text error-banner login-needed" role="alert">
    <div className="login-needed-body">
      <strong><LogIn size={14} aria-hidden="true" />{t("msg.loginNeeded", { name: names[login.agent] ?? login.agent })}</strong>
      <span>{t("msg.loginNeededHint")}</span>
      <code>{text}</code>
    </div>
    <button type="button" className="button primary" onClick={() => openTerminal({ command: login.command })} title={login.command}>
      <SquareTerminal size={14} aria-hidden="true" />{t("msg.loginInTerminal")}
    </button>
  </div>;
}

const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  useT();
  const { e, sessionId, nextTime } = props;
  return <>
    <MessageRowBody {...props} />
    <ComputerTrail sessionId={sessionId} from={e.time} to={nextTime} />
  </>;
});

function MessageRowBody({ e, sessionId, continued, task, workerConfigs, undoable, isLatestHandoff, isLatestAssistant, showExecutePlan, choiceOptions, streaming, drafting, busy, handlers }: MessageRowProps) {
  const { onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan } = handlers;
      if (e.type === "handoff") return <div className="handoff-divider">
        <span className="agent-label"><AgentMark agent={e.agent} size="small" />{e.text}</span>
        {e.metadata?.auto && !e.metadata.quotaFallback && isLatestHandoff && <button className="handoff-undo" disabled={busy || !undoable} onClick={() => onUndoHandoff(e.id)}>{e.metadata.undone ? t("msg.undone") : t("msg.undo")}</button>}
      </div>;
      if (e.type === "delegation") return <DelegationCard e={e} task={task!} sessionId={sessionId} workerConfigs={workerConfigs} onOpenWorker={onOpenWorker} />;
      if (e.type === "status" && e.metadata?.schedule) return <ScheduleCardView e={e} />;
      if (e.type === "status" && e.metadata?.leadSkill) return <div className="handoff-divider steward-divider"><span className="agent-label"><WandSparkles size={13} aria-hidden="true" />{t(`steward.skillCard.${e.metadata.leadSkill.action}` as MessageKey, { name: e.metadata.leadSkill.name })}</span></div>;
      const isUser = e.agent === "user";
      // A schedule's prompt arriving: the card above says why; the text folds under a divider.
      const scheduled = isUser ? schedulePrompt(e.text) : undefined;
      if (scheduled) return <details className="handoff-divider steward-divider schedule-turn">
        <summary className="agent-label"><CalendarClock size={13} aria-hidden="true" />{t("steward.scheduleTurn", { title: scheduled.title })}</summary>
        <div className="message-text"><Markdown text={scheduled.body} /></div>
      </details>;
      // What the app put in a project lead's chat for it: another lead's message, or its daily report.
      if (isUser && isReportPrompt(e.text)) return <div className="handoff-divider steward-divider"><span className="agent-label"><CalendarClock size={13} aria-hidden="true" />{t("steward.reportTurn")}</span></div>;
      const lead = isUser ? leadMessage(e.text) : undefined;
      if (lead) return <article className="message assistant-message lead-message">
        <div className="message-author"><UserCheck size={15} aria-hidden="true" /><strong>{t(lead.kind === "ask" ? "steward.askFrom" : "steward.replyFrom", { name: lead.from })}</strong>
          <time dateTime={e.time} title={new Date(e.time).toLocaleString(dateLocale())}>{new Date(e.time).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}</time></div>
        <div className="message-text"><MessageFold text={lead.body} streaming={false}><Markdown text={lead.body} /></MessageFold></div>
      </article>;
      // The reply still arriving may end in a half-written control block; stored replies never do.
      const text = isUser ? e.text : streaming ? streamingText(e.text) : conversationText(e.text);
      const copied = isUser ? (parseAttachmentMessage(text).body || text) : text;
      const liveBadge = liveBadgeLabel(e);
      const time = <time dateTime={e.time} title={new Date(e.time).toLocaleString(dateLocale())}>{new Date(e.time).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}</time>;
      const copy = <CopyButton text={copied} className="message-copy" ariaLabel={t("msg.copy", { agent: names[e.agent] || e.agent })} />;
      return <article className={`message ${isUser ? "user-message" : "assistant-message"}${continued ? " continued" : ""}${streaming && !drafting ? " streaming-message" : ""}`}>
        {/* The user's own messages are a plain bubble (like Claude / ChatGPT); time and copy appear on hover. */}
        {!isUser && !continued && <div className="message-author">
          <AgentMark agent={e.agent} />
          <strong>{names[e.agent] || e.agent}</strong>
          {liveBadge && <em className={`live-status-badge${e.metadata?.live === "directive" ? " directive" : ""}`}>{liveBadge}</em>}
          {time}
          {copy}
        </div>}
        {isUser && e.metadata?.via && <span className={`message-origin ${e.metadata.via.kind}`} title={e.metadata.via.client}>
          {e.metadata.via.kind === "lead" ? <UserCheck size={12} aria-hidden="true" /> : <Plug size={12} aria-hidden="true" />}
          {e.metadata.via.kind === "lead" ? t("origin.sentByLead", { name: originLabel(e.metadata.via) }) : originLabel(e.metadata.via) === "MCP" ? t("origin.sentByUnknown") : t("origin.sentBy", { name: originLabel(e.metadata.via) })}
        </span>}
        {isUser && liveBadge && <em className={`live-status-badge${e.metadata?.live === "directive" ? " directive" : ""}`}>{liveBadge}</em>}
        {e.type === "error" && e.metadata?.loginNeeded ? <LoginNeeded login={e.metadata.loginNeeded} text={text} /> :
        <div className={`message-text ${e.type === "error" ? "error-banner" : e.type === "warning" ? "warning-banner" : ""}`} role={e.type === "error" || e.type === "warning" ? "alert" : undefined}>{isUser ? <UserMessageBody text={text} /> : <MessageFold text={text} streaming={streaming} keepOpen={isLatestAssistant}><Markdown text={text} /></MessageFold>}</div>}
        {(isUser || continued) && <div className="message-actions">{time}{copy}</div>}
        {showExecutePlan &&
          <button type="button" className="button primary execute-plan" disabled={busy} title={t("msg.executePlanTitle")} onClick={onExecutePlan}>{t("msg.executePlan")}</button>}
        {canPromoteLive(e) && <button type="button" className="button light live-promote" onClick={() => onPromote(e.id)}>{t("msg.promote")}</button>}
        {choiceOptions.length > 0 && <div className="message-options" aria-label={t("msg.options")}>
          {choiceOptions.map((option, index) => <button type="button" key={option} onClick={() => onChoose(option)}><span>{index + 1}</span>{option}</button>)}
        </div>}
      </article>;
}

/**
 * The main conversation of the active session: messages, handoffs and delegation cards. Memoized
 * with memoized rows: a composer keystroke skips it, and a new event re-renders only the rows whose
 * props changed (the new row, its neighbour, and the latest-reply markers), not the whole history.
 */
export const MessageList = memo(function MessageList({ active, events, tasksById, latestHandoffId, latestAssistantId, choiceOptions, streamingMessageId, busy, bottomRef, onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan, draftKey, lookupSession, onOpenSession, onStop }: MessageListProps) {
  useT();
  const last = events.at(-1);
  const activity = currentActivity(active);
  // Only who is writing (changes when a draft starts or ends), not the text: keeps this list still per frame.
  const draftAgent = useDraftAgent(draftKey);
  const draft = draftAgent ? { agent: draftAgent } : undefined;
  const draftContinues = Boolean(draft && last && last.agent === draft.agent && last.type !== "delegation" && last.type !== "handoff" && !last.metadata?.live);
  const handlers = useMemo<RowHandlers>(() => ({ onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan: () => onExecutePlan?.() }), [onUndoHandoff, onOpenWorker, onPromote, onChoose, onExecutePlan]);
  const shared = { active, events, tasksById, latestHandoffId, latestAssistantId, choiceOptions, streamingMessageId, busy, drafting: Boolean(draft), canExecutePlan: Boolean(onExecutePlan), handlers };
  return <div className="messages">
    <GoalPanel session={active} lookup={lookupSession} onOpenSession={onOpenSession} onStop={onStop} />
    {events.map((e, index) => <MessageRow key={e.id} {...messageRowProps({ ...shared, index })} />)}
    {draftKey && draft && <DraftMessage draftKey={draftKey} continued={draftContinues} />}
    <WorktreePanel session={active} />
    {active.status === "running" && (
      <div className="thinking" role="status">
        <Beat /> {activity ? `${activity.who === "lead" ? t("run.lead") : activity.who} · ${activity.text}` : t(runPhase(active) === "verify" ? "msg.leadVerifying" : "msg.teamWorking")} <QuietIndicator session={active} activityElapsedOnly={Boolean(activity)} />
      </div>
    )}
    <div ref={bottomRef} />
  </div>;
});
