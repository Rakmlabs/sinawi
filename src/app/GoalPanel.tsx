import { CheckCircle2, Circle, CircleAlert, ExternalLink, GitMerge, ListChecks, Split, Square } from "lucide-react";
import type { CommanderGoalState, GoalItem, Session } from "../../server/types";
import { activeGoal as active, settledItems as settled } from "../goal-progress";
import { t } from "../i18n";
import "../goals.css";

function ItemIcon({ status }: { status: GoalItem["status"] }) {
  if (status === "done") return <CheckCircle2 size={13} className="goal-done" aria-label={t("goal.done")} />;
  if (status === "blocked") return <CircleAlert size={13} className="goal-blocked" aria-label={t("goal.blocked")} />;
  return <Circle size={13} className="goal-open" aria-label={t("goal.open")} />;
}

function Checklist({ items }: { items: readonly GoalItem[] }) {
  return <ul className="goal-items">
    {items.map((item, index) => <li key={`${index}:${item.text}`} className={`goal-item ${item.status}`}>
      <ItemIcon status={item.status} /><span>{item.text}{item.note && <em> — {item.note}</em>}</span>
    </li>)}
  </ul>;
}

function StopButton({ onStop }: { onStop?: () => void }) {
  if (!onStop) return null;
  return <button type="button" className="button light goal-stop" onClick={(event) => { event.preventDefault(); onStop(); }}>
    <Square size={11} aria-hidden="true" />{t("goal.stop")}
  </button>;
}

/** The goal chats a chat split its request into: state, checklist progress, merge result, a link. */
function SplitBoard({ session, lookup, onOpenSession, onStop }: { session: Session; lookup: (id: string) => Session | undefined; onOpenSession?: (id: string) => void; onStop?: () => void }) {
  const goals = session.commander!.goals;
  const running = goals.some(active);
  const merged = goals.filter((goal) => goal.state === "merged" || goal.state === "done").length;
  return <details className={`goal-panel${running ? " running" : ""}`} open={running}>
    <summary>
      <Split size={14} aria-hidden="true" />
      <strong>{running ? t("goal.splitRunning", { total: goals.length }) : t("goal.splitDone", { total: goals.length, merged })}</strong>
      <span>{t("goal.board", { done: goals.filter((goal) => !active(goal)).length, total: goals.length })}</span>
      {running && <StopButton onStop={onStop} />}
    </summary>
    <ul className="goal-board">
      {goals.map((goal) => {
        const child = goal.childId ? lookup(goal.childId) : undefined;
        const items = child?.goal?.items ?? [];
        return <li key={goal.key} className={`goal-card ${goal.state}`}>
          <div className="goal-head">
            <strong>{goal.title}</strong>
            <span className={`goal-state ${goal.state}`}>{t(`goal.state.${goal.state satisfies CommanderGoalState}`)}</span>
            {items.length > 0 && <span className="goal-progress">{settled(items)}/{items.length}</span>}
            {child && onOpenSession && <button type="button" className="button light goal-open-session" onClick={() => onOpenSession(child.id)}><ExternalLink size={12} />{t("goal.openSession")}</button>}
          </div>
          {goal.after.length > 0 && goal.state === "waiting" && <p className="goal-note">{t("goal.after", { keys: goal.after.map((key) => goals.find((item) => item.key === key)?.title ?? key).join(", ") })}</p>}
          {goal.merge && <p className={`goal-note${goal.merge.ok ? "" : " warn"}`}>{goal.state === "merged" && <GitMerge size={12} />}{goal.merge.text.replace(/`/gu, "")}</p>}
          {items.some((item) => item.status === "blocked") && <Checklist items={items.filter((item) => item.status === "blocked")} />}
        </li>;
      })}
    </ul>
  </details>;
}

/** The lead's checklist while the app runs the request to the end, then how it ended. */
function ChecklistPanel({ session, onStop }: { session: Session; onStop?: () => void }) {
  const goal = session.goal!;
  const running = !goal.stopped;
  const blocked = goal.items.filter((item) => item.status === "blocked").length;
  const end = goal.outcome === "complete" ? (blocked ? t("goal.endBlocked", { count: blocked }) : t("goal.endDone")) : goal.stopped;
  return <details className={`goal-panel${running ? " running" : ""}${goal.outcome && goal.outcome !== "complete" ? " ended-warn" : ""}`} open={running || blocked > 0}>
    <summary>
      <ListChecks size={14} aria-hidden="true" />
      <strong>{t("goal.checklist", { done: settled(goal.items), total: goal.items.length })}</strong>
      <span>{running ? t("goal.turns", { count: goal.autoTurns }) : end}</span>
      {running && <StopButton onStop={onStop} />}
    </summary>
    <Checklist items={goal.items} />
  </details>;
}

/**
 * Shown at the top of a chat whose request the app runs by itself: the goal chats it split into
 * and/or the lead's checklist, each with a stop button while it runs and its end once done.
 */
export function GoalPanel({ session, lookup, onOpenSession, onStop }: { session: Session; lookup: (id: string) => Session | undefined; onOpenSession?: (id: string) => void; onStop?: () => void }) {
  const split = Boolean(session.commander?.goals.length);
  const checklist = Boolean(session.goal?.items.length);
  if (!split && !checklist) return null;
  return <div className="goal-panels">
    {split && <SplitBoard session={session} lookup={lookup} onOpenSession={onOpenSession} onStop={onStop} />}
    {checklist && <ChecklistPanel session={session} onStop={onStop} />}
  </div>;
}
