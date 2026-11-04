/**
 * Claude Code asks before a tool call its rules do not cover (reading a folder outside the run,
 * a Bash command off the allowlist). Headless (`-p`) there is nobody to answer, so the call was
 * simply refused. `--permission-prompt-tool` hands that question to an MCP tool instead: Sinawi's
 * tiny stdio server forwards it here, the user answers in the app, and the run continues.
 *
 * The caller is identified only by its per-run token (see computer-tokens.ts). While a question
 * waits, the run is kept alive (it prints nothing, so the inactivity watchdog would end it), and an
 * unanswered question is refused after PROMPT_TIMEOUT_MS.
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { resolveComputerToken } from "./computer-tokens.js";
import { envVar } from "./runtime.js";
import type { AgentId } from "./types.js";

/** MCP server name and tool, as Claude addresses it: `mcp__<server>__<tool>`. */
export const PERMISSION_SERVER = "sinawi_permission";
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER}__approve`;
/** Below Orchestra.quietLimitMs (20 min), which ends a run with no events for that long. */
export const PROMPT_TIMEOUT_MS = 15 * 60 * 1_000;
const KEEPALIVE_MS = 20_000;

export type PermissionRequest = {
  id: string;
  sessionId: string;
  workspaceId: string;
  agent: AgentId;
  toolName: string;
  /** A short human-readable line: the command, file path or URL the tool wants. */
  detail: string;
  input: unknown;
  createdAt: string;
};

type Pending = PermissionRequest & { token: string; answer: (allow: boolean, reason?: string) => void };

const pending = new Map<string, Pending>();
/** Per-run activity callbacks (runCli registers its own), so a waiting run is not seen as stuck. */
const activity = new Map<string, () => void>();

export function registerRunActivity(token: string, onActivity: () => void) { activity.set(token, onActivity); }
/** Tells the run it is still working (a lead waiting on its workers through a tool call). */
export function touchRunActivity(token: string) { activity.get(token)?.(); }
export function unregisterRunActivity(token: string) {
  activity.delete(token);
  // The run is over: nothing is waiting for these answers any more.
  for (const item of pending.values()) if (item.token === token) item.answer(false, "run ended");
}

export const pendingPermissions = (workspaceId?: string): PermissionRequest[] =>
  [...pending.values()].filter((item) => !workspaceId || item.workspaceId === workspaceId).map(({ answer: _answer, token: _token, ...rest }) => rest);

/** The one line shown for a tool call: what it runs or touches. */
export function permissionDetail(input: unknown): string {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const key of ["command", "file_path", "notebook_path", "path", "url", "pattern", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  const json = JSON.stringify(input ?? {});
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

type Deps = { broadcast: (payload: unknown) => void; onRequest?: (request: PermissionRequest) => void; timeoutMs?: number };

export function registerPermissionRoutes(app: Express, deps: Deps) {
  const publish = () => deps.broadcast({ type: "permissions", requests: pendingPermissions() });

  // From the MCP tool inside a Claude run. Held open until the user answers.
  app.post("/api/permissions/request", (req, res) => {
    const token = req.get("x-sinawi-token") ?? "";
    const run = resolveComputerToken(token);
    if (!run) { res.status(403).json({ behavior: "deny", message: "Sinawi: unknown run" }); return; }
    const toolName = typeof req.body?.tool_name === "string" ? req.body.tool_name.slice(0, 200) : "";
    const input = req.body?.input ?? {};
    if (!toolName) { res.status(400).json({ behavior: "deny", message: "Sinawi: tool_name missing" }); return; }
    const id = randomUUID();
    let done = false;
    const keepAlive = setInterval(() => activity.get(token)?.(), KEEPALIVE_MS);
    keepAlive.unref();
    const timer = setTimeout(() => answer(false, "사용자가 시간 안에 답하지 않아 거부했습니다."), deps.timeoutMs ?? PROMPT_TIMEOUT_MS);
    timer.unref();
    function answer(allow: boolean, reason?: string) {
      if (done) return;
      done = true;
      clearInterval(keepAlive);
      clearTimeout(timer);
      pending.delete(id);
      activity.get(token)?.();
      publish();
      res.json(allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: reason ?? "사용자가 거부했습니다." });
    }
    pending.set(id, { id, token, sessionId: run.sessionId, workspaceId: run.workspaceId, agent: run.agent, toolName, detail: permissionDetail(input), input, createdAt: new Date().toISOString(), answer });
    // The MCP server gave up (run stopped): drop the question.
    res.on("close", () => { if (!done) { done = true; clearInterval(keepAlive); clearTimeout(timer); pending.delete(id); publish(); } });
    publish();
    const request = pendingPermissions().find((item) => item.id === id);
    if (request) deps.onRequest?.(request);
  });

  app.get("/api/permissions", (req, res) => {
    res.json({ requests: pendingPermissions(typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined) });
  });

  // From the app: the user's answer.
  app.post("/api/permissions/:id/answer", (req, res) => {
    const item = pending.get(req.params.id);
    if (!item) { res.status(404).json({ error: "이미 처리됐거나 끝난 요청입니다." }); return; }
    item.answer(req.body?.allow === true);
    res.json({ ok: true });
  });
}

/** The stdio MCP server Claude starts: one tool that asks Sinawi and returns the user's answer. */
export function permissionServerScript(): string {
  return `// Generated by Sinawi: forwards Claude Code permission prompts to the app and returns the user's answer.
import * as readline from "node:readline";
const port = process.env.SINAWI_PORT || "3001";
const token = process.env.SINAWI_COMPUTER_TOKEN || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tool = {
  name: "approve",
  description: "Asks the Sinawi user to allow or deny a tool call.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
};
async function ask(args) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/api/permissions/request", {
      method: "POST", headers: { "content-type": "application/json", "x-sinawi-token": token }, body: JSON.stringify(args || {}),
    });
    const data = await res.json();
    if (data && data.behavior === "allow") return { behavior: "allow", updatedInput: data.updatedInput ?? (args || {}).input ?? {} };
    return { behavior: "deny", message: (data && data.message) || "Sinawi refused the request." };
  } catch (error) {
    return { behavior: "deny", message: "Sinawi is not reachable: " + (error && error.message || error) };
  }
}
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "${PERMISSION_SERVER}", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool] } });
  } else if (message.method === "tools/call") {
    const decision = await ask(message.params && message.params.arguments);
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
}

/** Writes (or refreshes) the MCP server script under `dataDir` and returns its path. */
export async function ensurePermissionServerScript(dataDir: string): Promise<string> {
  const directory = nodePath.join(dataDir, "hooks");
  const file = nodePath.join(directory, "sinawi-permission.mjs");
  const script = permissionServerScript();
  const current = await readFile(file, "utf8").catch(() => "");
  if (current !== script) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, script, { mode: 0o600 });
  }
  return file;
}

/** `--mcp-config` JSON that starts the permission server with this run's token. */
export function permissionMcpConfig(scriptPath: string, token: string, nodeBinary = process.execPath): string {
  const port = envVar("PORT") || "3001";
  return JSON.stringify({ mcpServers: { [PERMISSION_SERVER]: { type: "stdio", command: nodeBinary, args: [scriptPath], env: { SINAWI_COMPUTER_TOKEN: token, SINAWI_PORT: port } } } });
}
