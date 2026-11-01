import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import { sessionStreamMessage } from "./server.js";
import type { RunCliOptions } from "./cli.js";
import type { Session } from "./types.js";
import { delegationWorkers, mainConversation } from "../src/conversation.js";

const settle = (session: Session) => new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("timeout")), 2_000);
  const poll = () => { if (session.status !== "running") { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); };
  poll();
});

function scripted(calls: Array<{ agent: string; role?: string; resume?: string }>, hangWorker = false) {
  return async (options: RunCliOptions) => {
    calls.push({ agent: options.agent, role: options.usageContext?.role, resume: options.resumeSessionId });
    if (options.usageContext?.role === "worker") {
      if (hangWorker) await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
      options.onLine({ type: "message", text: "worker log", finalText: "worker done", sessionId: `w-${calls.length}` });
      return { exitCode: 0, finalText: "worker done", sessionId: `w-${calls.length}` };
    }
    const delegate = !calls.some((call) => call.role === "worker") || calls.filter((c) => c.role !== "worker").length % 2 === 1;
    const text = delegate && calls.filter((c) => c.role === "worker").length < calls.filter((c) => c.role !== "worker").length ? '<<DELEGATE to="claude">>Inspect<</DELEGATE>>' : "Final";
    options.onLine({ type: "message", text, finalText: text, sessionId: "root" });
    return { exitCode: 0, finalText: text, sessionId: "root" };
  };
}

test("deleting a finished worker clears its log and resume id but keeps the delegation as deleted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wdel-"));
  const calls: Array<{ agent: string; role?: string; resume?: string }> = [];
  let persisted: Session[] = [];
  const orchestra = new Orchestra(() => undefined, scripted(calls), (sessions) => { persisted = structuredClone(sessions); });
  const session = await orchestra.create({ prompt: "go", agent: "codex", workers: ["claude"], cwd });
  await settle(session);
  const workerId = session.events.find((event) => event.type === "delegation")!.workerId!;
  assert.ok(session.workerSessionIds?.[workerId]);
  assert.equal(delegationWorkers(session, Date.now()).length, 1);

  orchestra.removeWorker(session.id, workerId);
  assert.equal(session.workerSessionIds?.[workerId], undefined);
  assert.equal(session.events.some((event) => event.role === "worker" && event.type !== "delegation"), false);
  const card = session.events.find((event) => event.type === "delegation")!;
  assert.equal(card.metadata?.deletedWorker, true);
  assert.equal(delegationWorkers(session, Date.now()).length, 0, "deleted worker hidden from sidebar");
  assert.ok(mainConversation(session).some((event) => event.id === card.id), "chat history keeps the card");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(persisted[0].events.find((event) => event.type === "delegation")?.metadata?.deletedWorker, true);
  assert.throws(() => orchestra.removeWorker(session.id, workerId), /찾을 수 없습니다/);

  // A restored session (after restart) keeps the deleted state and the next delegation starts fresh.
  const restarted = new Orchestra(() => undefined, scripted(calls));
  restarted.restore(structuredClone(persisted));
  const before = calls.length;
  const again = await restarted.followup(session.id, "again");
  await settle(again);
  const workerCall = calls.slice(before).find((call) => call.role === "worker");
  assert.ok(workerCall, "worker delegated again");
  assert.equal(workerCall.resume, undefined, "no resume of deleted worker session");
  assert.equal(delegationWorkers(again, Date.now()).length, 1, "new worker appears fresh");
});

test("deleting a running worker stops the run first", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wdel-"));
  const calls: Array<{ agent: string; role?: string; resume?: string }> = [];
  const orchestra = new Orchestra(() => undefined, scripted(calls, true));
  const session = await orchestra.create({ prompt: "go", agent: "codex", workers: ["claude"], cwd });
  const deadline = Date.now() + 2_000;
  while (!calls.some((call) => call.role === "worker") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const workerId = session.events.find((event) => event.type === "delegation")!.workerId!;
  orchestra.removeWorker(session.id, workerId);
  assert.equal(session.status, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.status, "stopped");
  assert.equal(session.workerSessionIds?.[workerId], undefined);
  assert.equal(delegationWorkers(session, Date.now()).length, 0);
});

test("unknown chat or worker is rejected", async () => {
  const orchestra = new Orchestra(() => undefined, scripted([]));
  assert.throws(() => orchestra.removeWorker("missing", "claude"), /세션을 찾을 수 없습니다/);
});

test("clients following the incremental stream see a removed worker's log disappear", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wdel-stream-"));
  const calls: Array<{ agent: string; role?: string; resume?: string }> = [];
  // Mirrors the browser client: incremental messages merge by id, full snapshots replace.
  let cursor: string | undefined;
  let clientEvents: Session["events"] = [];
  const fullPublishes: number[] = [];
  const publish = (published: Session, options?: { full?: boolean }) => {
    const message = sessionStreamMessage(published, cursor, options?.full);
    const incoming = structuredClone(message.session.events);
    clientEvents = "incremental" in message ? [...new Map([...clientEvents, ...incoming].map((event) => [event.id, event])).values()] : incoming;
    cursor = published.events.at(-1)?.id;
    if (options?.full) fullPublishes.push(published.events.length);
  };
  const orchestra = new Orchestra(publish, scripted(calls));
  const session = await orchestra.create({ prompt: "go", agent: "codex", workers: ["claude"], cwd });
  await settle(session);
  assert.equal(fullPublishes.length, 0, "ordinary appends stay incremental");
  const workerId = session.events.find((event) => event.type === "delegation")!.workerId!;
  assert.ok(clientEvents.some((event) => event.role === "worker" && event.type !== "delegation"));

  orchestra.removeWorker(session.id, workerId);
  assert.equal(fullPublishes.length, 1);
  assert.deepEqual(clientEvents.map((event) => event.id), session.events.map((event) => event.id));
  assert.equal(clientEvents.find((event) => event.type === "delegation")?.metadata?.deletedWorker, true);
});
