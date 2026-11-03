import { CheckCircle2, Circle, CircleAlert, ExternalLink, Flag, GitMerge } from "lucide-react";
import type { CommanderGoalState, GoalItem, Session } from "../../server/types";
import { t } from "../i18n";
import "../goals.css";

const settled = (items: readonly GoalItem[]) => items.filter((item) => item.status !== "open").length;

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

/**
 * Run-to-completion progress (the lead's checklist) and, for a commander, the goal board: each
 * goal's state, its session's checklist progress and the merge result, with a link to the session.
 */
export function GoalPanel({ session, lookup, onOpenSession }: { session: Session; lookup: (id: string) => Session | undefined; onOpenSession?: (id: string) => void }) {
  if (session.commander) {
    const goals = session.commander.goals;
    if (!goals.length) return null;
    const finished = goals.filter((goal) => goal.state !== "waiting" && goal.state !== "running").length;
    return <details className="goal-panel" open>
      <summary><Flag size={14} />{t("goal.board", { done: finished, total: goals.length })}</summary>
      <ul className="goal-board">
        {goals.map((goal) => {
          const child = goal.childId ? lookup(goal.childId) : undefined;
          const items = child?.goal?.items ?? [];
          return <li key={goal.key} className={`goal-card ${goal.state}`}>
            <div className="goal-head">
              <code>{goal.key}</code>
              <strong>{goal.title}</strong>
              <span className={`goal-state ${goal.state}`}>{t(`goal.state.${goal.state satisfies CommanderGoalState}`)}</span>
              {items.length > 0 && <span className="goal-progress">{settled(items)}/{items.length}</span>}
              {child && onOpenSession && <button type="button" className="button light goal-open-session" onClick={() => onOpenSession(child.id)}><ExternalLink size={12} />{t("goal.openSession")}</button>}
            </div>
            {goal.after.length > 0 && goal.state === "waiting" && <p className="goal-note">{t("goal.after", { keys: goal.after.join(", ") })}</p>}
            {goal.merge && <p className={`goal-note${goal.merge.ok ? "" : " warn"}`}>{goal.state === "merged" && <GitMerge size={12} />}{goal.merge.text.replace(/`/gu, "")}</p>}
            {items.some((item) => item.status === "blocked") && <Checklist items={items.filter((item) => item.status === "blocked")} />}
          </li>;
        })}
      </ul>
    </details>;
  }
  const goal = session.goal;
  if (!goal?.items.length) return null;
  return <details className="goal-panel" open={session.status === "running" || !goal.stopped}>
    <summary><Flag size={14} />{t("goal.checklist", { done: settled(goal.items), total: goal.items.length })}
      <span>{goal.stopped ?? t("goal.turns", { count: goal.autoTurns })}</span></summary>
    <Checklist items={goal.items} />
  </details>;
}
