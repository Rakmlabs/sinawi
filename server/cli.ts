import { ensurePermissionServerScript, PERMISSION_TOOL, PROMPT_TIMEOUT_MS, permissionMcpConfig, registerRunActivity, unregisterRunActivity } from "./permission-prompts.js";
import { cliChildEnv, DEVELOPMENT_SHELL_PROGRAMS } from "./supervision.js";
import { fullPath, resolveCli } from "./cli-path";
import { envVar } from "./runtime.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentId, NormalizedLine } from "./types.js";
import { appendUsage, parseCliUsage, type CliUsageSnapshot, type UsageContext, type UsageStatus } from "./usage.js";
import { parseProviderQuota, saveProviderQuota, type ProviderQuota } from "./quota.js";
import { isQuotaExhaustion } from "./quota-fallback.js";
import { ensureGrokMcpGuard } from "./grok-mcp-guard.js";
import { bashHookSettings, ensureBashHookScript } from "./claude-bash-hook.js";
import { computerRunEnv, revokeComputerToken } from "./computer-tokens.js";

export interface CliInvocation {
  command: string;
  args: string[];
  cwd: string;
}

export interface RunCliOptions {
  agent: AgentId;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  readOnly?: boolean;
  /**
   * With readOnly: keep read/search tools instead of none. A reviewer told to "verify by reading files"
   * but given zero tools writes fake tool-call markup as plain text in a loop (Claude) or rejects
   * finished work it cannot inspect (Grok), so the run never ends with an answer.
   */
  readTools?: boolean;
  /** No approval prompts for this run (the workspace's opt-in "full access"); ignored when read-only. */
  fullAccess?: boolean;
  resumeSessionId?: string;
  blockedMcp?: string[];
  /** MCP servers the workspace locks off; Grok also gets them disabled in the project config. */
  lockedMcp?: string[];
  usageContext?: UsageContext;
  signal?: AbortSignal;
  /** How long to wait for stdout to drain after the CLI exits before giving up on it (tests shorten it). */
  exitGraceMs?: number;
  /** How long a CLI may linger after its end-of-turn line before it is told to exit. */
  turnEndGraceMs?: number;
  /** Folders outside `cwd` the run may read (e.g. worker worktrees a reviewer checks). */
  extraDirs?: string[];
  /**
   * Folders the run may read but must not edit: a worktree worker's main checkout, which holds the
   * uncommitted docs and node_modules its worktree lacks. Claude needs them granted; edits are denied.
   */
  readOnlyDirs?: string[];
  /**
   * `--mcp-config` JSON for Sinawi's permission server (see permission-prompts.ts); set by runCli
   * for writable Claude runs. Claude then asks the user through the app instead of refusing.
   */
  permissionMcp?: string;
  /** `--settings` JSON for Claude (the Bash pre-approval hook); set by prepareCliInvocation. */
  claudeSettings?: string;
  /**
   * Long flags the installed Claude Code lists in `--help` (see claudeHelpFlags). When set, optional
   * flags it lacks (`--include-partial-messages`, `--settings`) are left out instead of making an
   * older CLI fail on an unknown option. Unset = assume a current CLI.
   */
  claudeFlags?: ReadonlySet<string>;
  /**
   * Called for every raw stdout line, including ones that render nothing (partial-message deltas,
   * thinking). Watchdogs use it to tell a quiet run from a dead one. stderr does not count: retry
   * and warning noise there would keep a stuck run "alive" forever. The orchestrator also caps how
   * long activity without any rendered event may last (Orchestra.quietLimitMs).
   */
  onActivity?: () => void;
  onLine: (line: NormalizedLine) => void;
}

function cliName(agent: AgentId): string {
  const configured = {
    codex: envVar("CODEX_BIN"),
    claude: envVar("CLAUDE_BIN"),
    grok: envVar("GROK_BIN"),
  }[agent];
  return configured || resolveCli(agent) || agent;
}

const developmentBashRules = DEVELOPMENT_SHELL_PROGRAMS.map((command) => `Bash(${command}:*)`);
/** Read-only verification profile (see RunCliOptions.readTools). Plan mode still refuses edits. */
export const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export const GROK_READ_TOOLS = "read_file,list_dir,grep";
/** Grok's gateway to MCP servers (find a tool, then call it). */
export const GROK_MCP_TOOLS = "search_tool,use_tool";
/**
 * Pure read commands for the review profile. Nothing here runs project code (no test runners:
 * workers run tests, the reviewer reads their evidence) and nothing writes: the deny rules below
 * (which win over allow rules) remove the flags of these programs that write a file or run another
 * program (`git diff --output=FILE`, external diff/textconv drivers, `rg --pre CMD`).
 */
export const CLAUDE_READ_ONLY_BASH_RULES = ["git diff", "git status", "git log", "git show", "ls", "cat", "rg", "wc", "head", "tail"].map((command) => `Bash(${command}:*)`);
export const CLAUDE_READ_ONLY_BASH_DENY = ["--output", "--ext-diff", "--textconv", "--pre"].map((flag) => `Bash(*${flag}*)`);
const developmentCommandNames = developmentBashRules.map((rule) => rule.slice(5, -3));
/** Nobody can approve a prompt in headless mode: a non-pre-approved shell command cancels the whole run. */
export const grokHeadlessRules = [
  "You run headless; nobody can approve permission prompts. A shell command that is not pre-approved CANCELS YOUR WHOLE RUN.",
  `Pre-approved programs: ${developmentCommandNames.join(", ")}.`,
  "Each run_terminal_command must be ONE simple command that starts with one of those programs: no `cd`, no `&&`/`;`/`||` chains, no `VAR=value` assignments, no `$(...)`, no for/while loops, no `bash -c`.",
  "Use absolute paths or paths relative to the working directory instead of cd. Split multi-step work into several separate tool calls; write longer logic to a .py file and run it with python3.",
].join(" ");

/**
 * The CLI's own end-of-turn line (Claude `result`, Grok `end`). `claude -p` keeps running after it
 * while a background shell it started (dev server, http.server) is alive, so a finished worker
 * looked stuck until the stall detector killed it five minutes later.
 */
export function isTurnEnd(agent: AgentId, raw: string): boolean {
  if (agent === "codex" || !raw.startsWith("{")) return false;
  try {
    const type = (JSON.parse(raw) as { type?: unknown }).type;
    return agent === "claude" ? type === "result" : type === "end";
  } catch { return false; }
}

export function buildInvocation(options: Omit<RunCliOptions, "signal" | "onLine" | "exitGraceMs" | "onActivity">): CliInvocation {
  const { agent, prompt, cwd, model, reasoningEffort, readOnly, readTools, resumeSessionId, blockedMcp } = options;
  const full = Boolean(options.fullAccess && !readOnly);
  const extraDirs = [...new Set(options.extraDirs ?? [])].filter((dir) => dir && dir !== cwd);
  if (agent === "codex") {
    const args = ["exec", "--json", ...(full ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", readOnly ? "read-only" : "workspace-write"]), "-C", cwd, "--skip-git-repo-check"];
    for (const pattern of blockedMcp ?? []) {
      const name = pattern.match(/^mcp__(.+)__\*$/)?.[1];
      if (name) args.push("-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`);
    }
    if (model) args.push("--model", model);
    if (reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    if (resumeSessionId) args.push("resume", resumeSessionId, prompt);
    else args.push(prompt);
    return { command: cliName("codex"), args, cwd };
  }

  if (agent === "claude") {
    const supports = (flag: string) => !options.claudeFlags || options.claudeFlags.has(flag);
    // Partial messages are only a liveness signal (long thinking is otherwise silent); normalizeCliLine drops them.
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...(supports("--include-partial-messages") ? ["--include-partial-messages"] : [])];
    if (model) args.push("--model", model);
    if (reasoningEffort) args.push("--effort", reasoningEffort);
    if (readOnly && readTools) args.push("--tools", ...CLAUDE_READ_TOOLS, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "plan", "--allowedTools", ...CLAUDE_READ_ONLY_BASH_RULES, "--disallowedTools", ...CLAUDE_READ_ONLY_BASH_DENY);
    else if (readOnly) args.push("--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "plan");
    else if (full) args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "acceptEdits", "--allowedTools", ...developmentBashRules);
    if (!readOnly && !full && options.claudeSettings && supports("--settings")) args.push("--settings", options.claudeSettings);
    for (const dir of extraDirs) args.push("--add-dir", dir);
    for (const dir of new Set(options.readOnlyDirs ?? [])) {
      if (!dir || dir === cwd || extraDirs.includes(dir)) continue;
      // `//path` is an absolute path in Claude permission rules.
      args.push("--add-dir", dir);
      for (const tool of ["Edit", "Write", "NotebookEdit"]) args.push("--disallowedTools", `${tool}(/${dir}/**)`);
    }
    for (const pattern of new Set(blockedMcp ?? [])) args.push("--disallowedTools", pattern);
    // A hidden (SDK) flag, so `--help` never lists it; every Claude Code that has --settings has it.
    if (!readOnly && !full && options.permissionMcp) args.push("--mcp-config", options.permissionMcp, "--permission-prompt-tool", PERMISSION_TOOL);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { command: cliName("claude"), args, cwd };
  }

  const args = ["-p", prompt, "--output-format", "streaming-json", "--cwd", cwd];
  if (model) args.push("--model", model);
  // Grok rejects extra directories ("additionalDirectories is not supported"); its read tools take
  // absolute paths, so the worktree paths in the review note are enough.
  // MCP tools stay on unless removed: the reviewer reached for a shell through them, which cancels a headless run.
  if (readOnly && readTools) args.push("--tools", GROK_READ_TOOLS, "--disallowed-tools", GROK_MCP_TOOLS, "--permission-mode", "plan", "--disable-web-search");
  else if (readOnly) args.push("--tools", "", "--disallowed-tools", GROK_MCP_TOOLS, "--deny", "*", "--disable-web-search");
  else if (full) args.push("--permission-mode", "bypassPermissions", "--always-approve");
  else {
    // Headless Grok cancels the whole run when a command isn't pre-allowed (e.g. `cd x && ffprobe`);
    // "auto" lets its safety classifier approve routine commands while deny rules still apply.
    args.push("--permission-mode", "auto");
    for (const rule of developmentBashRules) args.push("--allow", rule);
    args.push("--rules", grokHeadlessRules);
  }
  for (const pattern of blockedMcp ?? []) args.push("--deny", pattern);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return { command: cliName("grok"), args, cwd };
}

type InvocationOptions = Omit<RunCliOptions, "signal" | "onLine" | "exitGraceMs" | "turnEndGraceMs" | "onActivity">;
type GrokGuard = (cwd: string, names: readonly string[]) => Promise<void>;
type ClaudeFlagProbe = (command: string) => Promise<ReadonlySet<string> | undefined>;

/**
 * Long options listed in a CLI's `--help` text (`--foo`, `--foo-bar`, aliases after a comma).
 * Undefined when the text does not look like Claude Code's help (no `--output-format`), so a
 * failed or unexpected probe never strips flags from a CLI that has them.
 */
export function parseHelpFlags(help: string): ReadonlySet<string> | undefined {
  const flags = new Set<string>();
  for (const line of help.split("\n")) {
    // Option lines start with the flag list; descriptions may mention other flags, which still exist.
    for (const match of line.matchAll(/(?:^|[\s,(])(--[A-Za-z][A-Za-z0-9-]*)/gu)) flags.add(match[1]);
  }
  return flags.has("--output-format") ? flags : undefined;
}

const claudeFlagCache = new Map<string, Promise<ReadonlySet<string> | undefined>>();

/** `claude --help`, parsed once per binary path and cached for the life of the server. */
export function claudeHelpFlags(command: string): Promise<ReadonlySet<string> | undefined> {
  let cached = claudeFlagCache.get(command);
  if (!cached) {
    cached = new Promise((resolve) => {
      execFile(command, ["--help"], { timeout: 5_000, maxBuffer: 1024 * 1024, env: cliChildEnv(process.env, { PATH: fullPath(), CI: "1" }) }, (error, stdout) => {
        resolve(error ? undefined : parseHelpFlags(String(stdout)));
      });
    });
    claudeFlagCache.set(command, cached);
  }
  return cached;
}

export async function prepareCliInvocation(
  options: InvocationOptions,
  guard: GrokGuard = ensureGrokMcpGuard,
  probe: ClaudeFlagProbe = claudeHelpFlags,
): Promise<CliInvocation> {
  if (options.agent === "claude" && !options.claudeFlags) {
    const flags = await probe(cliName("claude")).catch(() => undefined);
    if (flags) options = { ...options, claudeFlags: flags };
  }
  // Writable Claude runs get the Bash pre-approval hook, bounded to their own folder (see claude-bash-hook.ts).
  if (options.agent === "claude" && !options.readOnly && !options.fullAccess && !options.claudeSettings && options.usageContext?.dataDir) {
    const script = await ensureBashHookScript(options.usageContext.dataDir).catch(() => undefined);
    if (script) options = { ...options, claudeSettings: bashHookSettings(script, options.cwd) };
  }
  const locked = [...new Set(options.lockedMcp ?? [])];
  if (!locked.length) return buildInvocation(options);
  if (options.agent === "grok") await guard(options.cwd, locked);
  return buildInvocation({
    ...options,
    blockedMcp: [...new Set([...(options.blockedMcp ?? []), ...locked.map((name) => `mcp__${name}__*`)])],
  });
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return asText(object.text ?? object.content ?? object.message ?? object.output ?? object.delta);
  }
  return String(value);
}

/** Keep both ends. Failures and exit codes usually sit in the tail (Codex `truncate_middle_chars`). */
function clipEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "…[중략]…";
  if (marker.length >= max) return text.slice(0, max);
  const budget = max - marker.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** About 4 characters per token. The note sits after the tail so an exit code stays in the kept ending. */
export const TOOL_RESULT_TOKEN_BUDGET = 10_000;
const TOOL_RESULT_CHAR_BUDGET = TOOL_RESULT_TOKEN_BUDGET * 4;

export function clipToolResult(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TOOL_RESULT_CHAR_BUDGET) return trimmed;
  const clipped = clipEnds(trimmed, TOOL_RESULT_CHAR_BUDGET);
  const tokens = Math.ceil(trimmed.length / 4);
  return `${clipped}\n[원문 ${trimmed.length}자, 약 ${tokens}토큰. 앞뒤 ${TOOL_RESULT_CHAR_BUDGET}자만 남김]`;
}

function clippedJson(value: unknown): string {
  return clipEnds(JSON.stringify(value), 2_000);
}

function structuredEventJson(data: Record<string, any>, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = { ...(payload as Record<string, unknown>) };
  if (!value.status) {
    const wrapperType = String(data.type ?? data.kind ?? "").toLowerCase();
    const exitCode = value.exit_code ?? value.exitCode;
    if (wrapperType.includes("started") || wrapperType.includes("updated")) {
      value.status = "in_progress";
    } else if (wrapperType.includes("completed")) {
      value.status = typeof exitCode === "number" && exitCode !== 0 ? "failed" : "completed";
    }
  }
  return JSON.stringify(value);
}

function nestedString(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedString(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(object)) {
    const found = nestedString(candidate, keys);
    if (found) return found;
  }
  return undefined;
}

function runtimePermissionDenialText(value: string): string | undefined {
  const text = value.trim();
  const patterns = [
    /^(?:error:\s*)?permission denied\s*(?::|-)\s*(.+)$/i,
    /^denied(?: by permission rule)?\s*(?::|-)\s*(.+)$/i,
    /^(?:error:\s*)?(?:bash|shell) command permission denied\s*(?::|-)\s*(.+)$/i,
    /^permission to use (?:bash|shell)(?: with command)?\s+[`"']?(.+?)[`"']?\s+has been denied\.?$/i,
  ];
  for (const pattern of patterns) {
    const command = text.match(pattern)?.[1]?.trim().replace(/^[`"']|[`"']$/g, "");
    if (command) return command;
  }
  return undefined;
}

function nestedStrings(value: unknown, values: string[] = []): string[] {
  if (typeof value === "string") values.push(value);
  else if (Array.isArray(value)) for (const item of value) nestedStrings(item, values);
  else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) nestedStrings(item, values);
  return values;
}

function nestedBoolean(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => nestedBoolean(item, key));
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return object[key] === true || Object.values(object).some((item) => nestedBoolean(item, key));
}

function permissionDenial(data: Record<string, unknown>): string | undefined {
  const strings = nestedStrings(data);
  const explicitCommand = nestedString(data, new Set(["command", "cmd"]));
  for (const value of strings) {
    const parsed = runtimePermissionDenialText(value);
    if (parsed) return explicitCommand ?? parsed;
  }
  const command = explicitCommand ?? nestedString(data, new Set(["title"]));
  const status = nestedString(data, new Set(["status", "stopReason"]));
  const explicitlyFailed = nestedBoolean(data, "is_error") || /^(?:failed|error|denied|rejected|permission_rejected)$/i.test(status ?? "");
  const mentionsDenial = strings.some((value) => /(?:permission[^\n]{0,80}(?:denied|rejected)|(?:denied|rejected)[^\n]{0,80}permission|permission_denied|\bDENIED\b)/i.test(value));
  return explicitlyFailed && mentionsDenial ? command ?? "알 수 없는 명령" : undefined;
}

export function normalizeCliLine(agent: AgentId, rawLine: string): NormalizedLine[] {
  const line = rawLine.trim();
  if (!line) return [];
  let data: Record<string, any>;
  try {
    data = JSON.parse(line);
  } catch {
    if (agent === "grok" || agent === "claude") {
      const deniedCommand = runtimePermissionDenialText(line);
      if (deniedCommand) return [{ type: "warning", text: `권한 거부: ${deniedCommand}` }];
    }
    return isQuotaExhaustion(line)
      ? [{ type: "error", text: line }]
      : [{ type: "message", text: line, finalText: line, appendFinal: true }];
  }

  const sessionId = data.session_id ?? data.thread_id ?? data.sessionId ?? data.params?.sessionId
    ?? (/session|thread/.test(String(data.type ?? "")) ? data.id : undefined);
  // `--include-partial-messages` deltas: liveness only. The whole message still arrives afterwards.
  if (agent === "claude" && data.type === "stream_event") return [];
  if (agent === "grok" || agent === "claude") {
    const deniedCommand = permissionDenial(data);
    if (deniedCommand) return [{ type: "warning", text: `권한 거부: ${deniedCommand}`, sessionId }];
  }

  if (agent === "grok" && typeof data.type === "string") {
    // Grok Build streaming-json: {type:"text"|"thought", data:"..."}, {type:"end", sessionId, stopReason}
    if (data.type === "text" && typeof data.data === "string") return [{ type: "message", text: data.data, finalText: data.data, appendFinal: true, delta: true }];
    if (data.type === "thought" || data.type === "available_commands" || data.type === "usage") return [];
    if (data.type === "tool_call") return [{ type: "tool", text: describeToolCall(data.toolName ?? data.title ?? data.kind, data.rawInput), sessionId: data.sessionId }];
    if (data.type === "tool_call_update") {
      const output = asText(data.content) || asText(data.rawOutput);
      return output ? [{ type: "tool", text: `결과: ${clipToolResult(output)}`, sessionId: data.sessionId }] : [];
    }
    if (data.type === "end") {
      const stop = String(data.stopReason ?? "");
      const lines: NormalizedLine[] = [{ type: "status", text: "CLI 세션 연결됨", sessionId: data.sessionId }];
      if (stop && stop !== "end_turn") lines.push({ type: "error", text: `Grok Build가 중단되었습니다 (${stop}).`, sessionId: data.sessionId });
      return lines;
    }
  }

  const type = [data.type, data.kind, data.item?.type, data.update?.sessionUpdate, data.update?.type, data.params?.update?.sessionUpdate, data.params?.update?.type].filter(Boolean).join(" ").toLowerCase();
  const payload = data.item ?? data.message ?? data.result ?? data.update ?? data.params?.update ?? data;
  const content = asText(payload);

  if (isQuotaExhaustion(data)) {
    // Codex `turn.failed` keeps the message under `error`; show that text, not the raw JSON.
    return [{ type: "error", text: content || asText(data.error) || clippedJson(data), sessionId }];
  }

  const claudeBlocks = data.message?.content;
  if (Array.isArray(claudeBlocks)) {
    const normalized: NormalizedLine[] = [];
    for (const block of claudeBlocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        normalized.push({ type: "tool", text: describeToolCall(block.name, block.input), sessionId });
      } else if (block.type === "tool_result") {
        const raw = asText(block.content);
        normalized.push({ type: "tool", text: `도구 결과: ${raw ? clipToolResult(raw) : clippedJson(block.content)}`, sessionId });
      } else {
        const text = asText(block);
        if (!text) continue;
        // A `user` turn carries what the CLI fed back to the model (a loaded skill body, tool output),
        // never the model's own words, so it must not become a chat message or the final answer.
        if (data.type === "user") {
          const skill = /^Base directory for this skill: (\S+)/u.exec(text)?.[1];
          normalized.push({ type: "tool", text: skill ? `스킬 불러옴: ${skill.split("/").filter(Boolean).at(-1)}` : `도구 결과: ${clipToolResult(text)}`, sessionId });
        } else normalized.push({ type: "message", text, finalText: text, sessionId });
      }
    }
    if (normalized.length) return normalized;
  }

  if (type.includes("error") || data.is_error) {
    return [{ type: "error", text: content || clippedJson(data), sessionId }];
  }
  if (type.includes("tool") || type.includes("function")) {
    const toolCall = data.update?.toolCall ?? data.params?.update?.toolCall ?? data.params?.update;
    const name = data.name ?? data.item?.name ?? data.message?.name ?? toolCall?.title ?? toolCall?.name ?? "도구 실행";
    const rawTool = content || asText(toolCall?.content) || asText(toolCall?.status);
    const toolContent = rawTool ? clipToolResult(rawTool) : "";
    return [{ type: "tool", text: toolContent ? `${name}: ${toolContent}` : String(name), sessionId }];
  }
  if (type.includes("command") || type.includes("exec")) {
    return [{ type: "command", text: structuredEventJson(data, payload) ?? (content || clippedJson(payload)), sessionId }];
  }
  if (type.includes("file") || type.includes("edit") || type.includes("patch")) {
    return [{ type: "edit", text: structuredEventJson(data, payload) ?? (content || clippedJson(payload)), sessionId }];
  }

  const isAssistant = type.includes("assistant") || type.includes("agent_message") || data.role === "assistant" || data.message?.role === "assistant";
  const isResult = type === "result" || type.includes("completed") || type.includes("final") || type === "agent_message";
  if (content && (isAssistant || isResult)) {
    const appendFinal = type.includes("chunk") || type.includes("delta");
    return [{ type: "message", text: content, finalText: isResult || isAssistant ? content : undefined, ...(appendFinal ? { appendFinal: true } : {}), sessionId }];
  }
  if (sessionId) return [{ type: "status", text: "CLI 세션 연결됨", sessionId }];
  return [];
}

/** Codex prints this informational notice on stderr whenever stdin is not a TTY; it is never the failure. */
const STDERR_NOISE = [/^Reading additional input from stdin\.{0,3}$/];

export function meaningfulStderr(stderr: string): string {
  return stderr.split("\n").filter((line) => !STDERR_NOISE.some((pattern) => pattern.test(line.trim()))).join("\n").trim();
}

export interface CliRunResult {
  exitCode: number;
  finalText: string;
  sessionId?: string;
}

/** Kill functions for every CLI process group this server spawned and has not finished reaping. */
const liveCliGroups = new Set<(signal: NodeJS.Signals) => void>();
let exitHookInstalled = false;

/**
 * Signals every CLI process group still owned by this server (shutdown path).
 * Only groups we spawned are targeted: each CLI is its own group leader (detached).
 */
export function killCliProcessGroups(signal: NodeJS.Signals = "SIGTERM"): number {
  const groups = [...liveCliGroups];
  for (const kill of groups) kill(signal);
  let orphans = 0;
  for (const sessionId of [...orphanGroups.keys()]) orphans += killSessionProcessGroups(sessionId, signal);
  return groups.length + orphans;
}

/**
 * Process groups whose CLI already exited but which still have members: background children the
 * CLI left running (dev server, watcher). They are deliberately NOT killed when the run ends (the
 * user may still be using that server); they are kept per session and terminated when the session
 * is deleted (killSessionProcessGroups) or the server shuts down (killCliProcessGroups / exit hook).
 * Key "" holds groups of runs without a session id. A group id could in theory be reused by an
 * unrelated process group after ours died; groups are re-checked (signal 0) before each use and
 * dropped once empty or not ours (EPERM), which keeps that window small.
 */
const orphanGroups = new Map<string, Set<number>>();

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

function trackOrphanGroup(sessionId: string, pgid: number): void {
  if (process.platform === "win32" || !groupAlive(pgid)) return;
  const groups = orphanGroups.get(sessionId) ?? new Set<number>();
  for (const known of groups) if (!groupAlive(known)) groups.delete(known);
  groups.add(pgid);
  orphanGroups.set(sessionId, groups);
  installExitHook();
}

/** Group ids still tracked for a session (tests, diagnostics). Dead groups are dropped first. */
export function sessionProcessGroups(sessionId: string): number[] {
  const groups = orphanGroups.get(sessionId);
  if (!groups) return [];
  for (const pgid of groups) if (!groupAlive(pgid)) groups.delete(pgid);
  if (!groups.size) orphanGroups.delete(sessionId);
  return [...groups];
}

/** Terminates the background process groups a session's CLI runs left behind. Returns how many were signalled. */
export function killSessionProcessGroups(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): number {
  const groups = sessionProcessGroups(sessionId);
  orphanGroups.delete(sessionId);
  let count = 0;
  for (const pgid of groups) {
    try { process.kill(-pgid, signal); count++; } catch { /* already gone */ }
    if (signal !== "SIGKILL") {
      // A dev server that ignores SIGTERM still goes away with its session.
      setTimeout(() => { if (groupAlive(pgid)) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }, 2_000).unref();
    }
  }
  return count;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last chance on any exit (crash, process.exit): unref'd escalation timers never fire after this.
  process.once("exit", () => killCliProcessGroups("SIGKILL"));
}

export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  // SINAWI_SESSION_ID (display) + a per-run SINAWI_COMPUTER_TOKEN: ao-computer is attributed by the token only.
  const computerEnv = computerRunEnv(options.agent, options.usageContext);
  const token = computerEnv.SINAWI_COMPUTER_TOKEN;
  // Writable Claude runs ask the user through the app when a tool needs permission (permission-prompts.ts).
  if (options.agent === "claude" && token && !options.readOnly && !options.fullAccess && !options.permissionMcp && options.usageContext?.dataDir) {
    const script = await ensurePermissionServerScript(options.usageContext.dataDir).catch(() => undefined);
    if (script) options = { ...options, permissionMcp: permissionMcpConfig(script, token) };
  }
  if (token && options.onActivity) registerRunActivity(token, options.onActivity);
  const invocation = await prepareCliInvocation(options);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let usage: CliUsageSnapshot = {};
    let providerQuota: ProviderQuota | undefined;
    let providerQuotaSave: Promise<void> = Promise.resolve();
    let aborted = false;
    let finished = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      // A permission question waits for the user; Claude must not give up on that MCP call first.
      env: cliChildEnv(process.env, { PATH: fullPath(), CI: "1", ...computerEnv, ...(options.permissionMcp ? { MCP_TOOL_TIMEOUT: String(PROMPT_TIMEOUT_MS + 60_000) } : {}) }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let finalText = "";
    let sessionId: string | undefined;
    let stderr = "";
    let deltaBuffer = "";
    let lastErrorText = "";
    const flushDelta = () => {
      if (!deltaBuffer.trim()) { deltaBuffer = ""; return; }
      const text = deltaBuffer;
      deltaBuffer = "";
      options.onLine({ type: "message", text, finalText: text });
    };
    const output = createInterface({ input: child.stdout });
    let turnEndTimer: NodeJS.Timeout | undefined;
    let endedAfterTurn = false;
    output.on("line", (raw) => {
      options.onActivity?.();
      // A resumed Claude first answers queued background-task notifications and ends that turn with
      // its own result line, then works on the prompt: output after a result means it is not done.
      if (turnEndTimer) { clearTimeout(turnEndTimer); turnEndTimer = undefined; }
      if (isTurnEnd(options.agent, raw)) {
        // Only the CLI itself is signalled: background children it started keep running (orphanGroups).
        turnEndTimer = setTimeout(() => { endedAfterTurn = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } }, options.turnEndGraceMs ?? 30_000);
        turnEndTimer.unref();
      }
      const reported = parseCliUsage(options.agent, raw);
      if (reported) usage = { ...usage, ...reported };
      const quota = parseProviderQuota(options.agent, raw);
      if (quota) {
        providerQuota = options.agent === "codex" ? { ...quota, source: "codex-stream" } : quota;
        if (options.usageContext) providerQuotaSave = saveProviderQuota(providerQuota, options.usageContext.dataDir).catch(() => undefined);
      }
      for (const normalized of normalizeCliLine(options.agent, raw)) {
        // Codex reports one failure twice (`error` then `turn.failed`); show it once.
        if (normalized.type === "error") {
          if (normalized.text === lastErrorText) continue;
          lastErrorText = normalized.text;
        }
        if (normalized.finalText) finalText = normalized.appendFinal ? finalText + normalized.finalText : normalized.finalText;
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (normalized.delta) { deltaBuffer += normalized.text; continue; }
        if (normalized.type !== "message") flushDelta();
        options.onLine(normalized);
      }
    });
    // stderr is not activity: a CLI stuck in a retry loop prints there forever (see RunCliOptions.onActivity).
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    const errorOutput = createInterface({ input: child.stderr });
    errorOutput.on("line", (raw) => {
      if (options.agent !== "grok" && options.agent !== "claude") return;
      const deniedCommand = runtimePermissionDenialText(raw);
      if (deniedCommand) options.onLine({ type: "warning", text: `권한 거부: ${deniedCommand}` });
    });

    let escalationTimer: NodeJS.Timeout | undefined;
    const clearEscalation = () => {
      if (escalationTimer) clearTimeout(escalationTimer);
      escalationTimer = undefined;
    };
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (process.platform === "win32" || !child.pid) {
        try { child.kill(signal); } catch { /* already gone */ }
        return;
      }
      try { process.kill(-child.pid, signal); }
      catch (error) {
        // ESRCH: group already empty. Anything else (EPERM): fall back to the direct child only.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try { child.kill(signal); } catch { /* already gone */ }
        }
      }
    };
    const abort = () => {
      aborted = true;
      killProcessGroup("SIGTERM");
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        killProcessGroup("SIGKILL");
        liveCliGroups.delete(killProcessGroup);
      }, 2_000);
      escalationTimer.unref();
    };
    liveCliGroups.add(killProcessGroup);
    installExitHook();
    // Once the run is over and no SIGKILL escalation is pending, the group is no longer ours to signal.
    const releaseGroup = () => { if (!escalationTimer) liveCliGroups.delete(killProcessGroup); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const saveUsage = async (status: UsageStatus) => {
      const context = options.usageContext;
      if (!context) return;
      await appendUsage({
          id: randomUUID(),
          agent: options.agent,
          model: usage.model ?? options.model ?? "CLI 기본 모델",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          role: context.role,
          ...(usage.tokens ? { tokens: usage.tokens } : {}),
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          ...(usage.planLimits ? { planLimits: usage.planLimits } : {}),
          durationMs: Math.max(0, Date.now() - startedAt),
          status,
          timestamp: new Date().toISOString(),
        }, context.dataDir);
      // Quota caching is best-effort and must never change the CLI run result.
      if (providerQuota) await providerQuotaSave;
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      clearEscalation();
      releaseGroup();
      options.signal?.removeEventListener("abort", abort);
      void saveUsage(aborted ? "aborted" : "failed").then(() => {
        reject(new Error(`${options.agent === "codex" ? "Codex" : options.agent === "claude" ? "Claude" : "Grok Build"} CLI를 시작할 수 없습니다${error.code ? ` (${error.code})` : ""}.`));
      }, reject);
    });
    // `close` waits for every holder of stdout/stderr. A background child the CLI left running
    // (dev server, watcher) keeps them open forever, so the run would never end although the CLI
    // already exited. After a short drain window, drop our ends of the pipes so `close` fires.
    // The background child itself keeps running; its group is tracked per session (orphanGroups).
    let exitDrainTimer: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      exitDrainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, options.exitGraceMs ?? 3_000);
      exitDrainTimer.unref();
    });
    child.once("close", (closeCode) => {
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      if (turnEndTimer) clearTimeout(turnEndTimer);
      // The turn was already over when we told the lingering CLI to exit: that is a normal end.
      const code = endedAfterTurn && !aborted ? 0 : closeCode;
      if (token) { revokeComputerToken(token); unregisterRunActivity(token); }
      if (finished) return;
      finished = true;
      if (!aborted) clearEscalation();
      releaseGroup();
      // Aborted runs have a SIGKILL escalation for the whole group; normal exits leave members alive.
      if (!aborted && child.pid) trackOrphanGroup(options.usageContext?.sessionId ?? "", child.pid);
      options.signal?.removeEventListener("abort", abort);
      const exitCode = code ?? 1;
      flushDelta();
      const stderrText = meaningfulStderr(stderr);
      if (exitCode !== 0 && stderrText) {
        options.onLine({ type: "error", text: stderrText.slice(-4_000) });
      } else if (exitCode !== 0 && lastErrorText) {
        // The CLI already explained the failure on stdout; a bare exit-code line adds nothing.
      } else if (exitCode !== 0) {
        options.onLine({ type: "error", text: `CLI가 종료 코드 ${exitCode}로 끝났습니다.` });
      } else if (!aborted && !finalText.trim()) {
        options.onLine({ type: "error", text: "에이전트 응답이 비어 있습니다. CLI 출력 형식을 해석하지 못했을 수 있습니다." });
      }
      void saveUsage(aborted ? "aborted" : exitCode === 0 ? "completed" : "failed").then(() => {
        resolve({ exitCode, finalText, sessionId });
      }, reject);
    });
  });
}

/** Installed = an executable is on PATH or in a known location. Quota/login state is reported separately. */
export async function commandAvailable(agent: AgentId): Promise<boolean> {
  const configured = cliName(agent);
  return Boolean(resolveCli(configured));
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

const toolLabels: Record<string, string> = {
  read_file: "파일 읽기", read: "파일 읽기", Read: "파일 읽기",
  write: "파일 쓰기", Write: "파일 쓰기", write_file: "파일 쓰기",
  edit: "파일 수정", Edit: "파일 수정", MultiEdit: "파일 수정", search_replace: "파일 수정", apply_patch: "파일 수정",
  list_dir: "폴더 보기", LS: "폴더 보기", grep: "검색", Grep: "검색", Glob: "파일 찾기", glob: "파일 찾기",
  run_terminal_command: "명령", Bash: "명령", bash: "명령", shell: "명령", execute: "명령",
  web_search: "웹 검색", WebSearch: "웹 검색", web_fetch: "웹 열기", WebFetch: "웹 열기",
  todo_write: "할 일 정리", TodoWrite: "할 일 정리", spawn_subagent: "하위 작업", Task: "하위 작업",
};

/** "파일 읽기: path", "명령: cmd" style one-liner for a tool call. */
export function describeToolCall(name: unknown, input: unknown) {
  const raw = typeof name === "string" && name ? name : "도구";
  const label = toolLabels[raw] ?? raw;
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const pick = ["command", "cmd", "target_file", "file_path", "path", "target_directory", "pattern", "query", "url", "description", "prompt"]
    .map((key) => args[key]).find((value) => typeof value === "string" && value.trim());
  const detail = typeof pick === "string" ? pick : Array.isArray(args.command) ? args.command.join(" ") : Object.keys(args).length ? clippedJson(args) : "";
  return detail ? `${label}: ${clip(detail.replace(/\s+/g, " ").trim(), 160)}` : label;
}
