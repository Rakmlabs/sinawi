import type { SessionEvent } from "./types.js";

export const maxEvents = 2_000;

/**
 * Keeps a session within `max` events. Tool and command lines go first: they are nine in ten events of a long chat,
 * and dropping from the front alone erased what the user asked and what the lead answered.
 */
/** `dropped` collects what was taken out (to archive it). */
export function trimEvents<T extends Pick<SessionEvent, "type">>(events: T[], max = maxEvents, dropped?: T[]): T[] {
  let over = events.length - max;
  if (over <= 0) return events;
  // The newest quarter stays whole so the work in progress keeps its tool lines.
  let keepFrom = events.length - Math.floor(max / 4);
  for (let index = 0; over > 0 && index < keepFrom; index++) {
    const type = events[index].type;
    if (type !== "tool" && type !== "command") continue;
    const [gone] = events.splice(index, 1);
    dropped?.push(gone);
    index--;
    keepFrom--;
    over--;
  }
  if (over > 0) { const gone = events.splice(0, over); dropped?.push(...gone); }
  return events;
}
