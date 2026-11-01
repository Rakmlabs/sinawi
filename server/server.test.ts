import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Session } from "./types.js";
import { pickDirectory, recoverStaleSessions } from "./server.js";

test("Finder picker uses a fixed osascript and normalizes its selected path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-picker-"));
  const path = await pickDirectory(async (file, args) => {
    assert.equal(file, "osascript");
    assert.deepEqual(args, ["-e", "POSIX path of (choose folder)"]);
    return { stdout: `${directory}/\n` };
  });
  assert.equal(path, directory);
});

test("Finder picker treats the native cancel result as a non-error", async () => {
  const path = await pickDirectory(async () => {
    throw Object.assign(new Error("Command failed"), { stderr: "execution error: User canceled. (-128)" });
  });
  assert.equal(path, null);
});

test("Finder picker preserves the filesystem root", async () => {
  assert.equal(await pickDirectory(async () => ({ stdout: "/\n" })), "/");
});

test("server startup persists running and legacy planning sessions as interrupted errors", async () => {
  const base = {
    agent: "claude" as const, workers: ["grok" as const], cwd: process.cwd(),
    createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "company" as const,
  };
  const sessions: Session[] = [
    { ...base, id: "running", title: "Running", status: "running" as const },
    { ...base, id: "planning", title: "Planning", status: "planning" as Session["status"] },
    { ...base, id: "done", title: "Done", status: "done" as const },
  ];
  let persisted: Session[] | undefined;
  const now = new Date("2026-02-03T04:05:06.000Z");

  await recoverStaleSessions(sessions, async (snapshot) => { persisted = structuredClone(snapshot); }, now);

  assert.equal(sessions[0].status, "error");
  assert.equal(sessions[1].status, "error");
  assert.equal(sessions[2].status, "done");
  assert.equal(sessions[0].endedAt, now.toISOString());
  assert.equal(sessions[0].events.at(-1)?.type, "error");
  assert.equal(sessions[0].events.at(-1)?.text, "서버 재시작으로 작업이 중단되었습니다");
  assert.deepEqual(persisted, sessions);
});

