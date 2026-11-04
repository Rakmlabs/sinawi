// Per-workspace CLI accounts (WorkspacePolicy.accounts): every CLI run of an agent in a workspace
// gets CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME set to the folder the workspace keeps for it.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountEnv, runCli, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { loadProviderQuotas, saveProviderQuota } from "./quota.js";
import { withWorkspaceAccounts } from "./server.js";
import { loadSkills } from "./skills.js";
import { loadUsage } from "./usage.js";
import { accountDirFor, accountLoginCommand, defaultWorkspacePolicy, normalizeWorkspacePolicy, WorkspacePolicyInputError } from "./workspace-policy.js";

test("account folders are validated, merged per agent and cleared with an empty value", () => {
  const base = normalizeWorkspacePolicy({ accounts: { claude: "/acc/claude/", codex: "/acc//codex" } }, true);
  assert.deepEqual(base.accounts, { claude: "/acc/claude", codex: "/acc/codex" });
  const merged = normalizeWorkspacePolicy({ accounts: { grok: "/acc/grok", claude: "" } }, true, base);
  assert.deepEqual(merged.accounts, { codex: "/acc/codex", grok: "/acc/grok" }, "a key left out keeps its folder; an empty one clears it");
  assert.deepEqual(normalizeWorkspacePolicy({ mediaGeneration: false }, true, merged).accounts, merged.accounts, "other changes keep the accounts");
  assert.equal(normalizeWorkspacePolicy({ accounts: null }, true, merged).accounts, undefined);
  assert.equal(normalizeWorkspacePolicy({ accounts: { codex: "" } }, true, normalizeWorkspacePolicy({ accounts: { codex: "/x" } }, true)).accounts, undefined, "no folder left: no accounts at all");
  assert.equal("accounts" in defaultWorkspacePolicy(), false, "a fresh workspace uses the default logins");
  for (const accounts of [{ claude: "relative/dir" }, { claude: "/a/../b" }, { gemini: "/x" }, { codex: 3 }, ["/x"], "x"]) {
    assert.throws(() => normalizeWorkspacePolicy({ accounts }, true), WorkspacePolicyInputError, JSON.stringify(accounts));
  }
  // Stored data with a bad value keeps the good ones.
  assert.deepEqual(normalizeWorkspacePolicy({ accounts: { claude: "nope", grok: "/g" } }).accounts, { grok: "/g" });
  assert.equal(accountDirFor(merged, "grok"), "/acc/grok");
  assert.equal(accountDirFor(merged, "claude"), undefined);
  assert.equal(accountDirFor(undefined, "claude"), undefined);
});

test("each CLI gets its own account variable and a login command for it", () => {
  assert.deepEqual(accountEnv("claude", "/a"), { CLAUDE_CONFIG_DIR: "/a" });
  assert.deepEqual(accountEnv("codex", "/b"), { CODEX_HOME: "/b" });
  assert.deepEqual(accountEnv("grok", "/c"), { GROK_HOME: "/c" });
  assert.deepEqual(accountEnv("claude", undefined), {});
  assert.equal(accountLoginCommand("claude"), "claude auth login");
  assert.equal(accountLoginCommand("codex", "/Users/me/work codex"), "mkdir -p '/Users/me/work codex' && CODEX_HOME='/Users/me/work codex' codex login");
  assert.equal(accountLoginCommand("grok", "/it's"), "mkdir -p '/it'\\''s' && GROK_HOME='/it'\\''s' grok login");
});

async function envEchoCli(variable: string) {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-account-cli-"));
  const executable = join(directory, "mock-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "home=" + (process.env.${variable} ?? "(unset)") } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { directory, executable };
}

test("runCli hands the CLI its account folder, and leaves the default login alone without one", async (t) => {
  const { directory, executable } = await envEchoCli("CODEX_HOME");
  const previous = { bin: process.env.SINAWI_CODEX_BIN, home: process.env.CODEX_HOME };
  process.env.SINAWI_CODEX_BIN = executable;
  t.after(async () => {
    if (previous.bin === undefined) delete process.env.SINAWI_CODEX_BIN; else process.env.SINAWI_CODEX_BIN = previous.bin;
    await rm(directory, { recursive: true, force: true });
  });
  const usageContext = { workspaceId: "work", sessionId: "s", role: "worker" as const, dataDir: directory };
  const withAccount = await runCli({ agent: "codex", prompt: "x", cwd: directory, accountDir: "/accounts/work-codex", usageContext, onLine: () => undefined });
  assert.equal(withAccount.finalText, "home=/accounts/work-codex");
  const plain = await runCli({ agent: "codex", prompt: "x", cwd: directory, onLine: () => undefined });
  assert.equal(plain.finalText, `home=${previous.home ?? "(unset)"}`, "no account: the environment the app has");
  const runs = await loadUsage(directory);
  assert.equal(runs.at(-1)?.account, "/accounts/work-codex", "usage records which login the run used");
});

test("every lead and worker run uses its workspace's account; other workspaces keep the default login", async () => {
  const calls: RunCliOptions[] = [];
  const policy = (id: string) => normalizeWorkspacePolicy(id === "work" ? { accounts: { claude: "/acc/claude-work", codex: "/acc/codex-work" } } : {});
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: calls.length % 2 === 1 ? '<<DELEGATE to="codex">>Do it<</DELEGATE>>' : "done" };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, policy);
  for (const workspaceId of ["work", "home"]) {
    const session = await orchestra.create({ prompt: "Build", agent: "claude", workers: ["codex"], cwd: process.cwd(), workspaceId });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("session timeout")), 2_000);
      const poll = () => session.status !== "running" ? (clearTimeout(deadline), resolve()) : setTimeout(poll, 5);
      poll();
    });
  }
  const byWorkspace = (workspaceId: string) => calls.filter((call) => call.usageContext?.workspaceId === workspaceId).map((call) => [call.agent, call.accountDir]);
  const work = byWorkspace("work");
  assert.ok(work.some(([agent, dir]) => agent === "claude" && dir === "/acc/claude-work"), JSON.stringify(work));
  assert.ok(work.some(([agent, dir]) => agent === "codex" && dir === "/acc/codex-work"), JSON.stringify(work));
  assert.ok(work.every(([agent, dir]) => dir === (agent === "claude" ? "/acc/claude-work" : agent === "codex" ? "/acc/codex-work" : undefined)));
  const home = byWorkspace("home");
  assert.ok(home.length > 0);
  assert.ok(home.every(([, dir]) => dir === undefined), JSON.stringify(home));
});

test("router and limit runs get the account of the workspace they run for", async () => {
  const seen: (string | undefined)[] = [];
  const policy = (id: string) => normalizeWorkspacePolicy(id === "work" ? { accounts: { grok: "/acc/grok" } } : {});
  const runner = withWorkspaceAccounts(async (options) => { seen.push(options.accountDir); return { exitCode: 0, finalText: "" }; }, policy);
  const base = { prompt: ".", cwd: "/", onLine: () => undefined } as const;
  await runner({ ...base, agent: "grok", usageContext: { workspaceId: "work", sessionId: "s", role: "router" } });
  await runner({ ...base, agent: "claude", usageContext: { workspaceId: "work", sessionId: "s", role: "router" } });
  await runner({ ...base, agent: "grok", usageContext: { workspaceId: "home", sessionId: "s", role: "router" } });
  await runner({ ...base, agent: "grok" });
  await runner({ ...base, agent: "grok", accountDir: "/explicit", usageContext: { workspaceId: "work", sessionId: "s", role: "router" } });
  assert.deepEqual(seen, ["/acc/grok", undefined, undefined, undefined, "/explicit"]);
});

test("limits are kept per account: a workspace sees its own login's, others the default's", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-account-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const window = (remainingPercent: number) => [{ key: "five_hour", label: "5시간", remainingPercent }];
  await saveProviderQuota({ agent: "claude", windows: window(90), updatedAt: "2026-11-01T00:00:00.000Z" }, directory);
  await saveProviderQuota({ agent: "claude", windows: window(5), updatedAt: "2026-11-01T00:00:00.000Z", account: "/acc/claude-work" }, directory);
  const stored = JSON.parse(await readFile(join(directory, "provider-limits.json"), "utf8"));
  assert.equal(stored.length, 2, "one entry per account");
  const claude = async (accounts?: Record<string, string>) => (await loadProviderQuotas(directory, directory, accounts)).find((item) => item.agent === "claude");
  assert.equal((await claude())?.windows[0]?.remainingPercent, 90);
  assert.equal((await claude({ claude: "/acc/claude-work" }))?.windows[0]?.remainingPercent, 5);
  assert.deepEqual((await claude({ claude: "/acc/never-used" }))?.windows, [], "an account with no run yet has no limits yet");
});

test("skills are read from the workspace's account folders in place of the default ones", async (t) => {
  const account = await mkdtemp(join(tmpdir(), "sinawi-account-skills-"));
  t.after(() => rm(account, { recursive: true, force: true }));
  await mkdir(join(account, "skills", "work-only"), { recursive: true });
  await writeFile(join(account, "skills", "work-only", "SKILL.md"), "---\nname: work-only-skill\ndescription: only in the work account\n---\nbody\n");
  const withAccount = await loadSkills(account, true, { claude: account });
  assert.ok(withAccount.some((skill) => skill.name === "work-only-skill" && skill.agents.includes("claude")));
  const without = await loadSkills(account, true);
  assert.equal(without.some((skill) => skill.name === "work-only-skill"), false, "the default login does not see it");
});
