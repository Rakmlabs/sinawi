import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "./types.js";

/**
 * Per-run computer-use tokens. `runCli` (this server process spawns every agent CLI) issues one
 * token per run and hands it to the CLI as `SINAWI_COMPUTER_TOKEN`; `ao-computer` sends it back
 * and the bridge resolves who is asking from the token alone (never from a client-sent session
 * id). This attributes requests correctly; it is not a security boundary against a hostile agent
 * (same macOS user) — the native approval alert in the app is.
 */
/**
 * `owner`: who in the session is running (the lead, or one worker). Stable across that one's
 * turns, so its browser tab stays its own while other sessions and workers get theirs.
 */
export type ComputerRun = { sessionId: string; workspaceId: string; agent: AgentId; owner: string; issuedAt: number; expiresAt: number };

const RUN_TTL_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;
const runs = new Map<string, ComputerRun>();

export function issueComputerToken(run: { sessionId: string; workspaceId: string; agent: AgentId; owner?: string }, now = Date.now(), ttlMs = RUN_TTL_MS): string {
  for (const [token, entry] of runs) if (entry.expiresAt <= now) runs.delete(token);
  while (runs.size >= MAX_RUNS) runs.delete(runs.keys().next().value as string);
  const token = randomBytes(24).toString("base64url");
  runs.set(token, { ...run, owner: run.owner ?? run.sessionId, issuedAt: now, expiresAt: now + ttlMs });
  return token;
}

/** The run behind a token, or undefined when unknown or expired. */
export function resolveComputerToken(token: unknown, now = Date.now()): ComputerRun | undefined {
  if (typeof token !== "string" || !token) return undefined;
  const run = runs.get(token);
  if (!run) return undefined;
  if (run.expiresAt <= now) { runs.delete(token); return undefined; }
  return run;
}

export function revokeComputerToken(token: string) { runs.delete(token); }

/** Drops every token of runs whose session is no longer running (the run ended). */
export function pruneComputerTokens(isRunning: (sessionId: string) => boolean) {
  for (const [token, run] of runs) if (!isRunning(run.sessionId)) runs.delete(token);
}

/** Test helper. */
export function clearComputerTokens() { runs.clear(); }

// ---------- shared directory (screenshots + file queue) ----------

/**
 * The one directory server and `ao-computer` both use: `$SINAWI_COMPUTER_DIR` when set (the
 * server passes it to every CLI it spawns), else `<per-user temp dir>/sinawi-computer-<uid>`.
 * On macOS the per-user temp dir comes from `getconf DARWIN_USER_TEMP_DIR`, which does not
 * depend on `$TMPDIR` (unset under launchd, set in shells), so both sides agree.
 * Self-contained: it is embedded verbatim into the CLI.
 */
export function resolveComputerDir(env: Record<string, string | undefined>, platform: string, uid: number, fallbackTmp: string, userTmp: () => string | undefined): string {
  const explicit = (env.SINAWI_COMPUTER_DIR || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  let base = platform === "darwin" ? (userTmp() || "").trim() : "";
  if (!base) base = fallbackTmp;
  return base.replace(/\/+$/, "") + "/sinawi-computer-" + uid;
}

export const darwinUserTempDir = (): string | undefined => {
  try { return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2_000 }).trim() || undefined; } catch { return undefined; }
};

let cachedDir: string | undefined;
export function computerDir(): string {
  cachedDir ??= resolveComputerDir(process.env, process.platform, process.getuid?.() ?? 0, tmpdir(), darwinUserTempDir);
  return cachedDir;
}

/**
 * Env for one CLI run: the token (only when the run belongs to a session), the session id for
 * display, and the shared directory. `TMPDIR` is filled in when the server has none, so a
 * sandboxed CLI (Codex workspace-write allows `$TMPDIR`) can write the queue there.
 */
export function computerRunEnv(agent: AgentId, context: { sessionId?: string; workspaceId?: string; role?: string; workerId?: string } | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!context?.sessionId) return {};
  const out: Record<string, string> = { SINAWI_SESSION_ID: context.sessionId, SINAWI_COMPUTER_DIR: computerDir() };
  if (!env.TMPDIR && process.platform === "darwin") { const tmp = darwinUserTempDir(); if (tmp) out.TMPDIR = tmp; }
  // Router/status helper runs never need the screen.
  if (context.workspaceId && context.role !== "router" && context.role !== "status") {
    const owner = `${context.sessionId}:${context.workerId ?? context.role ?? ""}`;
    out.SINAWI_COMPUTER_TOKEN = issueComputerToken({ sessionId: context.sessionId, workspaceId: context.workspaceId, agent, owner });
  }
  return out;
}

export const computerShotDir = () => join(computerDir(), "shots");
export const computerQueueDir = () => join(computerDir(), "queue");

/**
 * Who is asking, from the token alone: the run must be known and its session still running
 * (a finished run's token stops working with it). Pure apart from the token map.
 */
export function computerContextForToken(
  token: unknown,
  sessions: readonly { id: string; status: string; workspaceId: string; agent?: string; title?: string }[],
  workspaceName: (id: string) => string | undefined,
  now = Date.now(),
) {
  const run = resolveComputerToken(token, now);
  if (!run) return undefined;
  const session = sessions.find((item) => item.id === run.sessionId);
  if (!session || session.status !== "running") { revokeComputerToken(token as string); return undefined; }
  return { key: `session:${session.id}`, sessionId: session.id, workspaceId: session.workspaceId, agent: run.agent, title: session.title, workspaceName: workspaceName(session.workspaceId) };
}
