import { isStaleSnapshot, mergeSession } from "../conversation";
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
  next[index] = mergeSession(old[index], updated, { snapshot: true });
  return next;
}

/**
 * The REST `/sessions` list, applied over the current one: a session the WebSocket already moved
 * past keeps its newer copy instead of rolling back to the older snapshot.
 */
export function applySessionList(old: Session[], fresh: Session[]): Session[] {
  const byId = new Map(old.map((session) => [session.id, session]));
  return fresh.map((session) => {
    const current = byId.get(session.id);
    return current && isStaleSnapshot(current, session) ? current : session;
  });
}

export function replaceSession(old: Session[], updated: Session): Session[] {
  return old.map((session) => session.id === updated.id ? updated : session);
}
