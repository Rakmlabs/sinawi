import assert from "node:assert/strict";
import test from "node:test";
import { DEVELOPMENT_SHELL_PROGRAMS } from "./supervision.js";
import { buildInvocation, normalizeCliLine, prepareCliInvocation } from "./cli.js";

test("buildInvocation passes Codex model and reasoning effort with verified flags", () => {
  const invocation = buildInvocation({ agent: "codex", prompt: "fix it", cwd: "/tmp/project", model: "test-model", reasoningEffort: "high" });
  assert.equal(invocation.command.endsWith("codex"), true);
  assert.deepEqual(invocation.args, ["exec", "--json", "--sandbox", "workspace-write", "-C", "/tmp/project", "--skip-git-repo-check", "--model", "test-model", "-c", 'model_reasoning_effort="high"', "fix it"]);
});

test("buildInvocation passes Claude effort and omits unsupported Grok effort", () => {
  const claude = buildInvocation({ agent: "claude", prompt: "plan", cwd: "/tmp/project", reasoningEffort: "xhigh" });
  assert.equal(claude.args.includes("--effort"), true);
  assert.equal(claude.args[claude.args.indexOf("--effort") + 1], "xhigh");
  const grok = buildInvocation({ agent: "grok", prompt: "plan", cwd: "/tmp/project", reasoningEffort: "high" });
  assert.equal(grok.args.includes("--effort"), false);
});

test("buildInvocation grants non-read-only Claude and Grok runs only the common development commands", () => {
  // Programs that run code given to them are pre-approved only where the workspace allows it (H2);
  // git and gh only by subcommand, so `git -c …`, aliases and gh extensions are not.
  const rules = DEVELOPMENT_SHELL_PROGRAMS.map((command) => `Bash(${command}:*)`);
  for (const rule of ["Bash(git status:*)", "Bash(git commit:*)", "Bash(gh pr view:*)", "Bash(ao-serve list:*)", "Bash(curl:*)"]) assert.ok(rules.includes(rule), rule);
  for (const rule of ["Bash(git:*)", "Bash(gh:*)", "Bash(gh pr:*)", "Bash(gh issue:*)", "Bash(gh run:*)", "Bash(npm:*)", "Bash(pnpm:*)", "Bash(yarn:*)", "Bash(find:*)", "Bash(ao-serve:*)", "Bash(ao-serve start:*)", "Bash(node:*)"]) assert.ok(!rules.includes(rule), rule);

  const claude = buildInvocation({ agent: "claude", prompt: "fix", cwd: "/tmp/project" });
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--allowedTools") + 1, claude.args.indexOf("--allowedTools") + 1 + rules.length), rules);
  assert.equal(claude.args.includes("bypassPermissions"), false);

  const grok = buildInvocation({ agent: "grok", prompt: "fix", cwd: "/tmp/project" });
  assert.equal(grok.args[grok.args.indexOf("--permission-mode") + 1], "auto");
  assert.deepEqual(grok.args.filter((_value, index) => grok.args[index - 1] === "--allow"), rules);
  assert.equal(grok.args.includes("--always-approve"), false);
  assert.equal(grok.args.includes("bypassPermissions"), false);
  assert.match(grok.args[grok.args.indexOf("--rules") + 1], /node, npx, python3, npm, pnpm, yarn, find and ao-serve start are not pre-approved here/u);

  // The workspace's opt-in adds them, for both CLIs.
  const runtime = [...rules, ...["node", "npx", "python3", "npm", "pnpm", "yarn", "find", "ao-serve start"].map((command) => `Bash(${command}:*)`)];
  const claudeOn = buildInvocation({ agent: "claude", prompt: "fix", cwd: "/tmp/project", runtimePrograms: true });
  assert.deepEqual(claudeOn.args.slice(claudeOn.args.indexOf("--allowedTools") + 1, claudeOn.args.indexOf("--allowedTools") + 1 + runtime.length), runtime);
  const grokOn = buildInvocation({ agent: "grok", prompt: "fix", cwd: "/tmp/project", runtimePrograms: true });
  assert.deepEqual(grokOn.args.filter((_value, index) => grokOn.args[index - 1] === "--allow"), runtime);
  assert.match(grokOn.args[grokOn.args.indexOf("--rules") + 1], /python3/u);

  // Third review: Grok's auto mode ran what its classifier liked (N3) and `rg --pre ./x`, `curl -o <outside>`
  // under the plain prefix rules (H2-c). Off, code runners and their wrappers are denied; risky forms always.
  const denied = (args: string[]) => args.filter((_value, index) => args[index - 1] === "--deny");
  for (const rule of ["Bash(node:*)", "Bash(bash:*)", "Bash(env:*)", "Bash(python3:*)", "Bash(rg *--pre*)", "Bash(curl * -o*)", "Bash(gh api * -X*)", "Bash(git push *--force*)", "Bash(xcrun simctl spawn*)"]) assert.ok(denied(grok.args).includes(rule), rule);
  assert.ok(!denied(grokOn.args).includes("Bash(node:*)"), "the workspace's opt-in lifts the code-runner denials");
  assert.ok(denied(grokOn.args).includes("Bash(rg *--pre*)"), "risky forms stay denied");
  // Fourth review R4-1: a flag as the first argument (`sort -o <outside>` ran under `sort * -o*` alone).
  for (const rule of ["Bash(sort -o*)", "Bash(gh api -X*)", "Bash(gh api -f*)", "Bash(curl -o*)", "Bash(curl -O*)", "Bash(git push -f*)"]) {
    assert.ok(denied(grok.args).includes(rule), rule);
    assert.ok(denied(grokOn.args).includes(rule), rule);
  }
  // Fifth review R5-1/R5-2: options that run a program, abbreviated or not, are denied either way.
  const matches = (rule: string, command: string) => new RegExp(`^${rule.slice(5, -1).replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(command);
  for (const command of ["sort --compress-program=./x a.txt", "sort -S 100K --compress-prog ./x a.txt", "sort --co=./x a.txt", "git fetch --upload-pack=./x .", "git fetch --upl=./x .", "git push --receive-pack=./x . HEAD", "git --exec-path=. status", "rg --pre=./x hi .", "rg --pre-glob '*' --pre ./x hi", "GIT_PAGER=./x git log"]) {
    assert.ok(denied(grok.args).some((rule) => matches(rule, command)), command);
    assert.ok(denied(grokOn.args).some((rule) => matches(rule, command)), `${command} (on)`);
  }
  // Sixth review R6-4: what others see on GitHub is denied to Grok either way; reading is not.
  for (const command of ["gh pr merge 7 --squash", "gh pr close 7", "gh pr review 7 --approve", "gh pr comment 7 -b hi", "gh pr create -t x -b y", "gh issue create -t x", "gh issue comment 3 -b hi", "gh run rerun 1", "gh run cancel 1",
    // PR #8 review P8-1: aliases, newer subcommands, a flag before the subcommand.
    "gh pr new -t x", "gh issue new -t x", "gh pr revert 1", "gh pr update-branch 1", "gh pr -R o/r merge 1", "gh pr --repo o/r merge 1", "gh issue -R o/r comment 1 -b x", "gh co 7", "gh pr co 7", "gh agent create x", "gh agents list", "gh at verify x", "gh rs list", "gh release create v1", "gh api graphql -f query=x", "gh api -H X-HTTP-Method-Override:DELETE repos/o/r"]) {
    assert.ok(denied(grok.args).some((rule) => matches(rule, command)), command);
    assert.ok(denied(grokOn.args).some((rule) => matches(rule, command)), `${command} (on)`);
  }
  for (const command of ["gh pr view 7", "gh pr checks 7", "gh pr list", "gh issue list", "gh run view 1", "gh pr view 7 -R o/r", "gh api repos/o/r/pulls"]) assert.ok(!denied(grok.args).some((rule) => matches(rule, command)), command);
  // Fourth review R4-2: text the shell only resolves when it runs ("no""de", n''ode, $(which node), chains)
  // is denied while the switch is off; real Grok 1.0.92 refused each of these forms by these rules.
  for (const rule of ["Bash(*$*)", "Bash(*`*)", "Bash(*;*)", "Bash(*|*)", "Bash(*>*)", 'Bash(*""*)', "Bash(*''*)", "Bash(*\\*)", 'Bash("*)']) {
    assert.ok(denied(grok.args).includes(rule), rule);
    assert.ok(!denied(grokOn.args).includes(rule), `${rule}: lifted by the workspace's opt-in`);
  }
  assert.ok(!rules.includes("Bash(xcrun simctl:*)") && rules.includes("Bash(xcrun simctl list:*)"), "simctl by subcommand, never spawn");
  assert.equal(denied(buildInvocation({ agent: "grok", prompt: "fix", cwd: "/tmp/project", fullAccess: true }).args).length, 0, "full access denies nothing extra");
});

test("buildInvocation enforces a tool-free read-only profile for every planner CLI", () => {
  const codex = buildInvocation({ agent: "codex", prompt: "plan", cwd: "/tmp/project", readOnly: true });
  assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");

  const claude = buildInvocation({ agent: "claude", prompt: "plan", cwd: "/tmp/project", readOnly: true });
  const planAt = claude.args.indexOf("--permission-mode");
  assert.deepEqual(claude.args.slice(planAt - 5, planAt + 2), ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "plan"]);
  // No tool is denied unless the workspace or the tools panel says so.
  assert.deepEqual(claude.args.slice(planAt + 2), []);

  const grok = buildInvocation({ agent: "grok", prompt: "plan", cwd: "/tmp/project", readOnly: true });
  assert.deepEqual(grok.args.slice(-7), ["--tools", "", "--disallowed-tools", "search_tool,use_tool", "--deny", "*", "--disable-web-search"]);
});

test("buildInvocation omits unsupported Grok auto-update flag", () => {
  const invocation = buildInvocation({ agent: "grok", prompt: "review", cwd: "/tmp/project" });
  assert.deepEqual(invocation.args.slice(0, 6), ["-p", "review", "--output-format", "streaming-json", "--cwd", "/tmp/project"]);
  assert.equal(invocation.args.includes("--no-auto-update"), false);
});

test("normalizes Claude and Grok permission denials into visible warnings", () => {
  const claude = normalizeCliLine("claude", JSON.stringify({
    type: "tool_result", is_error: true,
    command: "git status",
    content: "Permission to use Bash has been denied",
  }));
  assert.deepEqual(claude, [{ type: "warning", text: "권한 거부: git status", sessionId: undefined }]);

  const grok = normalizeCliLine("grok", JSON.stringify({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "grok-1", update: { sessionUpdate: "tool_call_update", toolCall: {
      title: "npm test", status: "failed", content: "DENIED by permission rule",
    } } },
  }));
  assert.deepEqual(grok, [{ type: "warning", text: "권한 거부: npm test", sessionId: "grok-1" }]);

  assert.equal(normalizeCliLine("codex", JSON.stringify({ type: "error", command: "git status", message: "permission denied" }))[0]?.type, "error");
});

test("normalizes runtime-style raw and text-envelope denials without flagging ordinary discussion", () => {
  assert.deepEqual(normalizeCliLine("claude", "Permission denied: git status"), [
    { type: "warning", text: "권한 거부: git status" },
  ]);
  assert.deepEqual(normalizeCliLine("grok", "DENIED: rg TODO src"), [
    { type: "warning", text: "권한 거부: rg TODO src" },
  ]);
  assert.deepEqual(normalizeCliLine("grok", JSON.stringify({
    type: "text", data: "DENIED by permission rule: npm test",
  })), [
    { type: "warning", text: "권한 거부: npm test", sessionId: undefined },
  ]);

  const discussion = "The documentation explains why a permission denied error can happen.";
  assert.deepEqual(normalizeCliLine("claude", discussion), [
    { type: "message", text: discussion, finalText: discussion, appendFinal: true },
  ]);
});

test("normalizes nested Claude tool-result permission failures", () => {
  for (const content of ["Permission denied", "Permission request rejected"]) {
    const result = normalizeCliLine("claude", JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_result", is_error: true, content, command: "git status" }] },
    }));
    assert.deepEqual(result, [{ type: "warning", text: "권한 거부: git status", sessionId: undefined }]);
  }
});

test("Grok invocations with workspace-locked tools deny them after installing the project guard", async () => {
  const guarded: Array<[string, readonly string[]]> = [];
  const invocation = await prepareCliInvocation({
    agent: "grok", prompt: "research", cwd: "/tmp/team", blockedMcp: ["mcp__existing__*"], lockedMcp: ["media-tool"],
    usageContext: { workspaceId: "team", sessionId: "session", role: "worker" },
  }, async (cwd, names) => { guarded.push([cwd, names]); });

  assert.deepEqual(guarded, [["/tmp/team", ["media-tool"]]]);
  assert.deepEqual(invocation.args.slice(-4), ["--deny", "mcp__existing__*", "--deny", "mcp__media-tool__*"]);
});

test("runs without locked tools omit project guards whatever the workspace id; Claude only gets explicit blocks", async () => {
  const guarded: string[] = [];
  const guard = async (cwd: string) => { guarded.push(cwd); };
  const companyGrok = await prepareCliInvocation({
    agent: "grok", prompt: "research", cwd: "/tmp/company",
    usageContext: { workspaceId: "company", sessionId: "company", role: "orchestrator" },
  }, guard);
  const lockedClaude = await prepareCliInvocation({
    agent: "claude", prompt: "plan", cwd: "/tmp/team", lockedMcp: ["media-tool"],
    usageContext: { workspaceId: "team", sessionId: "team", role: "orchestrator" },
  }, guard);

  assert.deepEqual(guarded, []);
  assert.equal(companyGrok.args.join(" ").includes("mcp__"), false);
  assert.equal(lockedClaude.args.includes("--deny"), false);
  const denied = lockedClaude.args.flatMap((arg, index) => lockedClaude.args[index - 1] === "--disallowedTools" ? [arg] : []);
  assert.deepEqual(denied, ["mcp__media-tool__*"]);
  const plain = buildInvocation({ agent: "claude", prompt: "plan", cwd: "/tmp/personal" });
  assert.equal(plain.args.includes("--disallowedTools"), false);
  const extra = buildInvocation({ agent: "claude", prompt: "plan", cwd: "/tmp/personal", blockedMcp: ["mcp__example__*", "mcp__example__*"] });
  assert.deepEqual(extra.args.flatMap((arg, index) => extra.args[index - 1] === "--disallowedTools" ? [arg] : []), ["mcp__example__*"]);
  const codex = await prepareCliInvocation({ agent: "codex", prompt: "plan", cwd: "/tmp/team", lockedMcp: ["media-tool"] }, guard);
  assert.ok(codex.args.join(" ").includes('mcp_servers."media-tool".enabled=false'));
  assert.deepEqual(guarded, []);
});

test("normalizes Codex messages and tool calls", () => {
  const message = normalizeCliLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
  assert.deepEqual(message, [{ type: "message", text: "done", finalText: "done", sessionId: undefined }]);
  const tool = normalizeCliLine("codex", JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }));
  assert.equal(tool[0].type, "command");
  assert.deepEqual(JSON.parse(tool[0].text), { type: "command_execution", command: "npm test", status: "in_progress" });
});

test("preserves rejected quota stream events as errors without flagging informational limits", () => {
  const codex = normalizeCliLine("codex", JSON.stringify({
    type: "rate_limit", status: "rejected", message: "You've hit your usage limit. Try again later.",
  }));
  assert.equal(codex.length, 1);
  assert.equal(codex[0]?.type, "error");
  assert.match(codex[0]?.text ?? "", /usage limit/i);

  const claude = normalizeCliLine("claude", JSON.stringify({
    type: "rate_limit_event", status: "rejected", message: "usage limit reached",
  }));
  assert.equal(claude.length, 1);
  assert.equal(claude[0]?.type, "error");
  assert.match(claude[0]?.text ?? "", /usage limit/i);

  const informational = normalizeCliLine("claude", JSON.stringify({
    type: "rate_limit_event", status: "allowed",
    rate_limit_info: { rateLimitType: "five_hour", utilization: 0.2 },
  }));
  assert.deepEqual(informational, []);

  const grok = normalizeCliLine("grok", "HTTP 429: quota exceeded");
  assert.equal(grok[0]?.type, "error");
});

test("preserves complete structured command lifecycle payloads", () => {
  const output = "x".repeat(3_000);
  const result = normalizeCliLine("codex", JSON.stringify({
    type: "item.completed",
    item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: output, exit_code: 1 },
  }));

  assert.equal(result[0].type, "command");
  const payload = JSON.parse(result[0].text);
  assert.equal(payload.id, "cmd-1");
  assert.equal(payload.command, "npm test");
  assert.equal(payload.aggregated_output, output);
  assert.equal(payload.exit_code, 1);
  assert.equal(payload.status, "failed");
});

test("preserves structured file changes and derives completed status", () => {
  const result = normalizeCliLine("codex", JSON.stringify({
    type: "item.completed",
    item: {
      id: "edit-1",
      type: "file_change",
      changes: [
        { path: "src/new.ts", kind: "add" },
        { path: "src/existing.ts", kind: "modify" },
      ],
    },
  }));

  assert.equal(result[0].type, "edit");
  assert.deepEqual(JSON.parse(result[0].text), {
    id: "edit-1",
    type: "file_change",
    changes: [
      { path: "src/new.ts", kind: "add" },
      { path: "src/existing.ts", kind: "modify" },
    ],
    status: "completed",
  });
});

test("normalizes Claude result and captures session id", () => {
  const result = normalizeCliLine("claude", JSON.stringify({ type: "result", session_id: "session-1", result: "complete" }));
  assert.equal(result[0].type, "message");
  assert.equal(result[0].finalText, "complete");
  assert.equal(result[0].sessionId, "session-1");
});

test("normalizes Grok ACP message chunks", () => {
  const result = normalizeCliLine("grok", JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }));
  assert.equal(result[0].text, "hello");
  assert.equal(result[0].appendFinal, true);
  assert.equal(result[0].sessionId, "grok-1");
  assert.equal(result[0].finalText, "hello");
});

test("normalizes Claude content blocks into messages and tools", () => {
  const result = normalizeCliLine("claude", JSON.stringify({ type: "assistant", session_id: "claude-1", message: { role: "assistant", content: [
    { type: "text", text: "Checking" },
    { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    { type: "tool_result", content: "passed" },
  ] } }));
  assert.deepEqual(result.map((event) => event.type), ["message", "tool", "tool"]);
  assert.equal(result[1].text, "명령: npm test");
  assert.match(result[2].text, /passed/);
});

test("normalizes Grok ACP tool calls", () => {
  const result = normalizeCliLine("grok", JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-1", update: { sessionUpdate: "tool_call", toolCall: { title: "Run tests", status: "in_progress", content: "npm test" } } } }));
  assert.equal(result[0].type, "tool");
  assert.match(result[0].text, /Run tests/);
});

test("resume invocation uses explicit session IDs for all CLIs", () => {
  for (const agent of ["codex", "claude", "grok"] as const) {
    const { args } = buildInvocation({ agent, prompt: "follow up", cwd: "/tmp", resumeSessionId: "specific-session" });
    if (agent === "codex") assert.deepEqual(args.slice(-3), ["resume", "specific-session", "follow up"]);
    else assert.deepEqual(args.slice(-2), ["--resume", "specific-session"]);
  }
  const events = normalizeCliLine("codex", '{"type":"thread.started","thread_id":"codex-thread"}');
  assert.equal(events[0].sessionId, "codex-thread");
});

test("grok streaming-json text deltas are parsed and noise is dropped", () => {
  assert.deepEqual(normalizeCliLine("grok", '{"type":"available_commands","tools":[]}'), []);
  assert.deepEqual(normalizeCliLine("grok", '{"type":"thought","data":"x"}'), []);
  const [text] = normalizeCliLine("grok", '{"type":"text","data":"Hi"}');
  assert.equal(text.type, "message"); assert.equal(text.text, "Hi"); assert.equal(text.delta, true);
  const end = normalizeCliLine("grok", '{"type":"end","stopReason":"end_turn","sessionId":"s1"}');
  assert.equal(end[0].sessionId, "s1"); assert.equal(end.length, 1);
});

test("grok tool calls show the tool name and a short summary", () => {
  const read = normalizeCliLine("grok", JSON.stringify({ type: "tool_call", toolName: "read_file", title: "read_file", rawInput: { target_file: "/tmp/a.txt" } }));
  assert.equal(read[0].text, "파일 읽기: /tmp/a.txt");
  const cmd = normalizeCliLine("grok", JSON.stringify({ type: "tool_call", toolName: "run_terminal_command", rawInput: { command: "echo ok", description: "x" } }));
  assert.equal(cmd[0].text, "명령: echo ok");
  assert.deepEqual(normalizeCliLine("grok", JSON.stringify({ type: "tool_call_update", content: [], rawOutput: null })), []);
});

test("long tool output keeps the failure tail", () => {
  const body = `${"stdout line\n".repeat(4_000)}Error: element not found\nexit code 1`;
  const [update] = normalizeCliLine("grok", JSON.stringify({ type: "tool_call_update", content: body, sessionId: "s1" }));
  assert.equal(update.type, "tool");
  assert.match(update.text, /^결과: stdout line/);
  assert.match(update.text, /…\[중략\]…/);
  assert.match(update.text, /exit code 1\n\[원문 \d+자, 약 \d+토큰/);
  assert.ok(update.text.length > 40_000);
  assert.ok(update.text.length < 41_000);

  const claudeBody = `${"HEAD\n".repeat(20)}${"x".repeat(50_000)}TAIL_MARKER`;
  const [claude] = normalizeCliLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_result", content: claudeBody }] } }));
  assert.match(claude.text, /^도구 결과: HEAD/);
  assert.match(claude.text, /…\[중략\]…/);
  assert.match(claude.text, /TAIL_MARKER\n\[원문 /);

  const [generic] = normalizeCliLine("codex", JSON.stringify({ type: "tool", name: "Bash", content: claudeBody }));
  assert.match(generic.text, /^Bash: HEAD/);
  assert.match(generic.text, /TAIL_MARKER\n\[원문 /);

  const blob = `${"A".repeat(2_500)}TAIL_EXIT_1`;
  const [error] = normalizeCliLine("codex", JSON.stringify({ type: "error", blob }));
  assert.match(error.text, /…\[중략\]…/);
  assert.match(error.text, /TAIL_EXIT_1"}$/);
  assert.ok(error.text.length <= 2_000);
});

test("text the CLI feeds back in a user turn (skill bodies, tool output) is never a message or final answer", () => {
  const skill = normalizeCliLine("claude", JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /Users/me/.claude/skills/test-driven-development\n\n# TDD\n..." }] },
  }));
  assert.deepEqual(skill.map((line) => [line.type, line.text, line.finalText]), [["tool", "스킬 불러옴: test-driven-development", undefined]]);
  const other = normalizeCliLine("claude", JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hook output" }] } }));
  assert.equal(other[0].type, "tool");
  assert.equal(other[0].finalText, undefined);
  const assistant = normalizeCliLine("claude", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
  assert.deepEqual(assistant.map((line) => [line.type, line.finalText]), [["message", "done"]]);
});
