import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCliLine, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { resumeIdFits } from "./store.js";
import { defaultWorkspacePolicy } from "./workspace-policy.js";
import type { AgentId } from "./types.js";

// Real id shapes: Claude Code session ids are UUIDv4, Grok Build and Codex ids are UUIDv7.
const GROK_ID = "01a1ee14-acb8-7d41-a1bb-8e8884a0664a";
const GROK_WORKER_ID = "01a1ee18-1111-7222-8333-444455556666";
const CLAUDE_ID = "3f2b8c1e-9d4a-4b6e-8f0a-1c2d3e4f5a6b";

type Restored = Parameters<Orchestra["restore"]>[0][number];

async function settled(session: { status: string }) {
  for (let attempt = 0; attempt < 400 && session.status === "running"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function thread(id: string, fields: Record<string, unknown> = {}, fallback?: { from: AgentId; to: AgentId; resetsAt: number }): Restored {
  const time = new Date().toISOString();
  const events = fallback ? [{
    id: `${id}-quota`, sessionId: id, agent: fallback.to, type: "handoff", time, text: "한도 소진 전환",
    metadata: { auto: true, quotaFallback: true, from: fallback.from, to: fallback.to, reason: "한도 소진", resetsAt: fallback.resetsAt },
  }] : [];
  return { id, agent: "claude", workers: [], title: id, cwd: process.cwd(), status: "done", createdAt: time, workspaceId: "personal", events, ...fields } as unknown as Restored;
}

test("a failed Claude result line shows its errors, not the raw JSON", () => {
  const raw = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "x", errors: [`No conversation found with session ID: ${GROK_ID}`] });
  const lines = normalizeCliLine("claude", raw);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "error");
  assert.equal(lines[0].text, `No conversation found with session ID: ${GROK_ID}`);
});

test("resume ids fit only the CLI and account that made them; legacy ids are judged by shape", () => {
  assert.equal(resumeIdFits(GROK_ID, "claude", undefined, { agent: "grok" }), false);
  assert.equal(resumeIdFits(CLAUDE_ID, "grok", undefined, { agent: "claude" }), false);
  assert.equal(resumeIdFits(CLAUDE_ID, "claude", "/a", { agent: "claude", account: "/b" }), false);
  assert.equal(resumeIdFits(CLAUDE_ID, "claude", "/a", { agent: "claude", account: "/a" }), true);
  assert.equal(resumeIdFits(GROK_ID, "claude", undefined), false);
  assert.equal(resumeIdFits(CLAUDE_ID, "grok", undefined), false);
  assert.equal(resumeIdFits(CLAUDE_ID, "claude", undefined), true);
  assert.equal(resumeIdFits("opaque", "claude", undefined, undefined, true), false);
});

for (const [lead, ranOn] of [["claude", "grok"], ["grok", "claude"]] as const) {
  test(`an id from ${ranOn} is not stored as the ${lead} lead's resume id`, async () => {
    const agents: string[] = [];
    const orchestra = new Orchestra(undefined, async (options) => {
      agents.push(options.agent);
      options.onLine({ type: "status", text: "connected", sessionId: `${options.agent}-new` });
      return { exitCode: 0, finalText: "done", sessionId: `${options.agent}-new` };
    });
    // An active quota fallback still sends the lead's run to the other CLI while session.agent stays put.
    orchestra.restore([thread(`foreign-${lead}`, { agent: lead }, { from: lead, to: ranOn, resetsAt: Date.now() / 1_000 + 3_600 })]);
    const session = await orchestra.followup(`foreign-${lead}`, "work");
    await settled(session);
    assert.deepEqual(agents, [ranOn]);
    assert.equal(session.cliSessionId, undefined);
  });
}

test("a lead's own id is stored with its agent and account and resumed next turn", async () => {
  const calls: RunCliOptions[] = [];
  const policy = () => ({ ...defaultWorkspacePolicy(), accounts: { claude: "/tmp/sinawi-account-a" } });
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done", sessionId: CLAUDE_ID };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, policy);
  orchestra.restore([thread("own")]);
  const session = await orchestra.followup("own", "first");
  await settled(session);
  assert.equal(session.cliSessionId, CLAUDE_ID);
  assert.equal(session.cliSessionAgent, "claude");
  assert.equal(session.cliSessionAccount, "/tmp/sinawi-account-a");
  await orchestra.followup("own", "second");
  await settled(session);
  assert.equal(calls[1].resumeSessionId, CLAUDE_ID);
});

test("a resume id from another account dir is not reused", async () => {
  const calls: RunCliOptions[] = [];
  const policy = () => ({ ...defaultWorkspacePolicy(), accounts: { claude: "/tmp/sinawi-account-b" } });
  const orchestra = new Orchestra(undefined, async (options) => { calls.push(options); return { exitCode: 0, finalText: "done" }; },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, policy);
  orchestra.restore([thread("other-account", { cliSessionId: CLAUDE_ID, cliSessionAgent: "claude", cliSessionAccount: "/tmp/sinawi-account-a" })]);
  const session = await orchestra.followup("other-account", "work");
  await settled(session);
  assert.equal(calls[0].resumeSessionId, undefined);
});

for (const legacyId of [GROK_ID, "opaque-legacy-id"]) {
  test(`a legacy Claude lead with a foreign id (${legacyId}) after a Claude → Grok fallback starts fresh with the conversation`, async () => {
    const calls: RunCliOptions[] = [];
    const orchestra = new Orchestra(undefined, async (options) => {
      calls.push(options);
      return { exitCode: 0, finalText: "done", sessionId: CLAUDE_ID };
    });
    // The bug report's thread: the fallback is over (reset passed), the Grok id stayed behind, untagged.
    orchestra.restore([thread("legacy", { cliSessionId: legacyId, workerSessionIds: {} }, { from: "claude", to: "grok", resetsAt: Date.now() / 1_000 - 60 })]);
    const session = await orchestra.followup("legacy", "work");
    await settled(session);
    assert.equal(session.status, "done");
    assert.deepEqual(calls.map((call) => [call.agent, call.resumeSessionId]), [["claude", undefined]]);
    assert.match(calls[0].prompt, /이전 대화 요약/u);
    assert.equal(session.cliSessionId, CLAUDE_ID);
    assert.equal(session.cliSessionAgent, "claude");
  });
}

function missingConversationRunner(calls: RunCliOptions[], retry: "ok" | "fail") {
  return async (options: RunCliOptions) => {
    calls.push(options);
    if (options.resumeSessionId) {
      // What runCli passes on for Claude's failed result line (normalizeCliLine extracts `errors`).
      const raw = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "dead-end", errors: [`No conversation found with session ID: ${options.resumeSessionId}`] });
      for (const line of normalizeCliLine("claude", raw)) options.onLine(line);
      return { exitCode: 1, finalText: "", sessionId: "dead-end" };
    }
    if (retry === "fail") {
      options.onLine({ type: "error", text: "API Error: 500 overloaded" });
      return { exitCode: 1, finalText: "" };
    }
    options.onLine({ type: "message", text: "answer", finalText: "answer", sessionId: CLAUDE_ID });
    return { exitCode: 0, finalText: "answer", sessionId: CLAUDE_ID };
  };
}

test("a missing conversation clears the id and retries once fresh with a summary, without a raw error", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, missingConversationRunner(calls, "ok"));
  const stale = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
  orchestra.restore([thread("heal", {
    cliSessionId: stale, cliSessionAgent: "claude",
    events: [{ id: "u1", sessionId: "heal", agent: "user", type: "message", time: new Date().toISOString(), text: "이전 질문: 로그인 버그" }],
  })]);
  const session = await orchestra.followup("heal", "continue");
  await settled(session);
  assert.equal(session.status, "done");
  assert.deepEqual(calls.map((call) => call.resumeSessionId), [stale, undefined]);
  assert.match(calls[1].prompt, /이전 대화 요약:[\s\S]*로그인 버그/u);
  assert.equal(session.cliSessionId, CLAUDE_ID);
  assert.equal(session.events.some((event) => event.type === "error"), false);
  assert.equal(session.events.some((event) => event.text.includes('"type":"result"') || event.text.includes("No conversation found")), false);
});

test("a fresh retry that also fails ends with one friendly error", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, missingConversationRunner(calls, "fail"));
  orchestra.restore([thread("heal-fail", { cliSessionId: CLAUDE_ID, cliSessionAgent: "claude" })]);
  const session = await orchestra.followup("heal-fail", "continue");
  await settled(session);
  assert.equal(session.status, "error");
  assert.equal(calls.length, 2);
  const errors = session.events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /^이전 CLI 대화를 이어받지 못해 새 대화로 다시 시도했지만 실패했습니다: API Error: 500 overloaded$/u);
  assert.equal(session.cliSessionId, undefined);
});

test("a worker whose agent changed does not reuse the old provider's session id", async () => {
  for (const [workerSessionIds, workerSessionOrigins] of [
    [{ "grok-2": GROK_WORKER_ID }, undefined],
    [{ "grok-2": "opaque-worker-id" }, { "grok-2": { agent: "grok" } }],
  ] as const) {
    const workerCalls: RunCliOptions[] = [];
    let lead = 0;
    const orchestra = new Orchestra(undefined, async (options) => {
      if (options.usageContext?.role === "worker") {
        workerCalls.push(options);
        return { exitCode: 0, finalText: "상태: 완료\n끝", sessionId: CLAUDE_ID };
      }
      return { exitCode: 0, finalText: lead++ === 0 ? '<<DELEGATE to="grok-2">>do it<</DELEGATE>>' : "final" };
    });
    orchestra.restore([thread("worker-moved", {
      agent: "codex", workers: ["claude"], workerConfigs: [{ id: "grok-2", agent: "claude" }],
      workerSessionIds: { ...workerSessionIds }, ...(workerSessionOrigins ? { workerSessionOrigins: structuredClone(workerSessionOrigins) } : {}),
    })]);
    const session = await orchestra.followup("worker-moved", "work");
    await settled(session);
    assert.equal(session.status, "done");
    assert.deepEqual(workerCalls.map((call) => [call.agent, call.resumeSessionId]), [["claude", undefined]]);
    assert.deepEqual(session.workerSessionIds, { "grok-2": CLAUDE_ID });
    assert.deepEqual(session.workerSessionOrigins, { "grok-2": { agent: "claude" } });
  }
});
