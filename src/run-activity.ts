import type { Session } from "../server/types";

/** A run shows nothing for this long before the chat says it is still thinking. */
export const QUIET_AFTER_MS = 8_000;
/** Heartbeats arrive every few seconds while the CLI prints anything; older means no raw output either. */
export const ALIVE_WITHIN_MS = 20_000;

export interface QuietState {
  /** Seconds since the last visible event. */
  seconds: number;
  /** The CLI still prints something (partial messages, thinking) although nothing new is shown. */
  alive: boolean;
}

/** "Thinking… Ns" for a running session whose last visible event is old; undefined otherwise. */
export function quietState(session: Pick<Session, "status" | "events" | "lastActivityAt">, now: number): QuietState | undefined {
  if (session.status !== "running") return;
  const last = session.events.at(-1)?.time;
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(lastMs) || now - lastMs < QUIET_AFTER_MS) return;
  const activity = session.lastActivityAt ? Date.parse(session.lastActivityAt) : NaN;
  return { seconds: Math.floor((now - lastMs) / 1_000), alive: Number.isFinite(activity) && now - activity < ALIVE_WITHIN_MS };
}

export function formatQuiet(seconds: number): { minutes: number; seconds: number } {
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}
