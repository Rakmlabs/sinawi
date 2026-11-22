// The process groups of the CLIs this server spawned, written to the data folder (L5). Each CLI is
// its own detached group, so when the server is killed outright (SIGKILL, out of memory) no exit hook
// runs and the CLI keeps editing files with nobody watching. The next server start reads the ledger
// and ends the groups a dead server left behind.
//
// A PID alone proves nothing: after a restart of the Mac, or a long uptime, the same number can belong
// to the user's own `claude` in a terminal. So an entry also records the boot it was made in and its
// group leader's start time, and a group is ended only when both still match (review R1).
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface CliGroupEntry {
  pgid: number;
  command: string;
  serverPid: number;
  startedAt: string;
  /** kern.boottime seconds when recorded: after a restart of the Mac no entry is ours. */
  boot?: number;
  /** The group leader's start time as `ps -o lstart=` gave it (UTC, C locale). */
  leaderStart?: string;
}

let currentBoot: number | undefined;

/** This boot's kern.boottime in seconds (macOS), or Linux's btime; undefined when unknown. */
export function bootTime(): number | undefined {
  if (currentBoot !== undefined) return currentBoot;
  try {
    const text = process.platform === "darwin"
      ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2_000 })
      : readFileSync("/proc/stat", "utf8");
    const seconds = Number((/sec = (\d+)/u.exec(text) ?? /^btime (\d+)$/mu.exec(text))?.[1]);
    if (Number.isInteger(seconds) && seconds > 0) currentBoot = seconds;
  } catch { /* unknown: entries without a matching boot are never ended */ }
  return currentBoot;
}

/** When a process started, as the kernel tells `ps` (stable format: UTC, C locale); undefined if gone. */
export function processStart(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return value || undefined;
  } catch { return undefined; }
}

let ledger: string | undefined;

/** Where this server keeps its ledger (`<data>/cli-groups.json`); undefined turns it off. */
export function setCliGroupLedger(file: string | undefined): void { ledger = file; }

function alive(pid: number, group = false): boolean {
  try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function read(file: string): CliGroupEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is CliGroupEntry => Boolean(entry) && Number.isInteger(entry.pgid) && entry.pgid > 1 && Number.isInteger(entry.serverPid) && typeof entry.command === "string") : [];
  } catch { return []; }
}

function write(file: string, entries: CliGroupEntry[]): void {
  try {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* the ledger is a safety net; a run never fails because of it */ }
}

/** Records a CLI group this server just spawned, dropping groups that have ended. */
export function recordCliGroup(pgid: number | undefined, command: string): void {
  if (!ledger || !pgid || process.platform === "win32") return;
  const entries = read(ledger).filter((entry) => entry.pgid !== pgid && alive(entry.pgid, true));
  entries.push({ pgid, command, serverPid: process.pid, startedAt: new Date().toISOString(), boot: bootTime(), leaderStart: processStart(pgid) });
  write(ledger, entries);
}

/** Drops ended groups from the ledger (a run finished). */
export function forgetEndedCliGroups(): void {
  if (!ledger) return;
  const entries = read(ledger);
  const kept = entries.filter((entry) => alive(entry.pgid, true));
  if (kept.length !== entries.length) write(ledger, kept);
}

/** `ps -o lstart` as processStart reads it (TZ=UTC, no zone in the text) in ms; NaN when unknown. */
export const lstartMs = (value: string | undefined) => value ? Date.parse(`${value} UTC`) : Number.NaN;

export interface ProcessFacts {
  boot: () => number | undefined;
  start: (pid: number) => string | undefined;
  command: (pid: number) => string | undefined;
  /** Live members of a process group. */
  members?: (pgid: number) => number[];
  /** When this server started (ms). */
  serverStart?: () => number;
}

const systemFacts: ProcessFacts = {
  boot: bootTime,
  start: processStart,
  command: (pid) => { try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim() || undefined; } catch { return undefined; } },
  members: (pgid) => { try { return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 2_000 }).split(/\s+/u).map(Number).filter((pid) => pid > 0); } catch { return []; } },
  serverStart: () => Date.now() - process.uptime() * 1_000,
};

/**
 * The group is still the one we recorded. Recorded in this same boot (a group id stays taken while
 * any member lives, so within a boot a live group with that id is still ours), and when its leader is
 * still there, that leader started when the recorded one did and runs the recorded command; when it is
 * gone, every remaining member started between the recorded leader and this server's start. An entry
 * without boot or start facts (an older ledger) is never ended.
 */
export function stillOurs(entry: CliGroupEntry, facts: ProcessFacts = systemFacts): boolean {
  const boot = facts.boot();
  if (!entry.boot || !boot || entry.boot !== boot || !entry.leaderStart) return false;
  const leader = facts.command(entry.pgid);
  if (leader === undefined) {
    // The leader is gone, its members remain. Within a boot the id stays ours while any member lives,
    // but if our group ended entirely and another took the id, its members started after our leader
    // too. What tells them apart: ours started before this server did (the server that recorded them
    // is gone); a group that took the id after we started is never ours (third review, cli-ledger edge).
    const leaderAt = lstartMs(entry.leaderStart);
    const startedBy = facts.serverStart?.() ?? Number.POSITIVE_INFINITY;
    const members = facts.members?.(entry.pgid) ?? [];
    if (!facts.members) return true;
    return members.length > 0 && members.every((pid) => {
      const at = lstartMs(facts.start(pid));
      return Number.isFinite(at) && at >= leaderAt && at <= startedBy;
    });
  }
  return facts.start(entry.pgid) === entry.leaderStart && leader.includes(basename(entry.command));
}

/**
 * At start: ends the CLI groups a server that is no longer running left behind, then keeps only
 * entries of live servers. Returns the groups it signalled.
 */
export function reapStaleCliGroups(file = ledger, options: { verify?: (entry: CliGroupEntry) => boolean; graceMs?: number } = {}): number[] {
  if (!file || process.platform === "win32") return [];
  const verify = options.verify ?? stillOurs;
  const entries = read(file);
  const reaped: number[] = [];
  const kept: CliGroupEntry[] = [];
  for (const entry of entries) {
    if (entry.serverPid === process.pid || alive(entry.serverPid)) { kept.push(entry); continue; }
    if (!alive(entry.pgid, true) || !verify(entry)) continue;
    try { process.kill(-entry.pgid, "SIGTERM"); reaped.push(entry.pgid); } catch { continue; }
    setTimeout(() => { if (alive(entry.pgid, true)) try { process.kill(-entry.pgid, "SIGKILL"); } catch { /* gone */ } }, options.graceMs ?? 2_000).unref();
  }
  if (kept.length !== entries.length) write(file, kept);
  return reaped;
}
