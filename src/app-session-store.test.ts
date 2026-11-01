import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptSession, upsertPushedSession } from "./app/session-store";
import type { Session, SessionEvent } from "../server/types";

const event = (id: string, text = id): SessionEvent => ({ id, sessionId: "s", type: "message", agent: "codex", text, time: "2026-10-30T00:00:00Z" });
const session = (id: string, createdAt: string, events: SessionEvent[] = []): Session => ({ workspaceId: "personal", id, title: id, agent: "codex", workers: [], cwd: "/tmp", status: "running", createdAt, events });

test("pushed sessions merge incremental events, replace full ones, and stay newest first", () => {
  const old = [session("b", "2026-10-30T00:00:02Z", [event("1"), event("2")]), session("a", "2026-10-30T00:00:01Z")];
  const merged = upsertPushedSession(old, session("b", "2026-10-30T00:00:02Z", [event("2", "edited"), event("3")]), true);
  assert.deepEqual(merged.map((s) => s.id), ["b", "a"]);
  assert.deepEqual(merged[0].events.map((e) => e.text), ["1", "edited", "3"]);
  const replaced = upsertPushedSession(old, session("b", "2026-10-30T00:00:02Z", [event("9")]), false);
  assert.deepEqual(replaced[0].events.map((e) => e.id), ["9"]);
  const added = upsertPushedSession(old, session("c", "2026-10-30T00:00:03Z"), true);
  assert.deepEqual(added.map((s) => s.id), ["c", "b", "a"]);
});

test("adopted sessions keep their list position or go first when new", () => {
  const old = [session("b", "2026-10-30T00:00:02Z", [event("1")]), session("a", "2026-10-30T00:00:01Z")];
  const next = adoptSession(old, session("a", "2026-10-30T00:00:01Z", [event("x")]));
  assert.deepEqual(next.map((s) => s.id), ["b", "a"]);
  assert.deepEqual(next[1].events.map((e) => e.id), ["x"]);
  assert.deepEqual(adoptSession(old, session("z", "2026-10-30T00:00:00Z")).map((s) => s.id), ["z", "b", "a"]);
});
