import test from "node:test";
import assert from "node:assert/strict";
import { activitiesBetween, isExecutor, mergeActivity } from "./computer-use";
import type { ComputerActivity } from "../server/computer-bridge";

const entry = (id: string, time: string, sessionId = "s1"): ComputerActivity => ({ id, time, key: `session:${sessionId}`, sessionId, workspaceId: "default", action: "click", summary: id, ok: true });

test("chat trail places actions between the messages they happened after", () => {
  const list = [entry("a", "2026-11-02T00:00:01Z"), entry("b", "2026-11-02T00:00:05Z"), entry("c", "2026-11-02T00:00:09Z"), entry("x", "2026-11-02T00:00:02Z", "s2")];
  assert.deepEqual(activitiesBetween(list, "s1", "2026-11-02T00:00:00Z", "2026-11-02T00:00:05Z").map((a) => a.id), ["a"]);
  assert.deepEqual(activitiesBetween(list, "s1", "2026-11-02T00:00:05Z", undefined).map((a) => a.id), ["b", "c"], "the last message gets everything after it");
  assert.deepEqual(activitiesBetween(list, "s2", undefined, undefined).map((a) => a.id), ["x"]);
});

test("activity merge dedupes by id and keeps time order", () => {
  const merged = mergeActivity([entry("b", "2026-11-02T00:00:05Z")], [entry("a", "2026-11-02T00:00:01Z"), entry("b", "2026-11-02T00:00:05Z")]);
  assert.deepEqual(merged.map((a) => a.id), ["a", "b"]);
});

test("only the main Tauri window executes native commands", () => {
  assert.equal(isExecutor(undefined), false, "a plain browser tab never runs actions");
  assert.equal(isExecutor({ invoke: async () => undefined, metadata: { currentWindow: { label: "main" } } }), true);
  assert.equal(isExecutor({ invoke: async () => undefined, metadata: { currentWindow: { label: "computer-indicator" } } }), false);
});
