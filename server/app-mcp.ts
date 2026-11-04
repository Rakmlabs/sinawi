import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { envVar } from "./runtime.js";

/**
 * The external MCP surface (server/app-tools.ts, surface "external"): Claude Desktop or any other
 * MCP client starts the stdio bridge (packages/sinawi/lib/mcp.mjs: `npx -y sinawi mcp`, the copy in the app
 * bundle, or the copy in <data>/hooks), which posts to
 * /api/app-mcp with this token. The token lives in the app's data folder (0600); the settings page
 * shows it with a ready-made config.
 */
export const APP_MCP_SERVER = "sinawi";
export const APP_MCP_SCRIPT = "sinawi-mcp.mjs";
/** The npm package whose `mcp` command is the bridge: `npx -y sinawi mcp`. */
export const APP_MCP_PACKAGE = "sinawi";
/** The bridge's source in a checkout. */
const BRIDGE_SOURCE = join("packages", "sinawi", "lib", "mcp.mjs");

export const appMcpTokenPath = (dataDir: string) => join(dataDir, "app-mcp-token");

async function writeToken(dataDir: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  // A fresh file each time (written aside, then renamed): `mode` only applies when a file is created,
  // so overwriting one made with looser permissions would keep them.
  const file = appMcpTokenPath(dataDir);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${token}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  return token;
}

/** One token operation at a time per folder: two first uses must not each write a different token. */
const tokenQueues = new Map<string, Promise<unknown>>();
function queued<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(dataDir);
  const next = (tokenQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  tokenQueues.set(key, next);
  return next;
}

/** The token, made on first use. A token file readable by others is tightened to 0600. */
export function ensureAppMcpToken(dataDir: string): Promise<string> {
  return queued(dataDir, async () => {
    const file = appMcpTokenPath(dataDir);
    const current = (await readFile(file, "utf8").catch(() => "")).trim();
    if (current.length < 32) return writeToken(dataDir);
    await chmod(file, 0o600).catch(() => undefined);
    return current;
  });
}

/** A new token: clients with the old one stop working. */
export const rotateAppMcpToken = (dataDir: string) => queued(dataDir, () => writeToken(dataDir));

/** `Authorization: Bearer <token>` or `x-sinawi-mcp-token`. */
export function presentedToken(headers: { authorization?: string; [key: string]: unknown }): string {
  const auth = typeof headers.authorization === "string" ? headers.authorization : "";
  const match = /^Bearer\s+(.+)$/iu.exec(auth.trim());
  if (match) return match[1].trim();
  const header = headers["x-sinawi-mcp-token"];
  return typeof header === "string" ? header.trim() : "";
}

export function tokenMatches(expected: string, given: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bundled server carries the script (scripts/build-server.mjs `define`); a checkout reads packages/sinawi. */
declare const __SINAWI_MCP_SCRIPT__: string | undefined;

async function scriptSource(): Promise<string | undefined> {
  if (typeof __SINAWI_MCP_SCRIPT__ === "string") return __SINAWI_MCP_SCRIPT__;
  const entry = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd();
  for (const candidate of [join(entry, "..", BRIDGE_SOURCE), join(process.cwd(), BRIDGE_SOURCE)]) {
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text) return text;
  }
  return undefined;
}

/**
 * Writes the stdio script into <data>/hooks so a client's config keeps working across app updates
 * (the data folder does not move). Undefined when this build has no script.
 */
export async function installAppMcpScript(dataDir: string): Promise<string | undefined> {
  const source = await scriptSource();
  if (!source) return undefined;
  const target = join(dataDir, "hooks", APP_MCP_SCRIPT);
  if ((await readFile(target, "utf8").catch(() => "")) !== source) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, { mode: 0o755 });
  }
  return target;
}

export const appUrl = () => `http://127.0.0.1:${envVar("PORT") || "3001"}`;

/**
 * The `mcpServers` entry for claude_desktop_config.json (and other clients that take the same shape):
 * the npm package through npx. Needs npx on the client's PATH and, the first time, the network.
 */
export function clientConfig(token: string) {
  return { mcpServers: { [APP_MCP_SERVER]: { command: "npx", args: ["-y", APP_MCP_PACKAGE, "mcp"], env: { SINAWI_URL: appUrl(), SINAWI_MCP_TOKEN: token } } } };
}

/** The same entry without npx: this Node runs the copy of the bridge the app keeps in <data>/hooks. */
export function scriptClientConfig(script: string, token: string, command = process.execPath) {
  return { mcpServers: { [APP_MCP_SERVER]: { command, args: [script], env: { SINAWI_URL: appUrl(), SINAWI_MCP_TOKEN: token } } } };
}

/**
 * The entry the settings page's "Connect to Claude Desktop / Cursor" writes: this Node runs the app's
 * copy of the bridge, and the token is read from its file on every call, so no secret is copied into
 * the client's config and a renewed token keeps working.
 */
export function connectEntry(script: string, tokenFile: string, command = process.execPath) {
  return { command, args: [script], env: { SINAWI_URL: appUrl(), SINAWI_MCP_TOKEN_FILE: tokenFile } };
}
