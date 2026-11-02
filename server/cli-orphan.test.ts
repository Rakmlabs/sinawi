import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "./cli.js";

// A CLI that answers and exits while a background child it started (dev server, watcher)
// still holds its stdout. `close` never fires until that child dies, so the run used to
// hang in "running" although the CLI itself had finished.
test("runCli finishes when the CLI exits but a background child keeps stdout open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-orphan-"));
  const executable = join(directory, "mock-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "orphan" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done with server" } }) + "\\n");
process.exit(0);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.SINAWI_CODEX_BIN = executable;
  const started = Date.now();
  const result = await runCli({ agent: "codex", prompt: "serve", cwd: directory, onLine: () => undefined, exitGraceMs: 300 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalText, "done with server");
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
});

// `claude -p` prints its result but keeps running while a background shell it started is alive.
test("runCli ends a CLI that lingers after its end-of-turn line, as a normal exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-linger-"));
  const executable = join(directory, "mock-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "linger" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "상태: 완료", session_id: "linger" }) + "\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.SINAWI_CLAUDE_BIN;
  process.env.SINAWI_CLAUDE_BIN = executable;
  try {
    const started = Date.now();
    const result = await runCli({ agent: "claude", prompt: "serve", cwd: directory, onLine: () => undefined, exitGraceMs: 200, turnEndGraceMs: 300 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalText, "상태: 완료");
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  } finally {
    if (previous === undefined) delete process.env.SINAWI_CLAUDE_BIN; else process.env.SINAWI_CLAUDE_BIN = previous;
  }
});

test("a result line followed by more work is not the end: a resumed Claude answers task notifications first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-notify-"));
  const executable = join(directory, "mock-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
const out = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
out({ type: "system", subtype: "init", session_id: "notify" });
out({ type: "result", subtype: "success", result: "No response requested.", session_id: "notify" });
let step = 0;
const timer = setInterval(() => {
  step++;
  out({ type: "assistant", message: { content: [{ type: "text", text: "작업 " + step }] }, session_id: "notify" });
  if (step === 4) { clearInterval(timer); out({ type: "result", subtype: "success", result: "상태: 완료", session_id: "notify" }); process.exit(0); }
}, 200);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.SINAWI_CLAUDE_BIN;
  process.env.SINAWI_CLAUDE_BIN = executable;
  try {
    const result = await runCli({ agent: "claude", prompt: "work", cwd: directory, onLine: () => undefined, exitGraceMs: 200, turnEndGraceMs: 300 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalText, "상태: 완료", "the CLI was not cut off after the notification turn's result");
  } finally {
    if (previous === undefined) delete process.env.SINAWI_CLAUDE_BIN; else process.env.SINAWI_CLAUDE_BIN = previous;
  }
});
