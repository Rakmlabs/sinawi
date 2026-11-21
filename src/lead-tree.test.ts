// The lead's chat list (sidebar tree, tab bar list): running first, then most recent; search reaches
// workers and who opened the chat; closed tabs come back while open or running.
import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../server/types";
import { chatRows, hiddenTabs, saveHiddenTabs, shortAgo, visibleTabs } from "./lead-tree";

const chat = (id: string, status: Session["status"], time: string, extra: Partial<Session> = {}) => ({
  id, title: `채팅 ${id}`, status, agent: "claude", createdAt: time, workspaceId: "default", cwd: "/p", workers: ["claude"],
  events: [{ id: `${id}-d`, type: "delegation", agent: "claude", workerId: "w1", workerLabel: "리뷰어", text: "README 고치기\n자세히", time }],
  ...extra,
}) as unknown as Session;

test("running chats first, then the most recent; search finds workers and outside AIs", () => {
  const rows = chatRows([chat("a", "done", "2026-11-21T10:00:00Z"), chat("b", "running", "2026-11-21T09:00:00Z"), chat("c", "done", "2026-11-21T11:00:00Z", { origin: { kind: "mcp", client: "grok-bot" } } as Partial<Session>)], "", Date.parse("2026-11-21T12:00:00Z"));
  assert.deepEqual(rows.map((row) => row.session.id), ["b", "c", "a"]);
  assert.equal(rows[0].workers[0].task, "README 고치기");
  assert.equal(rows[1].openedBy, "Grok Bot");
  assert.deepEqual(chatRows([chat("a", "done", "2026-11-21T10:00:00Z")], "리뷰어").length, 1);
  assert.deepEqual(chatRows([chat("c", "done", "2026-11-21T10:00:00Z", { origin: { kind: "mcp", client: "grok-bot" } } as Partial<Session>)], "grok").length, 1);
  assert.deepEqual(chatRows([chat("a", "done", "2026-11-21T10:00:00Z")], "없는말").length, 0);
});

test("short times and closed tabs", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(shortAgo("2026-11-21T11:59:40Z", now), "방금");
  assert.equal(shortAgo("2026-11-21T11:57:00Z", now), "3분");
  assert.equal(shortAgo("2026-11-21T09:00:00Z", now), "3시간");
  assert.equal(shortAgo("2026-11-19T12:00:00Z", now), "2일");
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  saveHiddenTabs("lead", new Set(["a", "b"]), storage);
  const hidden = hiddenTabs("lead", storage);
  const threads = [chat("a", "done", "t"), chat("b", "running", "t"), chat("c", "done", "t")];
  assert.deepEqual(visibleTabs(threads, hidden).map((thread) => thread.id), ["b", "c"], "a running chat comes back");
  assert.deepEqual(visibleTabs(threads, hidden, "a").map((thread) => thread.id), ["a", "b", "c"], "so does the open one");
});
