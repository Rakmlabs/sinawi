import { mergeSession } from "../conversation";
import type { Session } from "../../server/types";

/** WS `session` frame: replace (or, when incremental, merge events into) one session; newest first. */
export function upsertPushedSession(old: Session[], incoming: Session, incremental: boolean): Session[] {
  const previous = incremental ? old.find((s) => s.id === incoming.id) : undefined;
  const next = previous ? mergeSession(previous, incoming) : incoming;
  return [next, ...old.filter((s) => s.id !== incoming.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** A session returned by a REST call: merge into the list, keeping position. */
export function adoptSession(old: Session[], updated: Session): Session[] {
  const index = old.findIndex((item) => item.id === updated.id);
  if (index < 0) return [updated, ...old];
  const next = old.slice();
  next[index] = mergeSession(old[index], updated);
  return next;
}

export function replaceSession(old: Session[], updated: Session): Session[] {
  return old.map((session) => session.id === updated.id ? updated : session);
}
