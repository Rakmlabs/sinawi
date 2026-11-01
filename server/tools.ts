import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentId, WorkspaceId, WorkspacePolicy } from "./types.js";
import { isToolLocked } from "./workspace-policy.js";

const execFileAsync = promisify(execFile);
const safeName = /^[\w.@:/ ()-]{1,200}$/;
const authenticationReason = "MCP 인증 필요: 터미널에서 로그인하세요.";

export type ToolCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;

export interface McpToolInfo {
  agent: AgentId;
  name: string;
  "url/command": string;
  nativeEnabled: boolean;
  appEnabled: boolean;
  status: "enabled" | "disabled" | "connected" | "disconnected" | "app-disabled" | "locked";
  forcedOff?: boolean;
  reason?: string;
  needsAuth?: boolean;
  displayName?: string;
  authCommand?: string;
  authHint?: string;
}

const agentLabels: Record<AgentId, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

function titleCase(value: string): string {
  return value.split(/\s+/).map((word) => word ? word[0].toLocaleUpperCase() + word.slice(1) : word).join(" ");
}

/** "plugin:design:slack" → "Slack(design 플러그인)", "claude.ai Notion" → "Notion(claude.ai)" */
export function mcpDisplayName(name: string): string {
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name);
  if (plugin) return `${titleCase(plugin[2])}(${plugin[1]} 플러그인)`;
  const claudeAi = /^claude\.ai\s+(.+)$/.exec(name);
  if (claudeAi) return `${claudeAi[1]}(claude.ai)`;
  return name;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export function mcpAuthAction(agent: AgentId, name: string): { command: string; hint: string } {
  const hint = agent === "codex" ? `Codex MCP 인증: 브라우저가 열리면 ${name} 로그인 후 승인하세요.`
    : `${agentLabels[agent]} MCP 인증: /mcp 입력 → ${name} 선택 → Authenticate`;
  const launch = agent === "codex" ? `codex mcp login ${shellQuote(name)}` : agent;
  return { hint, command: `printf '\\n▶ %s\\n\\n' ${shellQuote(hint)} && ${launch}` };
}

export function mcpAuthTitle(agent: AgentId, names: string[]): string {
  const shown = names.slice(0, 3).map(mcpDisplayName).join(", ");
  return `${agentLabels[agent]}의 ${shown}${names.length > 3 ? ` 외 ${names.length - 3}개` : ""} MCP 인증이 필요해요`;
}

function defaultRunner(file: string, args: string[]): Promise<{ stdout: string; stderr?: string }> {
  return execFileAsync(file, args, { timeout: 10_000, maxBuffer: 512_000 });
}

interface TomlLine { start: number; end: number; text: string; newline: string; external: boolean; header?: string }

function multilineState(line: string, initial?: '"""' | "'''"): '"""' | "'''" | undefined {
  let state = initial;
  let doubleQuoted = false;
  let singleQuoted = false;
  for (let index = 0; index < line.length;) {
    if (state) {
      const found = line.indexOf(state, index);
      if (found < 0) return state;
      if (state === '"""' && found > 0 && line[found - 1] === "\\" && line[found - 2] !== "\\") { index = found + 3; continue; }
      state = undefined; index = found + 3; continue;
    }
    if (!doubleQuoted && !singleQuoted && line[index] === "#") break;
    const triple = line.slice(index, index + 3);
    if (!doubleQuoted && !singleQuoted && (triple === '"""' || triple === "'''")) { state = triple; index += 3; continue; }
    if (!singleQuoted && line[index] === '"') {
      const escaped = index > 0 && line[index - 1] === "\\" && line[index - 2] !== "\\";
      if (!escaped) doubleQuoted = !doubleQuoted;
    } else if (!doubleQuoted && line[index] === "'") singleQuoted = !singleQuoted;
    index += 1;
  }
  return state;
}

function tomlLines(content: string): TomlLine[] {
  const lines: TomlLine[] = [];
  let start = 0;
  let multiline: '"""' | "'''" | undefined;
  while (start < content.length) {
    const lf = content.indexOf("\n", start);
    const end = lf < 0 ? content.length : lf + 1;
    const raw = content.slice(start, end);
    const newline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    const text = newline ? raw.slice(0, -newline.length) : raw;
    const external = !multiline;
    const match = external ? /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(text) : undefined;
    lines.push({ start, end, text, newline, external, ...(match ? { header: match[1] } : {}) });
    multiline = multilineState(text, multiline);
    start = end;
  }
  if (multiline) throw new Error("Codex config TOML에 닫히지 않은 여러 줄 문자열이 있습니다.");
  return lines;
}

function mcpHeaderName(header: string): string | undefined {
  const match = /^mcp_servers\s*\.\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*$/.exec(header);
  if (!match) return undefined;
  if (match[1] != null) {
    try { return JSON.parse(`"${match[1]}"`); } catch { return undefined; }
  }
  return match[2] ?? match[3];
}

export function setCodexMcpEnabled(content: string, name: string, enabled: boolean): string {
  if (!safeName.test(name)) throw new Error("MCP 도구 이름이 올바르지 않습니다.");
  const lines = tomlLines(content);
  const headerIndex = lines.findIndex((line) => line.header && mcpHeaderName(line.header) === name);
  if (headerIndex < 0) throw new Error(`Codex MCP 도구 '${name}'을 찾을 수 없습니다.`);
  const header = lines[headerIndex];
  const end = lines.slice(headerIndex + 1).find((line) => line.header)?.start ?? content.length;
  const value = enabled ? "true" : "false";
  const assignment = lines.slice(headerIndex + 1).find((line) => line.start < end && line.external && /^\s*enabled\s*=\s*(?:true|false)(?:\s*(?:#.*)?)?$/.test(line.text));
  if (assignment) {
    const text = assignment.text.replace(/^(\s*enabled\s*=\s*)(?:true|false)/, `$1${value}`);
    return content.slice(0, assignment.start) + text + assignment.newline + content.slice(assignment.end);
  }
  const newline = header.newline || (content.includes("\r\n") ? "\r\n" : "\n");
  const insertion = `${header.newline ? "" : newline}enabled = ${value}${newline}`;
  return content.slice(0, header.end) + insertion + content.slice(header.end);
}

function parseLine(agent: AgentId, raw: string): McpToolInfo | undefined {
  const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!line || /^[-─\s]+$/.test(line)) return undefined;
  if (agent === "claude") {
    const match = /^(.+?):\s+(.*?)\s+-\s+(?:[✓✔✗✘!-]\s*)?(.+?)\s*$/i.exec(line);
    if (!match || !safeName.test(match[1])) return undefined;
    const statusText = match[3].trim();
    const needsAuthentication = authenticationNeeded(statusText);
    if (!needsAuthentication && !/^(?:connected|disconnected|not configured|failed(?:\s+to\s+connect)?)$/i.test(statusText)) return undefined;
    const connected = statusText.toLocaleLowerCase() === "connected";
    return { agent, name: match[1], "url/command": match[2], nativeEnabled: true, appEnabled: true,
      status: connected ? "connected" : "disconnected", ...(needsAuthentication ? { needsAuth: true } : {}),
      reason: needsAuthentication ? authenticationReason : "Claude MCP는 앱 수준에서만 켜고 끌 수 있습니다." };
  }
  if (agent === "grok") {
    const g = /^(.+?):\s+(\S+)(?:\s+\((disabled|enabled)\))?(?:\s+(.*))?\s*$/i.exec(line);
    if (g && safeName.test(g[1])) {
      const on = (g[3] ?? "enabled").toLocaleLowerCase() === "enabled";
      return { agent, name: g[1], "url/command": g[2], nativeEnabled: on, appEnabled: on, status: on ? "enabled" : "disabled",
        ...(authenticationNeeded(g[4] ?? "") ? { reason: authenticationReason, needsAuth: true } : {}) };
    }
  }
  if (/^(?:name|url|command|status)\b/i.test(line)) return undefined;
  const match = /^(\S+)\s+(.+?)\s+(enabled|disabled)(?:\s+(.*))?$/i.exec(line);
  if (!match || !safeName.test(match[1])) return undefined;
  const nativeEnabled = match[3].toLocaleLowerCase() === "enabled";
  return { agent, name: match[1], "url/command": match[2].trim(), nativeEnabled, appEnabled: nativeEnabled, status: nativeEnabled ? "enabled" : "disabled",
    ...(authenticationNeeded(match[4] ?? "") ? { reason: authenticationReason, needsAuth: true } : {}) };
}

/** Codex prints an aligned table; names/commands may contain spaces, so slice by header column offsets. */
function parseCodexTable(lines: string[]): McpToolInfo[] | undefined {
  const clean = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  const result: McpToolInfo[] = [];
  let columns: { name: string; start: number }[] | undefined;
  for (const line of clean) {
    if (/^Name\s{2,}/.test(line)) {
      columns = [...line.matchAll(/\S+(?: \S+)*/g)].map((m) => ({ name: m[0].toLocaleLowerCase(), start: m.index ?? 0 }));
      continue;
    }
    if (!columns || !line.trim()) continue;
    const cell = (key: string) => {
      const index = columns!.findIndex((c) => c.name.startsWith(key));
      if (index < 0) return "";
      return line.slice(columns![index].start, columns![index + 1]?.start ?? line.length).trim();
    };
    const name = cell("name"); const status = cell("status").toLocaleLowerCase();
    if (!name || !safeName.test(name) || !/^(?:enabled|disabled)$/.test(status)) continue;
    const nativeEnabled = status === "enabled";
    const auth = cell("auth");
    result.push({ agent: "codex", name, "url/command": cell("url") || [cell("command"), cell("args")].filter((v) => v && v !== "-").join(" "),
      nativeEnabled, appEnabled: nativeEnabled, status: nativeEnabled ? "enabled" : "disabled",
      ...(authenticationNeeded(auth) ? { reason: authenticationReason, needsAuth: true } : {}) });
  }
  return columns ? result : undefined;
}

function authenticationNeeded(text: string): boolean {
  return /\b(?:needs? authentication|requires? authentication|authentication required|not logged in|login required|needs? login|unauthenticated)\b|인증 필요|로그인 필요/i.test(text);
}

function parseList(agent: AgentId, stdout: string): McpToolInfo[] {
  if (agent === "codex") { const table = parseCodexTable(stdout.split(/\r?\n/)); if (table) return table; }
  return stdout.split(/\r?\n/).flatMap((line) => {
    const parsed = parseLine(agent, line);
    return parsed ? [parsed] : [];
  });
}

export async function discoverMcpTools(_workspace: WorkspaceId, options: { runner?: ToolCommandRunner; disabledMcp?: readonly string[]; policy?: WorkspacePolicy } = {}): Promise<McpToolInfo[]> {
  const runner = options.runner ?? defaultRunner;
  const disabled = new Set(options.disabledMcp ?? []);
  const agents: AgentId[] = ["codex", "claude", "grok"];
  const results = await Promise.all(agents.map(async (agent) => {
    try { return parseList(agent, (await runner(agent, ["mcp", "list"])).stdout); }
    catch { return []; }
  }));
  return results.flat().map((tool) => decorate(tool)).map((tool) => {
    const forcedOff = isToolLocked(options.policy, tool.agent, tool.name);
    const appEnabled = tool.nativeEnabled && !disabled.has(`${tool.agent}:${tool.name}`) && !forcedOff;
    return {
      ...tool,
      appEnabled,
      status: forcedOff ? "locked" as const
        : !appEnabled && tool.agent === "claude" ? "app-disabled" as const
        : !appEnabled ? "disabled" as const : tool.status,
      ...(forcedOff ? { forcedOff: true, reason: "이 작업 공간 설정에서 차단된 도구입니다." }
        : tool.agent === "claude" ? { reason: tool.reason ?? "Claude MCP는 앱 수준에서만 켜고 끌 수 있습니다." } : {}),
    };
  });
}

function decorate(tool: McpToolInfo): McpToolInfo {
  const displayName = mcpDisplayName(tool.name);
  if (!tool.needsAuth) return { ...tool, displayName };
  const action = mcpAuthAction(tool.agent, tool.name);
  return { ...tool, displayName, authCommand: action.command, authHint: action.hint, reason: `인증 필요 · ${action.hint}` };
}

export async function updateMcpTool(input: { agent: AgentId; name: string; enabled: boolean }, options: { runner?: ToolCommandRunner; codexConfigPath?: string } = {}): Promise<void> {
  if (!safeName.test(input.name)) throw new Error("MCP 도구 이름이 올바르지 않습니다.");
  const runner = options.runner ?? defaultRunner;
  if (input.agent === "grok") {
    await runner("grok", ["mcp", input.enabled ? "enable" : "disable", input.name]);
    return;
  }
  if (input.agent === "claude") return;
  const file = options.codexConfigPath ?? join(homedir(), ".codex", "config.toml");
  const current = await readFile(file, "utf8");
  const next = setCodexMcpEnabled(current, input.name, input.enabled);
  if (next === current) return;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, next, { mode: 0o600 });
  await rename(temporary, file);
}
