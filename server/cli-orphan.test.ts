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
