import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewPrompt } from "./supervision.js";
import { buildInvocation, STDIN_PROMPT_BYTES, CLAUDE_AUTO_MODE, CLAUDE_READ_ONLY_BASH_DENY, CLAUDE_READ_ONLY_BASH_RULES, claudeHelpFlags, killSessionProcessGroups, parseHelpFlags, prepareCliInvocation, runCli, sessionProcessGroups } from "./cli.js";

const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool access to
  --allowedTools, --allowed-tools <tools...>
  --effort <level>                      Effort level for the current session
  --include-partial-messages            Include partial message chunks as they arrive
  --output-format <format>              Output format (only works with --print)
  -p, --print                           Print response and exit
  --settings <file-or-json>             Path to a settings JSON file or a JSON string
`;

const OLD_HELP = `Usage: claude [options]

Options:
  --output-format <format>   Output format
  -p, --print                Print response and exit
  --allowedTools <tools...>  Allowed tools
`;

test("the help parser lists long flags, including aliases, and rejects unrelated text", () => {
  const flags = parseHelpFlags(HELP)!;
  for (const flag of ["--add-dir", "--allowedTools", "--allowed-tools", "--effort", "--include-partial-messages", "--output-format", "--print", "--settings"]) assert.ok(flags.has(flag), flag);
  assert.equal(flags.has("--tools"), false);
  assert.equal(flags.has(CLAUDE_AUTO_MODE), false);
  const withAuto = parseHelpFlags(`${HELP}\n  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: "acceptEdits", "auto",\n                                        "bypassPermissions", "plan")\n`)!;
  assert.equal(withAuto.has(CLAUDE_AUTO_MODE), true);
  const auto = buildInvocation({ agent: "claude", prompt: "p", cwd: "/w", claudeFlags: withAuto });
  assert.equal(auto.args[auto.args.indexOf("--permission-mode") + 1], "auto", "Sinawi auto uses Claude Code's auto mode");
  const old = buildInvocation({ agent: "claude", prompt: "p", cwd: "/w", claudeFlags: flags });
  assert.equal(old.args[old.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(parseHelpFlags("command not found"), undefined);
  assert.equal(parseHelpFlags(""), undefined);
});

test("an older Claude Code without the optional flags gets neither --include-partial-messages nor --settings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const usageContext = { workspaceId: "personal", sessionId: "s", role: "worker" as const, dataDir: dir };
  const old = await prepareCliInvocation({ agent: "claude", prompt: "work", cwd: "/work/repo", usageContext }, undefined, async () => parseHelpFlags(OLD_HELP));
  assert.equal(old.args.includes("--include-partial-messages"), false);
  assert.equal(old.args.includes("--settings"), false);
  const current = await prepareCliInvocation({ agent: "claude", prompt: "work", cwd: "/work/repo", usageContext }, undefined, async () => parseHelpFlags(HELP));
  assert.ok(current.args.includes("--include-partial-messages"));
  assert.ok(current.args.includes("--settings"));
  // A failed probe keeps today's flags rather than guessing the CLI is old.
  const unknown = await prepareCliInvocation({ agent: "claude", prompt: "work", cwd: "/work/repo", usageContext }, undefined, async () => undefined);
  assert.ok(unknown.args.includes("--include-partial-messages"));
});

test("claudeHelpFlags runs --help once per binary and caches the parsed result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const counter = join(dir, "count");
  const executable = join(dir, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
process.stdout.write(${JSON.stringify(OLD_HELP)});
`);
  await chmod(executable, 0o700);
  const [first, second] = await Promise.all([claudeHelpFlags(executable), claudeHelpFlags(executable)]);
  assert.ok(first?.has("--output-format"));
  assert.equal(first, second);
  assert.equal((await claudeHelpFlags(executable))?.has("--settings"), false);
  assert.equal(await readFile(counter, "utf8"), "x");
  assert.equal(await claudeHelpFlags(join(dir, "missing")), undefined);
});

test("the Claude review profile only reads: no test runners, and writing/exec flags are denied", () => {
  const review = buildInvocation({ agent: "claude", prompt: "review", cwd: "/work/repo", readOnly: true, readTools: true });
  const allowed = review.args.slice(review.args.indexOf("--allowedTools") + 1, review.args.indexOf("--disallowedTools"));
  assert.deepEqual(allowed, CLAUDE_READ_ONLY_BASH_RULES);
  for (const rule of allowed) assert.doesNotMatch(rule, /npm|node|test/u, rule);
  const denied = review.args.slice(review.args.indexOf("--disallowedTools") + 1, review.args.indexOf("--disallowedTools") + 1 + CLAUDE_READ_ONLY_BASH_DENY.length);
  assert.deepEqual(denied, CLAUDE_READ_ONLY_BASH_DENY);
  assert.ok(denied.includes("Bash(*--output*)"));
  assert.ok(denied.includes("Bash(*--pre*)"));
  assert.equal(review.args[review.args.indexOf("--permission-mode") + 1], "plan");
});

async function fakeCodex(t: test.TestContext, body: string) {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const executable = join(dir, "mock-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node\n${body}`);
  await chmod(executable, 0o700);
  const previous = process.env.SINAWI_CODEX_BIN;
  process.env.SINAWI_CODEX_BIN = executable;
  t.after(() => { if (previous === undefined) delete process.env.SINAWI_CODEX_BIN; else process.env.SINAWI_CODEX_BIN = previous; });
  return dir;
}

test("stderr output is not activity; stdout lines are", async (t) => {
  const dir = await fakeCodex(t, `
for (let i = 0; i < 20; i++) process.stderr.write("retrying in 1s...\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\\n");
`);
  let activity = 0;
  const result = await runCli({ agent: "codex", prompt: "x", cwd: dir, onLine: () => undefined, onActivity: () => { activity++; }, usageContext: { workspaceId: "personal", sessionId: "act", role: "worker", dataDir: dir } });
  assert.equal(result.finalText, "ok");
  assert.equal(activity, 1, "only the stdout line counts");
});

test("background children left by a finished CLI are tracked per session and killed with it", async (t) => {
  const dir = await fakeCodex(t, `
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }).unref();
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "server up" } }) + "\\n");
`);
  const sessionId = "orphan-session";
  const result = await runCli({ agent: "codex", prompt: "serve", cwd: dir, onLine: () => undefined, exitGraceMs: 200, usageContext: { workspaceId: "personal", sessionId, role: "worker", dataDir: dir } });
  assert.equal(result.finalText, "server up");
  const groups = sessionProcessGroups(sessionId);
  assert.equal(groups.length, 1, "the dev-server-like child is still running and tracked, not killed at exit");
  assert.equal(killSessionProcessGroups(sessionId), 1);
  const alive = () => { try { process.kill(-groups[0], 0); return true; } catch { return false; } };
  const started = Date.now();
  while (alive() && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the group is gone after session deletion");
  assert.deepEqual(sessionProcessGroups(sessionId), []);
  assert.equal(killSessionProcessGroups("nothing-here"), 0);
});

test("the review prompt tells the reviewer to read test evidence, not run tests", () => {
  const prompt = reviewPrompt(["[w 결과]\n완료"], "", 1);
  assert.match(prompt, /테스트·빌드·스크립트는 직접 실행하지 마세요/);
  assert.match(prompt, /<<DELEGATE>>로 워커에게 맡기세요/);
});

test("workspace full access runs every CLI without approval prompts, but never a read-only run", async () => {
  const { buildInvocation } = await import("./cli.js");
  const { defaultWorkspacePolicy, normalizeWorkspacePolicy } = await import("./workspace-policy.js");
  assert.ok(!defaultWorkspacePolicy().fullAccess, "opt-in");
  assert.ok(!normalizeWorkspacePolicy({ mediaGeneration: true }).fullAccess, "stored policies without the field stay off");
  assert.ok(!normalizeWorkspacePolicy({ fullAccess: false }, true, { ...defaultWorkspacePolicy(), fullAccess: true }).fullAccess, "can be turned off again");
  assert.equal(normalizeWorkspacePolicy({ fullAccess: true }, true).fullAccess, true);

  const base = { prompt: "p", cwd: "/work", blockedMcp: ["mcp__x__*"] };
  const claude = buildInvocation({ ...base, agent: "claude", fullAccess: true }).args;
  assert.ok(claude.includes("--dangerously-skip-permissions"));
  assert.ok(!claude.includes("acceptEdits"));
  assert.ok(claude.includes("mcp__x__*"), "blocked tools stay blocked");
  const codex = buildInvocation({ ...base, agent: "codex", fullAccess: true }).args;
  assert.ok(codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!codex.includes("--sandbox"));
  const grok = buildInvocation({ ...base, agent: "grok", fullAccess: true }).args;
  assert.deepEqual(grok.slice(grok.indexOf("--permission-mode"), grok.indexOf("--permission-mode") + 3), ["--permission-mode", "bypassPermissions", "--always-approve"]);
  assert.ok(grok.includes("mcp__x__*"));

  for (const agent of ["claude", "codex", "grok"] as const) {
    const review = buildInvocation({ ...base, agent, fullAccess: true, readOnly: true, readTools: true }).args.join(" ");
    assert.doesNotMatch(review, /dangerously|bypassPermissions|always-approve/, agent);
    const normal = buildInvocation({ ...base, agent }).args.join(" ");
    assert.doesNotMatch(normal, /dangerously|bypassPermissions|always-approve/, agent);
  }
});

test("a prompt starting with - is not read as an option, and a huge one goes through stdin (L1)", () => {
  for (const agent of ["claude", "codex", "grok"] as const) {
    const dash = buildInvocation({ agent, prompt: "--help me", cwd: "/w" });
    assert.ok(dash.args.includes(" --help me"), `${agent}: ${dash.args.join(" ")}`);
    assert.ok(!dash.args.includes("--help me"));
  }
  const huge = "x".repeat(STDIN_PROMPT_BYTES + 1);
  const claude = buildInvocation({ agent: "claude", prompt: huge, cwd: "/w" });
  assert.equal(claude.stdin, huge);
  assert.ok(!claude.args.includes(huge));
  assert.equal(claude.args[0], "-p");
  assert.equal(claude.args[1], "--output-format");
  const codex = buildInvocation({ agent: "codex", prompt: huge, cwd: "/w" });
  assert.equal(codex.stdin, huge);
  assert.equal(codex.args.at(-1), "-");
  assert.equal(buildInvocation({ agent: "claude", prompt: "small", cwd: "/w" }).stdin, undefined);
});

test("runCli writes a stdin prompt to the CLI and closes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-cli-stdin-"));
  const executable = join(directory, "mock-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--help")) { process.stdout.write("  --output-format <format>\\n"); process.exit(0); }
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "result", result: "got " + input.length, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n"));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.SINAWI_CLAUDE_BIN;
  process.env.SINAWI_CLAUDE_BIN = executable;
  try {
    const prompt = "y".repeat(STDIN_PROMPT_BYTES + 5);
    const result = await runCli({ agent: "claude", prompt, cwd: directory, onLine: () => undefined });
    assert.equal(result.finalText, `got ${prompt.length}`);
  } finally {
    if (previous === undefined) delete process.env.SINAWI_CLAUDE_BIN; else process.env.SINAWI_CLAUDE_BIN = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
