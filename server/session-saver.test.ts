import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCoalescedSaver, saveSessions } from "./store.js";
import { createServer } from "./server.js";
import type { Session } from "./types.js";

test("scheduled saves within the delay collapse into one write of the latest value", async () => {
  const writes: number[] = [];
  const saver = createCoalescedSaver((value: number) => { writes.push(value); }, 20);
  for (let value = 1; value <= 500; value += 1) saver.schedule(value);
  assert.deepEqual(writes, []);
  await delay(60);
  assert.deepEqual(writes, [500]);
});

test("flush writes immediately, cancels the pending timer and preserves write order", async () => {
  const writes: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const saver = createCoalescedSaver(async (value: string) => {
    if (value === "first") await blocked;
    writes.push(value);
  }, 1_000);
  const first = saver.flush("first");
  saver.schedule("second");
  const second = saver.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ["first", "second"]);
  await saver.flush();
  assert.deepEqual(writes, ["first", "second"]);
});

test("flush reports a failed write and later saves still run", async () => {
  let fail = true;
  const writes: string[] = [];
  const saver = createCoalescedSaver((value: string) => {
    if (fail) throw new Error("disk full");
    writes.push(value);
  }, 1_000);
  await assert.rejects(saver.flush("lost"), /disk full/);
  fail = false;
  await saver.flush("kept");
  assert.deepEqual(writes, ["kept"]);
});

test("a burst of run events reaches disk in a few coalesced writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-coalesced-"));
  const session: Session = {
    id: "s1", title: "Run", agent: "codex", workers: [], cwd: directory, status: "done",
    createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal",
  };
  await saveSessions([session], directory);
  let writes = 0;
  const { orchestra, websocket, flushSessions } = createServer({
    dataDir: directory, modelHomeDir: directory, availableAgents: [], routingSkillLoader: async () => [],
    modelRunner: async () => { throw new Error("No CLI in fixture"); },
    sessionSaveDelayMs: 30,
    sessionSaver: async (sessions, target) => { writes += 1; await saveSessions(sessions, target); },
  });
  try {
    for (let attempt = 0; !orchestra.get("s1") && attempt < 100; attempt += 1) await delay(10);
    assert.ok(orchestra.get("s1"));
    const before = writes;
    for (let index = 0; index < 300; index += 1) orchestra.rename("s1", `제목 ${index}`);
    await delay(100);
    assert.ok(writes - before <= 2, `expected coalesced writes, got ${writes - before}`);
    await flushSessions();
    const stored = JSON.parse(await readFile(join(directory, "sessions", "s1.json"), "utf8")) as Session;
    assert.equal(stored.title, "제목 299");
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});
