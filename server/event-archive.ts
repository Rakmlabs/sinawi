// A long chat keeps its newest `maxEvents` events in sessions/<id>.json; what trimming takes out is
// appended here (sessions/archive/<id>.jsonl) instead of vanishing (audit/review M5). Readers that
// page back (`before`) or resume from an id that was trimmed (`after`) read it.
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultDataDir } from "./runtime.js";
import type { SessionEvent } from "./types.js";

/** Past this the oldest half goes: the archive is history, not an unbounded log. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

const archiveFile = (directory: string, id: string) => resolve(directory, "sessions", "archive", `${encodeURIComponent(id)}.jsonl`);
// Appends to one chat's archive run one after another (a trim never interleaves with another).
const queues = new Map<string, Promise<void>>();

function queued(file: string, work: () => Promise<void>): Promise<void> {
  const next = (queues.get(file) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return next;
}

export function archiveEvents(sessionId: string, events: SessionEvent[], directory = defaultDataDir): Promise<void> {
  if (!events.length) return Promise.resolve();
  const file = archiveFile(directory, sessionId);
  return queued(file, async () => {
    await mkdir(resolve(file, ".."), { recursive: true });
    await appendFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
    if ((await stat(file)).size > MAX_ARCHIVE_BYTES) {
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      await writeFile(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
    }
  });
}

export async function readArchivedEvents(sessionId: string, directory = defaultDataDir): Promise<SessionEvent[]> {
  const file = archiveFile(directory, sessionId);
  await queues.get(file);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const event = JSON.parse(line) as SessionEvent; if (event?.id && event.time) events.push(event); } catch { /* a torn last line */ }
  }
  return events;
}

export function removeArchivedEvents(sessionId: string, directory = defaultDataDir): Promise<void> {
  const file = archiveFile(directory, sessionId);
  return queued(file, () => rm(file, { force: true }));
}

/**
 * Events after `afterId` for a reader resuming where it left off. The id may have been trimmed into the
 * archive since: then everything newer than it (archived and kept) comes back, in time order, instead
 * of the whole chat again. `found: false` = the id is unknown; the reader gets everything kept.
 */
export async function eventsSince(session: { id: string; events: SessionEvent[]; archivedEvents?: number }, afterId: string | undefined, directory?: string): Promise<{ events: SessionEvent[]; found: boolean }> {
  if (!afterId) return { events: session.events, found: true };
  const index = session.events.findIndex((event) => event.id === afterId);
  if (index >= 0) return { events: session.events.slice(index + 1), found: true };
  if (!session.archivedEvents) return { events: session.events, found: false };
  const archived = await readArchivedEvents(session.id, directory);
  const cursor = archived.find((event) => event.id === afterId);
  if (!cursor) return { events: session.events, found: false };
  const after = (event: SessionEvent) => event.time > cursor.time;
  const position = archived.indexOf(cursor);
  return { events: [...archived.slice(position + 1).filter(after), ...session.events.filter(after)].sort((a, b) => a.time.localeCompare(b.time)), found: true };
}

/** Up to `limit` events before `beforeId` (the oldest kept one when unset is not enough), archive included. */
export async function eventsBefore(session: { id: string; events: SessionEvent[]; archivedEvents?: number }, beforeId: string, limit: number, directory?: string): Promise<SessionEvent[]> {
  const all = session.archivedEvents ? [...await readArchivedEvents(session.id, directory), ...session.events].sort((a, b) => a.time.localeCompare(b.time)) : session.events;
  const index = all.findIndex((event) => event.id === beforeId);
  if (index < 0) return [];
  return all.slice(Math.max(0, index - limit), index);
}
