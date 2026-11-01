import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killCliProcessGroups, runCli } from "./cli.js";
import { loadUsage } from "./usage.js";
import { loadProviderQuotas } from "./quota.js";

async function mockCli() {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-"));
  const executable = join(directory, "mock-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
const waiting = process.argv.includes("wait-for-cancel");
if (waiting) {
  process.once("SIGTERM", () => {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "cancelled" } }) + "\\n");
    process.exit(143);
  });
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "waiting" }) + "\\n");
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "mock-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "mock complete" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 15, reasoning_output_tokens: 3 } }) + "\\n");
}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { directory, executable };
}

test("runCli streams real child-process JSONL into normalized events", async () => {
  const { directory, executable } = await mockCli();
  process.env.SINAWI_CODEX_BIN = executable;
  const events: Array<{ type: string; text: string }> = [];
  const result = await runCli({
    agent: "codex", prompt: "stream", cwd: directory, model: "gpt-test",
    usageContext: { workspaceId: "personal", sessionId: "app-session", role: "orchestrator", dataDir: directory },
    onLine: (event) => events.push(event),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "mock-session");
  assert.equal(result.finalText, "mock complete");
  assert.deepEqual(events.map((event) => event.type), ["status", "command", "message"]);
  const [usage] = await loadUsage(directory);
  assert.equal(usage.agent, "codex");
  assert.equal(usage.model, "gpt-test");
  assert.equal(usage.sessionId, "app-session");
  assert.equal(usage.status, "completed");
  assert.deepEqual(usage.tokens, { input: 120, cached: 80, output: 15, reasoning: 3 });
  assert.ok(usage.durationMs >= 0);
});

test("runCli sends SIGTERM when its abort signal is cancelled", async () => {
  const { directory, executable } = await mockCli();
  process.env.SINAWI_CODEX_BIN = executable;
  const controller = new AbortController();
  const started = Date.now();
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const running = runCli({ agent: "codex", prompt: "wait-for-cancel", cwd: directory, signal: controller.signal,
    usageContext: { workspaceId: "company", sessionId: "cancelled-app-session", role: "worker", dataDir: directory }, onLine: (event) => {
    if (event.sessionId === "waiting") markReady?.();
  } });
  await ready;
  controller.abort();
  const result = await running;
  assert.equal(result.exitCode, 143);
  assert.ok(Date.now() - started < 1_500, "mock CLI should terminate promptly after SIGTERM");
  assert.equal((await loadUsage(directory))[0]?.status, "aborted");
});

test("runCli abort terminates the CLI's full process group", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-group-"));
  const child = join(directory, "group-child.mjs");
  const executable = join(directory, "group-parent.mjs");
  const pidFile = join(directory, "child.pid");
  const stoppedFile = join(directory, "child.stopped");
  await writeFile(child, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.once("SIGTERM", () => {
  writeFileSync(${JSON.stringify(stoppedFile)}, "stopped");
  process.exit(143);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "group-ready" }) + "\\n");
});
process.once("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await Promise.all([chmod(child, 0o700), chmod(executable, 0o700)]);
  process.env.SINAWI_CODEX_BIN = executable;
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
  });

  const controller = new AbortController();
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const running = runCli({
    agent: "codex", prompt: "group", cwd: directory, signal: controller.signal,
    onLine: (event) => { if (event.sessionId === "group-ready") markReady?.(); },
  });
  await ready;
  controller.abort();
  await running;

  let stopped = false;
  for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
    try { await access(stoppedFile); stopped = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(stopped, true, "the CLI child process should receive the process-group SIGTERM");
});

test("server shutdown kills the process group of a CLI that has no abort signal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-shutdown-"));
  const child = join(directory, "group-child.mjs");
  const executable = join(directory, "group-parent.mjs");
  const pidFile = join(directory, "child.pid");
  const stoppedFile = join(directory, "child.stopped");
  await writeFile(child, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.once("SIGTERM", () => {
  writeFileSync(${JSON.stringify(stoppedFile)}, "stopped");
  process.exit(143);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "shutdown-ready" }) + "\\n");
});
process.once("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await Promise.all([chmod(child, 0o700), chmod(executable, 0o700)]);
  process.env.SINAWI_CODEX_BIN = executable;
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
  });

  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const running = runCli({
    agent: "codex", prompt: "group", cwd: directory,
    onLine: (event) => { if (event.sessionId === "shutdown-ready") markReady?.(); },
  });
  await ready;
  // Other tests may still hold groups awaiting their SIGKILL escalation, so count at least this one.
  assert.ok(killCliProcessGroups("SIGTERM") >= 1);
  await running;

  let stopped = false;
  for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
    try { await access(stoppedFile); stopped = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(stopped, true, "the CLI grandchild should receive the shutdown SIGTERM");
});

test("runCli records a failed run when the CLI cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-missing-"));
  process.env.SINAWI_CODEX_BIN = join(directory, "missing-codex");
  await assert.rejects(runCli({
    agent: "codex", prompt: "fail", cwd: directory,
    usageContext: { workspaceId: "personal", sessionId: "failed-app-session", role: "router", dataDir: directory },
    onLine: () => {},
  }), /Codex CLI/);
  const [usage] = await loadUsage(directory);
  assert.equal(usage.status, "failed");
  assert.equal(usage.sessionId, "failed-app-session");
  assert.equal(usage.tokens, undefined);
});

test("runCli surfaces permission denials written to stderr as warnings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-stderr-"));
  const executable = join(directory, "mock-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stderr.write("Permission denied: gh pr view\\n");
process.exitCode = 1;
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.SINAWI_CLAUDE_BIN = executable;
  const events: Array<{ type: string; text: string }> = [];

  await runCli({ agent: "claude", prompt: "inspect", cwd: directory, onLine: (event) => events.push(event) });

  assert.deepEqual(events.filter((event) => event.type === "warning"), [
    { type: "warning", text: "권한 거부: gh pr view" },
  ]);
});

test("every Claude stream run caches its latest rate limit event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-claude-limit-"));
  const executable = join(directory, "mock-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: "2026-10-30T15:00:00Z" }, seven_day: { utilization: 0.4, resetsAt: "2026-11-02T00:00:00Z" } } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.SINAWI_CLAUDE_BIN = executable;
  const result = await runCli({
    agent: "claude", prompt: ".", cwd: directory,
    usageContext: { workspaceId: "personal", sessionId: "probe", role: "router", dataDir: directory },
    onLine: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  const claude = (await loadProviderQuotas(directory, directory)).find((provider) => provider.agent === "claude");
  assert.equal(claude?.windows.find((window) => window.key === "five_hour")?.remainingPercent, 8);
});

test("a live Claude rate limit event is visible before a long run exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-live-limit-"));
  const executable = join(directory, "mock-live-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
// runCli probes \`claude --help\` once per binary (see claudeHelpFlags); answer it like the real CLI.
if (process.argv.includes("--help")) { process.stdout.write("  --output-format <format>\\n"); process.exit(0); }
process.stdout.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: "2026-10-30T15:00:00Z" } } } }) + "\\n");
process.once("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.SINAWI_CLAUDE_BIN = executable;
  const controller = new AbortController();
  const running = runCli({
    agent: "claude", prompt: "long", cwd: directory, signal: controller.signal,
    usageContext: { workspaceId: "personal", sessionId: "live", role: "orchestrator", dataDir: directory },
    onLine: () => undefined,
  });
  try {
    let remaining: number | undefined;
    for (let attempt = 0; attempt < 40 && remaining === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining = (await loadProviderQuotas(directory, directory)).find((provider) => provider.agent === "claude")?.windows[0]?.remainingPercent;
    }
    assert.equal(remaining, 3);
  } finally {
    controller.abort();
    await running;
  }
});
