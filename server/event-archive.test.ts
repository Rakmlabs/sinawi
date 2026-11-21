// Review M5: a long chat's trimmed events go to an archive, and readers resume or page back through it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveEvents, eventsBefore, eventsSince, readArchivedEvents, removeArchivedEvents } from "./event-archive";
import { trimEvents } from "./events";
import type { SessionEvent } from "./types";

const event = (n: number, type: SessionEvent["type"] = "tool"): SessionEvent => ({ id: `e${n}`, sessionId: "s", agent: "claude", type, text: `#${n}`, time: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() });

test("trimmed events are archived, and a reader resumes from a trimmed id or pages back into the archive", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = Array.from({ length: 12 }, (_, n) => event(n, n % 3 === 0 ? "message" : "tool"));
  const dropped: SessionEvent[] = [];
  trimEvents(events, 8, dropped);
  assert.equal(events.length, 8);
  assert.equal(dropped.length, 4);
  await archiveEvents("s", dropped, dir);
  const session = { id: "s", events, archivedEvents: dropped.length };
  assert.deepEqual((await readArchivedEvents("s", dir)).map((item) => item.id), dropped.map((item) => item.id));

  // The reader's last id was a tool line that has since been trimmed: only what came after it returns.
  const cursor = dropped.at(-1)!;
  const since = await eventsSince(session, cursor.id, dir);
  assert.equal(since.found, true);
  assert.ok(since.events.every((item) => item.time > cursor.time), "nothing older comes back");
  assert.ok(since.events.length < 12 && since.events.length > 0);

  const lost = await eventsSince(session, "nope", dir);
  assert.equal(lost.found, false, "an unknown id is said so, not passed off as 'since'");

  const back = await eventsBefore(session, "e6", 50, dir);
  assert.deepEqual(back.map((item) => item.id), ["e0", "e1", "e2", "e3", "e4", "e5"], "paging back reads the archive, in order");

  await removeArchivedEvents("s", dir);
  assert.deepEqual(await readArchivedEvents("s", dir), []);
});
