// First-run #4: a CLI that is not signed in shows one error carrying the login command, not the CLI's
// text followed by a bare "exit code 1".
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import { loginNeededText } from "./workspace-policy.js";

test("sign-in errors from each CLI are recognised, other failures are not", () => {
  assert.ok(loginNeededText("Not signed in. To authenticate without a browser, run: grok login --device-code"));
  assert.ok(loginNeededText("Invalid API key · Please run /login"));
  assert.ok(loginNeededText("You are not logged in. Run `codex login`."));
  assert.ok(!loginNeededText("Error: ENOENT: no such file or directory"));
  assert.ok(!loginNeededText("rate limit reached"));
});

test("a not-signed-in run ends with one error that carries the login command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-login-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runner = async (options: any) => {
    options.onLine({ type: "error", text: "Not signed in. To authenticate without a browser, run: grok login --device-code" });
    return { exitCode: 1, finalText: "" };
  };
  const orchestra = new Orchestra(undefined, runner as never, undefined, undefined, undefined, undefined, dir);
  const session = await orchestra.create({ prompt: "hi", agent: "grok", workers: [], cwd: dir } as never);
  for (let i = 0; i < 100 && orchestra.isWorking(session.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const errors = orchestra.get(session.id)!.events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1, JSON.stringify(errors.map((event) => event.text)));
  assert.deepEqual(errors[0].metadata?.loginNeeded, { agent: "grok", command: "grok login" });
  assert.equal(orchestra.get(session.id)!.status, "error");
});
