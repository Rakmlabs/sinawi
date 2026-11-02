import test from "node:test";
import assert from "node:assert/strict";
import { classifyLiveMessage, instructionSuffix, pushInstruction, statusDigest, statusPrompt, takePending, STATUS_AGENT_MODEL } from "./live-turn.js";
import type { Session, SessionEvent } from "./types.js";

const workers = [
  { id: "claude-1", label: "A", agent: "claude" },
  { id: "claude-2", label: "B", agent: "claude" },
];

test("running messages classify as status, directive, stop, or ambiguous", () => {
  assert.equal(classifyLiveMessage("뭐하고 있어?", workers).intent, "status");
  assert.deepEqual(classifyLiveMessage("B는?", workers), { intent: "status", targetWorkerId: "claude-2" });
  assert.deepEqual(classifyLiveMessage("B한테 A부터 보라고 해", workers), { intent: "directive", targetWorkerId: "claude-2" });
  assert.equal(classifyLiveMessage("Claude에게 테스트부터 봐", [{ id: "claude", label: "Claude", agent: "claude" }]).intent, "directive");
  assert.equal(classifyLiveMessage("중지", workers).intent, "stop");
  assert.equal(classifyLiveMessage("멈춰줘", workers).intent, "stop");
  assert.equal(classifyLiveMessage("stop", workers).intent, "stop");
  assert.equal(classifyLiveMessage("중지하지 마", workers).intent, "ambiguous");
  assert.deepEqual(classifyLiveMessage("B 확인해", workers).intent, "ambiguous");
  assert.equal(classifyLiveMessage("B 확인해", workers).targetWorkerId, "claude-2");
  assert.equal(classifyLiveMessage("상태 알려줘", workers).intent, "status");
  for (const text of ["작업아직 하고있는거야?", "멈춘 거야?", "끝났어?", "왜 안 끝나", "다 됐어?"]) assert.equal(classifyLiveMessage(text, workers).intent, "status", text);
  assert.notEqual(classifyLiveMessage("아직이면 버튼 색도 바꿔줘", workers).intent, "status", "a request with a progress word still reaches the agent");
  assert.equal(classifyLiveMessage("그거 한번 봐\n\n```orchestra-attachments\n확인해 줘\n```", workers).intent, "ambiguous");
  assert.equal(classifyLiveMessage("중지\n\n```orchestra-attachments\nstop\n```", workers).intent, "stop");
});

test("status digest keeps each worker's recent tools, errors and delegations", () => {
  const event = (partial: Partial<SessionEvent> & Pick<SessionEvent, "id" | "type" | "text">): SessionEvent => ({
    sessionId: "s", agent: "claude", time: "2026-10-31T00:00:00.000Z", ...partial,
  });
  const session: Pick<Session, "status" | "agent" | "events" | "pendingInstructions"> = {
    status: "running",
    agent: "codex",
    pendingInstructions: [{ id: "q", text: "A부터 봐", targetWorkerId: "claude-2", createdAt: "2026-10-31T00:00:00.000Z" }],
    events: [
      event({ id: "ask", type: "message", text: "이전 상태 답", agent: "grok", metadata: { live: "status" } }),
      event({ id: "task", type: "delegation", text: "테스트 실행", workerId: "claude-2", workerLabel: "B", role: "worker" }),
      event({ id: "tool", type: "tool", text: "rg pattern", workerId: "claude-2", workerLabel: "B", role: "worker" }),
      event({ id: "cmd", type: "command", text: "npm test", workerId: "claude-2", workerLabel: "B", role: "worker" }),
      event({ id: "err", type: "error", text: "실패 한 줄", workerId: "claude-2", workerLabel: "B", role: "worker" }),
    ],
  };
  const digest = statusDigest(session);
  assert.match(digest, /\[B\]/);
  assert.match(digest, /command: npm test/);
  assert.match(digest, /error: 실패 한 줄/);
  assert.match(digest, /delegation: 테스트 실행/);
  assert.match(digest, /대기 중인 지시/);
  assert.doesNotMatch(digest, /이전 상태 답/);
  const prompt = statusPrompt("뭐하고 있어?", digest);
  assert.match(prompt, /파일을 수정하지 말고/);
  assert.match(prompt, /도구를 호출하지 말고/);
  assert.match(prompt, /npm test/);
  assert.equal(STATUS_AGENT_MODEL, "grok-4.7-build-fast");
});

test("pending instructions stay with the named worker until that worker's turn", () => {
  const queued = pushInstruction(undefined, { id: "1", text: "A부터 봐", targetWorkerId: "claude-2", createdAt: "t" });
  const forA = takePending(queued, "worker", "claude-1");
  assert.equal(forA.taken.length, 0);
  assert.equal(forA.rest.length, 1);
  const forB = takePending(queued, "worker", "claude-2");
  assert.deepEqual(forB.taken.map((item) => item.id), ["1"]);
  assert.equal(forB.rest.length, 0);
  const note = instructionSuffix(forB.taken);
  assert.match(note, /폐기하지 말고/);
  assert.match(note, /A부터 봐/);
  const untargeted = [{ id: "2", text: "총괄에게", createdAt: "t" }];
  assert.equal(takePending(untargeted, "worker", "claude-2").taken.length, 0);
  assert.equal(takePending(untargeted, "orchestrator").taken.length, 1);
  assert.equal(takePending(queued, "planner").taken.length, 0);
});
