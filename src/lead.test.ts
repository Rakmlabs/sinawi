import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Steward } from "../server/types";
import { leadGroups, leadMessage, leadName, leadPreview, schedulePrompt, scheduleWhen, stewardDescription, stewardIdOf } from "./lead";
import { mainConversation } from "./conversation";

const lead = (events: Partial<Session["events"][number]>[], steward: Session["steward"] = { turns: 0, since: "" }) =>
  ({ cwd: "/work/muninnmap", steward, events: events.map((event, index) => ({ id: String(index), time: "", type: "message", agent: "codex", text: "", ...event })) }) as Session;

test("a lead is called by its name, or its project folder", () => {
  assert.equal(leadName(lead([])), "muninnmap");
  assert.equal(leadName(lead([], { turns: 0, since: "", name: "주식" })), "주식");
});

test("another lead's message reads without the app's instructions", () => {
  assert.deepEqual(leadMessage("[담당 「api」의 답]\n질문: 포트?\n\n4000입니다.\n\n[앱] 이 채팅에서 물어본 것에 대한 답입니다."), { from: "api", kind: "reply", body: "질문: 포트?\n\n4000입니다." });
  assert.equal(leadMessage("[담당 「app」이 보낸 질문]\n포트?\n\n[앱] 다른 프로젝트의 담당이 보낸 메시지입니다.")?.kind, "ask");
  assert.equal(leadMessage("그냥 메시지"), undefined);
});

test("the line under a lead is the last thing said, without the app's blocks or reports", () => {
  assert.equal(leadPreview(lead([{ agent: "user", text: "해줘" }, { text: "끝냈습니다.\n<<NOTES>>\n- x\n<</NOTES>>" }])), "끝냈습니다.");
  assert.equal(leadPreview(lead([{ text: "이전 답" }, { agent: "user", text: "[앱 — 정기 보고] 보고하세요" }])), "이전 답");
  assert.equal(leadPreview(lead([{ agent: "user", text: "[담당 「api」의 답]\n4000\n\n[앱] ..." }])), "「api」 4000");
  assert.equal(leadPreview(lead([{ text: "## 정기 보고\n- **바뀐 것:** `main` 그대로" }])), "정기 보고\n바뀐 것: main 그대로");
});

const steward = (id: string, name: string, systemPrompt = "", cwds: string[] = []): Steward =>
  ({ id, name, agent: "claude", skills: [], systemPrompt, workers: [], mergePolicy: "ask", cwds, createdAt: "" });
const chat = (id: string, stewardId: string | undefined, last: string, title = id) =>
  ({ id, title, cwd: "/work/app", createdAt: "2026-01-01", status: "done", steward: { id: stewardId, turns: 0, since: "" }, events: [{ id: `${id}-e`, time: last, type: "message", agent: "user", text: "hi" }] }) as unknown as Session;

test("the lead picker describes a lead by its instructions' first line, else its folder", () => {
  assert.equal(stewardDescription(steward("a", "a", "\n## 백엔드 담당\n둘째 줄")), "백엔드 담당");
  assert.equal(stewardDescription(steward("a", "a", "", ["/work/api"])), "/work/api");
  assert.equal(stewardDescription(steward("a", "a", "x".repeat(100))).length, 80);
});

test("the sidebar lists one row per lead, its latest chat on top and the others under it", () => {
  const groups = leadGroups([
    chat("a1", "A", "2026-02-01"), chat("b1", "B", "2026-05-01"), chat("a2", "A", "2026-06-01"), chat("legacy", undefined, "2026-03-01"),
  ], [steward("A", "앱"), steward("B", "서버"), steward("C", "새 담당", "문서 담당")]);
  assert.deepEqual(groups.map((group) => group.id), ["A", "B", "legacy", "C"], "most recently used first; leads with no chat last");
  assert.equal(groups[0].name, "앱");
  assert.equal(groups[0].latest?.id, "a2");
  assert.deepEqual(groups[0].others.map((session) => session.id), ["a1"], "the lead's other chat sits under it");
  assert.equal(groups[2].name, "app", "a chat saved before leads were entities is its own lead");
  assert.equal(groups[3].latest, undefined);
  assert.equal(stewardIdOf(chat("x", "A", "")), "A");
  assert.equal(stewardIdOf({ id: "y", steward: { turns: 0, since: "" } }), "y");
  assert.equal(stewardIdOf({ id: "z" }), undefined);
});

test("a schedule's prompt is told apart in the lead's chat, and its time reads in words", () => {
  assert.deepEqual(schedulePrompt('[일정 "배포 점검"]\n상태를 봐 줘'), { title: "배포 점검", body: "상태를 봐 줘" });
  assert.equal(schedulePrompt("그냥 메시지"), undefined);
  assert.equal(scheduleWhen({ cron: "0 9 * * 1-5", timezone: "Asia/Seoul" }), "cron 0 9 * * 1-5 (Asia/Seoul)");
  assert.match(scheduleWhen({ at: "2026-11-04T00:00:00.000Z", timezone: "Asia/Seoul" }, "en-US"), /Nov 4, 2026.*9:00/u);
  const chat = lead([
    { id: "u", agent: "user", text: "매일 아침 확인해 줘" },
    { id: "card", type: "status", text: "담당이 일정을 만들었습니다", metadata: { schedule: { id: "s", title: "아침", action: "created", by: "lead" } } },
    { id: "skill", type: "status", text: "스킬", metadata: { leadSkill: { name: "x", scope: "lead", action: "created" } } },
    { id: "plain", type: "status", text: "작업 중" },
    { id: "fired", agent: "user", text: '[일정 "아침"]\n확인해 줘' },
  ]);
  assert.deepEqual(mainConversation(chat).map((event) => event.id), ["u", "card", "skill", "fired"], "schedule and skill cards show; other status lines do not");
  assert.equal(leadPreview(chat), "매일 아침 확인해 줘", "the sidebar line skips the app's schedule prompt");
});
