// Two messages sent to one chat at nearly the same time (two orchestrators, a lead's ask and the user,
// an MCP retry): one runs, the other is refused out loud; neither is dropped silently.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";

test("concurrent follow-ups: the second is refused, the first reaches the CLI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts: string[] = [];
  const runner = async (options: any) => {
    prompts.push(options.prompt);
    await new Promise((resolve) => setTimeout(resolve, 50));
    options.onLine({ type: "message", text: "ok", finalText: "ok" });
    return { exitCode: 0, finalText: "ok" };
  };
  const orchestra = new Orchestra(undefined, runner as never, undefined, undefined, undefined, undefined, dir);
  const session = await orchestra.create({ prompt: "", agent: "claude", workers: [], cwd: dir } as never);
  const results = await Promise.allSettled([orchestra.followup(session.id, "MESSAGE-ONE"), orchestra.followup(session.id, "MESSAGE-TWO")]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason?.message), /실행 중/u);
  for (let i = 0; i < 100 && orchestra.isWorking(session.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const said = orchestra.get(session.id)!.events.filter((event) => event.agent === "user").map((event) => event.text);
  assert.deepEqual(said, ["MESSAGE-ONE"], "the refused message is not shown as sent");
  assert.ok(prompts.some((prompt) => prompt.includes("MESSAGE-ONE")));
  assert.ok(!prompts.some((prompt) => prompt.includes("MESSAGE-TWO")));
});

test("a new turn waits for the lead's end-of-turn merge to finish (L8)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-settle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started: number[] = [];
  const runner = async (options: any) => {
    started.push(Date.now());
    options.onLine({ type: "message", text: "ok", finalText: "ok" });
    return { exitCode: 0, finalText: "ok" };
  };
  const orchestra = new Orchestra(undefined, runner as never, undefined, undefined, undefined, undefined, dir);
  const session = await orchestra.create({ prompt: "", agent: "claude", workers: [], cwd: dir } as never);
  let mergeDone = 0;
  let release!: () => void;
  const merging = new Promise<void>((resolve) => { release = () => { mergeDone = Date.now(); resolve(); }; });
  (orchestra as unknown as { settlingDone: Map<string, Promise<void>> }).settlingDone.set(session.id, merging);
  const next = orchestra.followup(session.id, "NEXT");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(started.length, 0, "no CLI run while the merge is in flight");
  release();
  (orchestra as unknown as { settlingDone: Map<string, Promise<void>> }).settlingDone.delete(session.id);
  await next;
  for (let i = 0; i < 100 && orchestra.isWorking(session.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(started.length >= 1 && started[0] >= mergeDone, "the turn started after the merge");
});
