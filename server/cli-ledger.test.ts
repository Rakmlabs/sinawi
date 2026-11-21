// L5: CLI groups a killed server left running are ended at the next start; groups of a live
// server, groups that are no longer ours and the ledger's own junk are left alone.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootTime, forgetEndedCliGroups, lstartMs, processStart, reapStaleCliGroups, recordCliGroup, setCliGroupLedger, stillOurs, type CliGroupEntry } from "./cli-ledger.js";

const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const deadPid = () => { const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }); return Number(child.stdout.trim()); };

test("a CLI group left by a dead server is ended; a live server's and an unverified one stay", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const foreign = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(async () => { for (const child of [orphan, foreign, live]) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const dead = deadPid();
  const time = new Date().toISOString();
  await writeFile(file, JSON.stringify([
    { pgid: orphan.pid, command: "/usr/bin/sleep", serverPid: dead, startedAt: time },
    { pgid: foreign.pid, command: "/usr/bin/sleep", serverPid: dead, startedAt: time },
    { pgid: live.pid, command: "/usr/bin/sleep", serverPid: process.ppid, startedAt: time },
    { junk: true },
  ]));
  const reaped = reapStaleCliGroups(file, { verify: (entry) => entry.pgid === orphan.pid, graceMs: 50 });
  assert.deepEqual(reaped, [orphan.pid]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(groupAlive(orphan.pid!), false, "the orphan is ended");
  assert.equal(groupAlive(foreign.pid!), true, "a group that is not ours stays");
  assert.equal(groupAlive(live.pid!), true, "a live server's CLI stays");
  const left = JSON.parse(await readFile(file, "utf8")) as Array<{ pgid: number }>;
  assert.deepEqual(left.map((entry) => entry.pgid), [live.pid], "only the live server's entry is kept");
});

test("the default check ends a group only when the boot, the leader's start time and its command all match", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  const cli = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(async () => { try { process.kill(-cli.pid!, "SIGKILL"); } catch { /* gone */ } await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ours = { pgid: cli.pid!, command: "/bin/sleep", serverPid: deadPid(), startedAt: "", boot: bootTime(), leaderStart: processStart(cli.pid!) };
  assert.ok(ours.boot && ours.leaderStart, "this machine tells the boot and the start time");
  const reap = async (entry: object) => { await writeFile(file, JSON.stringify([entry])); return reapStaleCliGroups(file, { graceMs: 50 }); };
  // R1: the user's own process that got the same PID started at another time.
  assert.deepEqual(await reap({ ...ours, leaderStart: "Thu Jan  1 00:00:00 2026" }), [], "same PID, another process");
  assert.deepEqual(await reap({ ...ours, boot: ours.boot! - 3600 }), [], "recorded before the Mac restarted");
  assert.deepEqual(await reap({ ...ours, boot: undefined, leaderStart: undefined }), [], "an older entry without these facts");
  assert.deepEqual(await reap({ ...ours, command: "/opt/other/claude" }), [], "a sleep is not the claude we recorded");
  assert.equal(groupAlive(cli.pid!), true);
  assert.deepEqual(await reap(ours), [cli.pid]);
});

test("a group whose leader has exited is still ours within the same boot, never after a restart", () => {
  const entry: CliGroupEntry = { pgid: 4242, command: "/usr/local/bin/claude", serverPid: 1, startedAt: "", boot: 100, leaderStart: "Sun Nov 22 01:06:09 2026" };
  const facts = (boot: number, leader?: { start: string; command: string }) => ({ boot: () => boot, start: () => leader?.start, command: () => leader?.command });
  assert.equal(stillOurs(entry, facts(100)), true, "leader gone, members left: the group id was never reused");
  assert.equal(stillOurs(entry, facts(200)), false);
  assert.equal(stillOurs(entry, facts(100, { start: "Sun Nov 22 01:06:09 2026", command: "/usr/local/bin/claude -p x" })), true);
  assert.equal(stillOurs(entry, facts(100, { start: "Mon Nov 23 09:00:00 2026", command: "/usr/local/bin/claude" })), false, "the user's claude with the same PID");
});

// Third review: our group ended entirely, another took its id, and that one's leader exited too.
test("with the leader gone, only members that started between our leader and this server's start count as ours", () => {
  const entry: CliGroupEntry = { pgid: 4242, command: "/usr/local/bin/claude", serverPid: 1, startedAt: "", boot: 100, leaderStart: "Sun Nov 22 01:06:09 2026" };
  const serverStart = lstartMs("Sun Nov 22 02:00:00 2026");
  const facts = (members: Record<number, string>) => ({ boot: () => 100, command: () => undefined, start: (pid: number) => members[pid], members: () => Object.keys(members).map(Number), serverStart: () => serverStart });
  assert.equal(stillOurs(entry, facts({ 5000: "Sun Nov 22 01:06:10 2026", 5001: "Sun Nov 22 01:30:00 2026" })), true, "our orphaned workers");
  assert.equal(stillOurs(entry, facts({ 5000: "Sun Nov 22 03:00:00 2026" })), false, "a group that took the id after this server started");
  assert.equal(stillOurs(entry, facts({ 5000: "Sun Nov 22 01:00:00 2026" })), false, "older than our leader: not ours");
  assert.equal(stillOurs(entry, facts({ 5000: "Sun Nov 22 01:10:00 2026", 5001: "Sun Nov 22 03:00:00 2026" })), false, "one stranger is enough to leave it");
  assert.equal(stillOurs(entry, facts({})), false, "no members to end");
  assert.equal(lstartMs("Sun Nov 22 01:06:09 2026"), Date.UTC(2026, 10, 22, 1, 6, 9), "ps prints UTC (TZ=UTC), read as UTC");
});

test("a run records its group and the ledger drops it once it ends", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  setCliGroupLedger(file);
  t.after(async () => { setCliGroupLedger(undefined); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const child = spawn("sleep", ["0.2"], { detached: true, stdio: "ignore" });
  recordCliGroup(child.pid, "sleep");
  const recorded = JSON.parse(await readFile(file, "utf8")) as CliGroupEntry[];
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].boot, bootTime(), "the boot it was recorded in");
  assert.ok(recorded[0].leaderStart, "and when its leader started");
  await new Promise((resolve) => child.once("exit", resolve));
  forgetEndedCliGroups();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});
