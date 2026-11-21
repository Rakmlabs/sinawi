// show_session (an outside AI asks to show the user a chat): the user's screen is theirs. The chat
// opens only when the user is on an empty new-chat screen and has not touched the app for a while;
// otherwise a notification with an "open" button says who asked (review M3).
export type ShowSessionView = {
  /** The chat asked for. */
  requested: string;
  /** What the user looks at now. */
  tab: string;
  selected?: string;
  /** Unsent text in the composer, or a new lead being set up. */
  prompt: string;
  drafting: boolean;
  lastInputAt: number;
  now?: number;
};

export const SHOW_SESSION_IDLE_MS = 30_000;

export function showSessionAction(view: ShowSessionView): "open" | "notify" | "already" {
  if (view.tab === "workspace" && view.selected === view.requested) return "already";
  const idle = (view.now ?? Date.now()) - view.lastInputAt >= SHOW_SESSION_IDLE_MS;
  const empty = view.tab === "workspace" && !view.selected && !view.drafting && !view.prompt.trim();
  return empty && idle ? "open" : "notify";
}
