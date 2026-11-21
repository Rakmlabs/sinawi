// The process groups of the CLIs this server spawned, written to the data folder (L5). Each CLI is
// its own detached group, so when the server is killed outright (SIGKILL, out of memory) no exit hook
// runs and the CLI keeps editing files with nobody watching. The next server start reads the ledger
// and ends the groups a dead server left behind.
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface CliGroupEntry { pgid: number; command: string; serverPid: number; startedAt: string }

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
  entries.push({ pgid, command, serverPid: process.pid, startedAt: new Date().toISOString() });
  write(ledger, entries);
}

/** Drops ended groups from the ledger (a run finished). */
export function forgetEndedCliGroups(): void {
  if (!ledger) return;
  const entries = read(ledger);
  const kept = entries.filter((entry) => alive(entry.pgid, true));
  if (kept.length !== entries.length) write(ledger, kept);
}

/** The group is still the one we recorded: its leader runs that command, or every member was orphaned to launchd. */
function stillOurs(entry: CliGroupEntry): boolean {
  const name = basename(entry.command);
  try {
    const leader = execFileSync("ps", ["-o", "command=", "-p", String(entry.pgid)], { encoding: "utf8", timeout: 2_000 }).trim();
    if (leader) return leader.includes(name);
  } catch { /* the leader is gone; look at the members */ }
  try {
    const members = execFileSync("pgrep", ["-g", String(entry.pgid)], { encoding: "utf8", timeout: 2_000 }).split(/\s+/u).filter(Boolean);
    if (!members.length) return false;
    return members.every((pid) => execFileSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8", timeout: 2_000 }).trim() === "1");
  } catch { return false; }
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
