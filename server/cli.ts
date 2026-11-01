import { cliChildEnv, DEVELOPMENT_SHELL_PROGRAMS } from "./supervision.js";
import { fullPath, resolveCli } from "./cli-path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentId, NormalizedLine } from "./types.js";
import { appendUsage, parseCliUsage, type CliUsageSnapshot, type UsageContext, type UsageStatus } from "./usage.js";
import { parseProviderQuota, saveProviderQuota, type ProviderQuota } from "./quota.js";
import { isQuotaExhaustion } from "./quota-fallback.js";
import { ensureCompanyGrokGuard } from "./grok-mcp-guard.js";

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
  resumeSessionId?: string;
  blockedMcp?: string[];
  usageContext?: UsageContext;
  signal?: AbortSignal;
  onLine: (line: NormalizedLine) => void;
}

function cliName(agent: AgentId): string {
  const configured = {
    codex: process.env.AGENT_ORCHESTRA_CODEX_BIN,
    claude: process.env.AGENT_ORCHESTRA_CLAUDE_BIN,
    grok: process.env.AGENT_ORCHESTRA_GROK_BIN,
  }[agent];
  return configured || resolveCli(agent) || agent;
}

const developmentBashRules = DEVELOPMENT_SHELL_PROGRAMS.map((command) => `Bash(${command}:*)`);
const developmentCommandNames = developmentBashRules.map((rule) => rule.slice(5, -3));
/** Nobody can approve a prompt in headless mode: a non-pre-approved shell command cancels the whole run. */
export const grokHeadlessRules = [
  "You run headless; nobody can approve permission prompts. A shell command that is not pre-approved CANCELS YOUR WHOLE RUN.",
  `Pre-approved programs: ${developmentCommandNames.join(", ")}.`,
  "Each run_terminal_command must be ONE simple command that starts with one of those programs: no `cd`, no `&&`/`;`/`||` chains, no `VAR=value` assignments, no `$(...)`, no for/while loops, no `bash -c`.",
  "Use absolute paths or paths relative to the working directory instead of cd. Split multi-step work into several separate tool calls; write longer logic to a .py file and run it with python3.",
].join(" ");

export function buildInvocation(options: Omit<RunCliOptions, "signal" | "onLine">): CliInvocation {
  const { agent, prompt, cwd, model, reasoningEffort, readOnly, resumeSessionId, blockedMcp } = options;
  if (agent === "codex") {
    const args = ["exec", "--json", "--sandbox", readOnly ? "read-only" : "workspace-write", "-C", cwd, "--skip-git-repo-check"];
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
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (model) args.push("--model", model);
    if (reasoningEffort) args.push("--effort", reasoningEffort);
    if (readOnly) args.push("--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "plan");
    else args.push("--permission-mode", "acceptEdits", "--allowedTools", ...developmentBashRules);
    const disallowed = [...new Set([...(blockedMcp ?? []), "mcp__bbanana__*"])];
    for (const pattern of disallowed) args.push("--disallowedTools", pattern);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { command: cliName("claude"), args, cwd };
  }

  const args = ["-p", prompt, "--output-format", "streaming-json", "--cwd", cwd];
  if (model) args.push("--model", model);
  if (readOnly) args.push("--tools", "", "--deny", "*", "--disable-web-search");
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

type InvocationOptions = Omit<RunCliOptions, "signal" | "onLine">;
type GrokGuard = (cwd: string) => Promise<void>;

export async function prepareCliInvocation(
  options: InvocationOptions,
  guard: GrokGuard = ensureCompanyGrokGuard,
): Promise<CliInvocation> {
  if (options.agent !== "grok") return buildInvocation(options);
  if (options.usageContext?.workspaceId !== "company") return buildInvocation(options);
  await guard(options.cwd);
  return buildInvocation({
    ...options,
    blockedMcp: [...new Set([...(options.blockedMcp ?? []), "mcp__bbanana__*"])],
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
    return [{ type: "error", text: content || clippedJson(data), sessionId }];
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
        if (text) normalized.push({ type: "message", text, finalText: text, sessionId });
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
  return groups.length;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last chance on any exit (crash, process.exit): unref'd escalation timers never fire after this.
  process.once("exit", () => killCliProcessGroups("SIGKILL"));
}

export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
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
      env: cliChildEnv(process.env, { PATH: fullPath(), CI: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let finalText = "";
    let sessionId: string | undefined;
    let stderr = "";
    let deltaBuffer = "";
    const flushDelta = () => {
      if (!deltaBuffer.trim()) { deltaBuffer = ""; return; }
      const text = deltaBuffer;
      deltaBuffer = "";
      options.onLine({ type: "message", text, finalText: text });
    };
    const output = createInterface({ input: child.stdout });
    output.on("line", (raw) => {
      const reported = parseCliUsage(options.agent, raw);
      if (reported) usage = { ...usage, ...reported };
      const quota = parseProviderQuota(options.agent, raw);
      if (quota) {
        providerQuota = options.agent === "codex" ? { ...quota, source: "codex-stream" } : quota;
        if (options.usageContext) providerQuotaSave = saveProviderQuota(providerQuota, options.usageContext.dataDir).catch(() => undefined);
      }
      for (const normalized of normalizeCliLine(options.agent, raw)) {
        if (normalized.finalText) finalText = normalized.appendFinal ? finalText + normalized.finalText : normalized.finalText;
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (normalized.delta) { deltaBuffer += normalized.text; continue; }
        if (normalized.type !== "message") flushDelta();
        options.onLine(normalized);
      }
    });
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
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      if (!aborted) clearEscalation();
      releaseGroup();
      options.signal?.removeEventListener("abort", abort);
      const exitCode = code ?? 1;
      flushDelta();
      if (exitCode !== 0 && stderr.trim()) {
        options.onLine({ type: "error", text: stderr.trim().slice(-4_000) });
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
