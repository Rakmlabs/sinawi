import assert from "node:assert/strict";
import test from "node:test";
import { buildInvocation, CLAUDE_READ_TOOLS, GROK_READ_TOOLS, meaningfulStderr, normalizeCliLine, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import type { Session } from "./types.js";

async function waitUntilSettled(session: Session, timeoutMs = 5_000) {
  const started = Date.now();
  while (session.status === "running") {
    if (Date.now() - started > timeoutMs) throw new Error("session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Regression: the verification run after workers finished was launched with zero tools while its
// prompt asked it to read files. Claude then streamed fake `<invoke name="Read">` markup as plain text
// for 10+ minutes until the inactivity watchdog killed the session; Grok rejected finished work.
test("read-only review runs keep read tools; plain read-only runs stay tool-free", () => {
  const claude = buildInvocation({ agent: "claude", prompt: "review", cwd: "/tmp/p", readOnly: true, readTools: true });
  const toolsAt = claude.args.indexOf("--tools");
  assert.deepEqual(claude.args.slice(toolsAt + 1, toolsAt + 1 + CLAUDE_READ_TOOLS.length), [...CLAUDE_READ_TOOLS]);
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(!claude.args.includes("Edit") && !claude.args.includes("Write"));
  const allowed = claude.args.filter((arg) => arg.startsWith("Bash("));
  assert.ok(allowed.includes("Bash(git diff:*)"));
  assert.ok(!allowed.some((rule) => /npm install|rm|mkdir/.test(rule)));

  const grok = buildInvocation({ agent: "grok", prompt: "review", cwd: "/tmp/p", readOnly: true, readTools: true });
  assert.equal(grok.args[grok.args.indexOf("--tools") + 1], GROK_READ_TOOLS);
  assert.equal(grok.args[grok.args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(!GROK_READ_TOOLS.includes("search_replace") && !GROK_READ_TOOLS.includes("run_terminal_command"));

  // Router / status runs (readOnly without readTools) are unchanged.
  const plainClaude = buildInvocation({ agent: "claude", prompt: "route", cwd: "/tmp/p", readOnly: true });
  assert.equal(plainClaude.args[plainClaude.args.indexOf("--tools") + 1], "");
  const plainGrok = buildInvocation({ agent: "grok", prompt: "route", cwd: "/tmp/p", readOnly: true });
  assert.deepEqual(plainGrok.args.slice(-5), ["--tools", "", "--deny", "*", "--disable-web-search"]);
});

test("the orchestrator's verification run asks for read tools, workers do not run read-only", async () => {
  const calls: Array<Pick<RunCliOptions, "agent" | "readOnly" | "readTools">> = [];
  const runner = async (options: RunCliOptions) => {
    calls.push({ agent: options.agent, readOnly: options.readOnly, readTools: options.readTools });
    const text = calls.length === 1 ? '<<DELEGATE to="codex">>Add add()<</DELEGATE>>' : calls.length === 2 ? "worker done" : "verified";
    options.onLine({ type: "message", text, finalText: text });
    return { exitCode: 0, finalText: text };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "Delegate add()", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.equal(session.status, "done");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].readOnly, false);
  assert.deepEqual(calls[2], { agent: "claude", readOnly: true, readTools: true });
  assert.ok(session.events.some((event) => event.type === "message" && event.text === "verified"));
});

test("a watchdog stop names the silent step instead of a bare message", async () => {
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    options.onLine({ type: "tool", text: "명령: npm test" });
    options.signal?.addEventListener("abort", () => resolve({ exitCode: 143, finalText: "" }), { once: true });
  });
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 30);
  const session = await orchestra.create({ prompt: "Silent task", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.equal(session.status, "error");
  const text = session.events.at(-1)?.text ?? "";
  assert.match(text, /새 이벤트가 없어 작업을 중단했습니다/);
  assert.match(text, /마지막 기록: Claude — 명령: npm test/);
});

test("Codex quota failures read as one human message, not raw JSON plus a stdin notice", () => {
  const failed = normalizeCliLine("codex", JSON.stringify({ type: "turn.failed", error: { message: "You’ve hit your usage limit. Try again later." } }));
  assert.deepEqual(failed.map((line) => [line.type, line.text]), [["error", "You’ve hit your usage limit. Try again later."]]);
  assert.equal(meaningfulStderr("Reading additional input from stdin...\n"), "");
  assert.equal(meaningfulStderr("Reading additional input from stdin...\nError: auth expired\n"), "Error: auth expired");
});
