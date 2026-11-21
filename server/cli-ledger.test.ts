// L5: CLI groups a killed server left running are ended at the next start; groups of a live
// server, groups that are no longer ours and the ledger's own junk are left alone.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { forgetEndedCliGroups, reapStaleCliGroups, recordCliGroup, setCliGroupLedger } from "./cli-ledger.js";

const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const deadPid = () => { const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }); return Number(child.stdout.trim()); };

test("a CLI group left by a dead server is ended; a live server's and an unverified one stay", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const foreign = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(async () => { for (const child of [orphan, foreign, live]) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } await rm(dir, { recursive: true, force: true }); });
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

test("the default check recognises a group by its leader's command", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  const cli = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(async () => { try { process.kill(-cli.pid!, "SIGKILL"); } catch { /* gone */ } await rm(dir, { recursive: true, force: true }); });
  await writeFile(file, JSON.stringify([{ pgid: cli.pid, command: "/opt/other/claude", serverPid: deadPid(), startedAt: "" }]));
  assert.deepEqual(reapStaleCliGroups(file, { graceMs: 50 }), [], "a sleep is not the claude we recorded");
  await writeFile(file, JSON.stringify([{ pgid: cli.pid, command: "/bin/sleep", serverPid: deadPid(), startedAt: "" }]));
  assert.deepEqual(reapStaleCliGroups(file, { graceMs: 50 }), [cli.pid]);
});

test("a run records its group and the ledger drops it once it ends", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-ledger-"));
  const file = join(dir, "cli-groups.json");
  setCliGroupLedger(file);
  t.after(async () => { setCliGroupLedger(undefined); await rm(dir, { recursive: true, force: true }); });
  const child = spawn("sleep", ["0.2"], { detached: true, stdio: "ignore" });
  recordCliGroup(child.pid, "sleep");
  assert.equal((JSON.parse(await readFile(file, "utf8")) as unknown[]).length, 1);
  await new Promise((resolve) => child.once("exit", resolve));
  forgetEndedCliGroups();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});
