import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../server/types";
import { goalProgress } from "./goal-progress";

const base = { id: "s", title: "t", agent: "codex", workers: [], cwd: "/", status: "done", createdAt: "", events: [] } as unknown as Session;

test("the sidebar shows progress only while the chat runs its work by itself", () => {
  assert.equal(goalProgress(base), undefined);
  const goal = { items: [{ text: "a", status: "done" as const }, { text: "b", status: "open" as const }], startedAt: "", autoTurns: 0, idleTurns: 0 };
  assert.deepEqual(goalProgress({ ...base, goal }), { done: 1, total: 2 });
  assert.equal(goalProgress({ ...base, goal: { ...goal, stopped: "멈춤" } }), undefined, "an ended loop shows no badge");
  const goals = [{ key: "g1", title: "a", brief: "", after: [], state: "merged" as const, createdAt: "" }, { key: "g2", title: "b", brief: "", after: [], state: "running" as const, createdAt: "" }];
  assert.deepEqual(goalProgress({ ...base, commander: { goals } }), { done: 1, total: 2 });
  assert.equal(goalProgress({ ...base, commander: { goals: goals.map((item) => ({ ...item, state: "merged" as const })) } }), undefined);
});
