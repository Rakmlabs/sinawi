// The lead's chat list (sidebar tree, tab bar list): running first, then most recent; search reaches
// workers and who opened the chat; closed tabs come back while open or running.
import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../server/types";
import { agoLabel, chatRows, hiddenTabs, reopenRunning, saveHiddenTabs, shortAgo, taskSummary, visibleTabs } from "./lead-tree";
import { t } from "./i18n";

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

test("a worker row says what the task is about, not its heading or folder preamble", () => {
  assert.equal(taskSummary("## 목표\n로그인 버그를 고친다\n## 완료 기준\n테스트 통과"), "로그인 버그를 고친다");
  assert.equal(taskSummary("작업 폴더(/private/tmp/x)에서 일한다.\n\n- **README** 첫 화면을 `고친다`"), "README 첫 화면을 고친다");
  assert.equal(taskSummary("---\n# 제목만\n"), "제목만", "a short heading alone is still better than nothing");
});

test("a finished chat's time reads as a past moment, unlike a running one's elapsed time", () => {
  const now = Date.parse("2026-11-22T10:00:00Z");
  assert.equal(agoLabel("2026-11-22T09:59:50Z", now), t("ago.now"));
  assert.equal(agoLabel("2026-11-22T09:57:00Z", now), t("lcl.ago", { time: t("ago.minutes", { n: 3 }) }));
});

test("a closed tab that runs again stays open after it finishes", () => {
  const hidden = new Set(["a", "b"]);
  const running = [chat("a", "running", "2026-11-22T10:00:00Z"), chat("b", "done", "2026-11-22T10:00:00Z")] as Session[];
  const next = reopenRunning(running, hidden);
  assert.deepEqual([...next], ["b"]);
  assert.equal(reopenRunning([chat("b", "done", "2026-11-22T10:00:00Z")] as Session[], next), next, "nothing changes: the same set");
});
