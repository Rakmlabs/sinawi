import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isArray, readJsonFile, writeJsonFile } from "./json-file.js";
import { loadSessions, saveSessions } from "./store.js";
import { NotificationStore } from "./notifications.js";

test("a missing data file reads as undefined without creating backups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  assert.equal(await readJsonFile(join(directory, "missing.json")), undefined);
  assert.deepEqual(await readdir(directory), []);
});

test("an unparsable or wrongly shaped file is moved aside instead of being overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  const file = join(directory, "sessions.json");
  await writeFile(file, "[{\"id\":\"s1\"");
  assert.equal(await readJsonFile(file, isArray), undefined);
  const [backup] = (await readdir(directory)).filter((name) => name.includes(".corrupt-"));
  assert.ok(backup);
  assert.equal(await readFile(join(directory, backup), "utf8"), "[{\"id\":\"s1\"");

  await writeFile(file, "{\"not\":\"an array\"}");
  assert.equal(await readJsonFile(file, isArray), undefined);
  assert.equal((await readdir(directory)).filter((name) => name.includes(".corrupt-")).length >= 1, true);
});

test("corrupt sessions survive a load followed by a save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  await writeFile(join(directory, "sessions.json"), "{broken");
  assert.deepEqual(await loadSessions(directory), []);
  await saveSessions([], directory);
  const backup = (await readdir(directory)).find((name) => name.startsWith("sessions.json.corrupt-"));
  assert.ok(backup);
  assert.equal(await readFile(join(directory, backup), "utf8"), "{broken");
});

test("one corrupt session file is set aside without losing the other sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  const base = { agent: "codex" as const, workers: [], cwd: directory, status: "done" as const, createdAt: "2026-01-01T00:00:00.000Z", events: [], workspaceId: "personal" as const };
  await saveSessions([{ ...base, id: "good", title: "Good" }, { ...base, id: "bad", title: "Bad" }], directory);
  await writeFile(join(directory, "sessions", "bad.json"), "{broken");
  assert.deepEqual((await loadSessions(directory)).map((session) => session.id), ["good"]);
  assert.ok((await readdir(join(directory, "sessions"))).some((name) => name.startsWith("bad.json.corrupt-")));
});

test("corrupt notifications are preserved before new ones are written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  await writeFile(join(directory, "notifications.json"), "nope");
  const store = new NotificationStore(directory);
  await store.add({ workspaceId: "personal", type: "info", title: "새 알림", body: "" });
  assert.ok((await readdir(directory)).some((name) => name.startsWith("notifications.json.corrupt-")));
  assert.equal((await store.list("personal")).length, 1);
});

test("writes leave no temporary files and keep owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-json-"));
  const file = join(directory, "data.json");
  await writeJsonFile(file, { a: 1 }, 2);
  assert.deepEqual(await readdir(directory), ["data.json"]);
  assert.equal(await readFile(file, "utf8"), "{\n  \"a\": 1\n}\n");
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
