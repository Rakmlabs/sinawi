import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../server/types";
import { leadMessage, leadName, leadPreview } from "./lead";

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
