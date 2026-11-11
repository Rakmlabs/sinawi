import type { SessionEvent } from "./types.js";

export const maxEvents = 2_000;

/**
 * Keeps a session within `max` events. Tool and command lines go first: they are nine in ten events of a long chat,
 * and dropping from the front alone erased what the user asked and what the lead answered.
 */
export function trimEvents<T extends Pick<SessionEvent, "type">>(events: T[], max = maxEvents): T[] {
  let over = events.length - max;
  if (over <= 0) return events;
  // The newest quarter stays whole so the work in progress keeps its tool lines.
  let keepFrom = events.length - Math.floor(max / 4);
  for (let index = 0; over > 0 && index < keepFrom; index++) {
    const type = events[index].type;
    if (type !== "tool" && type !== "command") continue;
    events.splice(index, 1);
    index--;
    keepFrom--;
    over--;
  }
  if (over > 0) events.splice(0, over);
  return events;
}
