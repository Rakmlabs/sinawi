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
