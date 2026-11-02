import assert from "node:assert/strict";
import test from "node:test";
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
  const commands = ["git", "gh", "ls", "cat", "rg", "find", "npm", "pnpm", "yarn", "node", "npx", "tsc", "du", "wc", "head", "tail", "ao-browser", "ffprobe", "ffmpeg", "python3", "mkdir", "file", "stat", "sips", "pwd", "echo", "sort", "jq", "ao-computer"];
  const rules = commands.map((command) => `Bash(${command}:*)`);

  const claude = buildInvocation({ agent: "claude", prompt: "fix", cwd: "/tmp/project" });
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--allowedTools") + 1, claude.args.indexOf("--allowedTools") + 1 + rules.length), rules);
  assert.equal(claude.args.includes("bypassPermissions"), false);

  const grok = buildInvocation({ agent: "grok", prompt: "fix", cwd: "/tmp/project" });
  assert.equal(grok.args[grok.args.indexOf("--permission-mode") + 1], "auto");
  assert.deepEqual(grok.args.filter((_value, index) => grok.args[index - 1] === "--allow"), rules);
  assert.equal(grok.args.includes("--always-approve"), false);
  assert.equal(grok.args.includes("bypassPermissions"), false);
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
