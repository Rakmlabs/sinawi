// How far a chat that runs its request by itself has got (server/goals.ts). No UI here, so the
// sidebar (and its tests) can use it without the goal panel's styles.
import type { CommanderGoal, GoalItem, Session } from "../server/types";

export const settledItems = (items: readonly GoalItem[]) => items.filter((item) => item.status !== "open").length;
export const activeGoal = (goal: CommanderGoal) => goal.state === "waiting" || goal.state === "running";

/** "3/7" for the sidebar while a chat's goal chats run or its checklist loop has not ended. */
export function goalProgress(session: Session): { done: number; total: number } | undefined {
  const goals = session.commander?.goals ?? [];
  if (goals.some(activeGoal)) return { done: goals.filter((goal) => !activeGoal(goal)).length, total: goals.length };
  if (session.goal?.items.length && !session.goal.stopped) return { done: settledItems(session.goal.items), total: session.goal.items.length };
  return undefined;
}
