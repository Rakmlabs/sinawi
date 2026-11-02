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

export interface CurrentActivity {
  /** "lead" for the orchestrator, otherwise the worker's label. */
  who: string;
  /** "deploy" while a CI run is being watched, otherwise "tool". */
  kind: "deploy" | "tool";
  /** The tool line as logged ("명령: …", "파일 읽기: …"), clipped. */
  text: string;
  /** When that tool started. */
  since: string;
}

const RESULT_LINE = /^(도구 결과|결과)(:|$)/u;
const GENERIC_LINE = /^도구 실행$/u;
const CI_WATCH = /\bgh\s+run\s+watch\b|\bgh\s+run\s+view\b[^|;&]*--watch\b|\bgh\s+pr\s+checks\b[^|;&]*--watch\b/u;

/** The tool a running session is in right now, so a long wait reads as a wait and not as a hang. */
export function currentActivity(session: Pick<Session, "status" | "events">): CurrentActivity | undefined {
  if (session.status !== "running") return;
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index];
    if (event.type !== "tool" && event.type !== "command") return;
    const text = event.text.trim();
    // Claude prints a bare "도구 실행" every 30s while a Bash call blocks: skip it to find the call itself.
    if (GENERIC_LINE.test(text)) continue;
    if (RESULT_LINE.test(text)) return;
    const who = event.role === "worker" ? event.workerLabel ?? event.agent : "lead";
    const clipped = text.length > 90 ? `${text.slice(0, 89)}…` : text;
    return { who, kind: CI_WATCH.test(text) ? "deploy" : "tool", text: clipped, since: event.time };
  }
}

/**
 * When the current run started: the user message that began it. Messages typed during the run are
 * answered or queued at once (the next event carries `metadata.live`), so they do not restart the clock.
 */
export function runStartedAt(session: Pick<Session, "status" | "events" | "createdAt">): string | undefined {
  if (session.status !== "running") return undefined;
  const { events } = session;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].agent !== "user") continue;
    if (events[index + 1]?.metadata?.live) continue;
    return events[index].time;
  }
  return session.createdAt;
}
