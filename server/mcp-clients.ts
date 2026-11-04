import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_MCP_SERVER } from "./app-mcp.js";
import { envVar } from "./runtime.js";

/**
 * "Connect to Claude Desktop / Cursor" on the settings page: merges an `mcpServers.sinawi` entry into
 * the client's own config file. Only the settings page calls this (server.ts checks the app's origin,
 * and the routes are in ROUTE_EXCLUSIONS, so no MCP tool reaches them): an AI must not rewire which
 * tools another AI client loads.
 *
 * The file keeps every other key and server. The original is copied to `<file>.bak` first, and a file
 * that is not valid JSON is left alone. Paths can be moved for tests with SINAWI_CLAUDE_DESKTOP_CONFIG
 * and SINAWI_CURSOR_MCP_CONFIG.
 */
export const MCP_CLIENTS = ["claude", "cursor"] as const;
export type McpClientId = typeof MCP_CLIENTS[number];
export type McpServerEntry = { command: string; args: string[]; env?: Record<string, string> };

export const isMcpClient = (value: unknown): value is McpClientId => typeof value === "string" && (MCP_CLIENTS as readonly string[]).includes(value);

export const mcpClientName = (client: McpClientId) => client === "claude" ? "Claude Desktop" : "Cursor";

export function mcpClientConfigPath(client: McpClientId): string {
  if (client === "claude") return envVar("CLAUDE_DESKTOP_CONFIG") || join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return envVar("CURSOR_MCP_CONFIG") || join(homedir(), ".cursor", "mcp.json");
}

export type McpClientPlan = {
  client: McpClientId;
  name: string;
  path: string;
  /** The file is there now (it is created otherwise). */
  exists: boolean;
  /** It already has an `mcpServers.sinawi` entry, which is replaced. */
  replaces: boolean;
  /** Whether that entry already equals the one written now. */
  upToDate: boolean;
  /** Exactly what is merged in: `{ "mcpServers": { "sinawi": entry } }`. */
  entry: McpServerEntry;
  merge: string;
};

/** A config file Sinawi will not rewrite; `code` lets the settings page say why in the user's language. */
export class McpClientConfigError extends Error {
  constructor(readonly code: "invalid_json" | "not_object" | "bad_servers", readonly path: string, message: string) { super(message); }
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

async function readConfig(path: string): Promise<{ exists: boolean; text: string; json: JsonObject }> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "", json: {} };
    throw error;
  }
  if (!text.trim()) return { exists: true, text, json: {} };
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new McpClientConfigError("invalid_json", path, `${path} is not valid JSON, so it was left as is. Fix or move it, then try again.`); }
  if (!isObject(json)) throw new McpClientConfigError("not_object", path, `${path} does not hold a JSON object, so it was left as is.`);
  if (json.mcpServers !== undefined && !isObject(json.mcpServers)) throw new McpClientConfigError("bad_servers", path, `"mcpServers" in ${path} is not an object, so it was left as is.`);
  return { exists: true, text, json };
}

const mergeText = (entry: McpServerEntry) => JSON.stringify({ mcpServers: { [APP_MCP_SERVER]: entry } }, null, 2);

export async function planMcpClient(client: McpClientId, entry: McpServerEntry): Promise<McpClientPlan> {
  const path = mcpClientConfigPath(client);
  const current = await readConfig(path);
  const servers = isObject(current.json.mcpServers) ? current.json.mcpServers : {};
  const existing = servers[APP_MCP_SERVER];
  return {
    client, name: mcpClientName(client), path, exists: current.exists,
    replaces: existing !== undefined, upToDate: JSON.stringify(existing) === JSON.stringify(entry),
    entry, merge: mergeText(entry),
  };
}

/** Writes the entry; returns the backup path when there was a file to back up. */
export async function applyMcpClient(client: McpClientId, entry: McpServerEntry): Promise<{ path: string; backup: string | null }> {
  const path = mcpClientConfigPath(client);
  const current = await readConfig(path);
  const servers = isObject(current.json.mcpServers) ? current.json.mcpServers : {};
  const next = { ...current.json, mcpServers: { ...servers, [APP_MCP_SERVER]: entry } };
  await mkdir(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (current.exists) {
    backup = `${path}.bak`;
    await copyFile(path, backup);
  }
  // Written aside, then renamed: a crash never leaves the client with half a config.
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { path, backup };
}
