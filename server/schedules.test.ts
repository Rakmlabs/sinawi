import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { applySchedulePatch, createSchedule, dueSchedules, loadSchedules, MISSED_GRACE_MS, nextCronRun, parseAt, parseCron, saveSchedules, schedulesPath, type Schedule } from "./schedules.js";

const SEOUL = "Asia/Seoul";

async function waitFor(predicate: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("cron fields: lists, ranges, steps and Sunday as 0 or 7", () => {
  const cron = parseCron("*/15 9-11 1,15 * 7");
  assert.deepEqual([...cron.minute], [0, 15, 30, 45]);
  assert.deepEqual([...cron.hour], [9, 10, 11]);
  assert.deepEqual([...cron.day], [1, 15]);
  assert.deepEqual([...cron.weekday], [0]);
  assert.throws(() => parseCron("0 9 * *"), /다섯 칸/u);
  assert.throws(() => parseCron("60 9 * * *"), /범위/u);
  assert.throws(() => parseCron("a 9 * * *"), /올바르지 않습니다/u);
});

test("the next cron time is read in the schedule's zone", () => {
  // Friday 2026-11-06 10:00 in Seoul: weekdays at 9 next run Monday 09:00 Seoul = 00:00 UTC.
  assert.equal(nextCronRun("0 9 * * 1-5", new Date("2026-11-06T01:00:00Z"), SEOUL)?.toISOString(), "2026-11-09T00:00:00.000Z");
  // Before 9 on a weekday: the same day.
  assert.equal(nextCronRun("0 9 * * 1-5", new Date("2026-11-05T23:30:00Z"), SEOUL)?.toISOString(), "2026-11-06T00:00:00.000Z");
  assert.equal(nextCronRun("30 8 * * *", new Date("2026-11-06T01:00:00Z"), "UTC")?.toISOString(), "2026-11-06T08:30:00.000Z");
  // Exactly at a run time: the next one, not the same minute again.
  assert.equal(nextCronRun("0 * * * *", new Date("2026-11-06T01:00:00Z"), "UTC")?.toISOString(), "2026-11-06T02:00:00.000Z");
  // Day of month and weekday both set: either one.
  assert.equal(nextCronRun("0 0 1 * 1", new Date("2026-11-06T00:00:00Z"), "UTC")?.toISOString(), "2026-11-09T00:00:00.000Z");
  // A New York time across the DST change (Nov 1 2026).
  assert.equal(nextCronRun("0 9 * * *", new Date("2026-11-01T00:00:00Z"), "America/New_York")?.toISOString(), "2026-11-01T14:00:00.000Z");
  assert.equal(nextCronRun("0 0 31 2 *", new Date("2026-01-01T00:00:00Z"), "UTC"), undefined, "Feb 31 never comes");
});

test("a one-off time without an offset is read in the zone", () => {
  assert.equal(parseAt("2026-11-04T09:00", SEOUL).toISOString(), "2026-11-04T00:00:00.000Z");
  assert.equal(parseAt("2026-11-04T09:00:00+09:00").toISOString(), "2026-11-04T00:00:00.000Z");
  assert.throws(() => parseAt("내일 아침"), /읽지 못했습니다/u);
});

test("schedules are checked on create and edit", () => {
  const now = new Date("2026-11-03T00:00:00Z");
  const once = createSchedule("s1", { prompt: "릴리스 점검", at: "2026-11-04T09:00", timezone: SEOUL }, "lead", now);
  assert.equal(once.nextRunAt, "2026-11-04T00:00:00.000Z");
  assert.equal(once.title, "릴리스 점검", "the title defaults to the prompt");
  assert.equal(once.createdBy, "lead");
  assert.throws(() => createSchedule("s1", { prompt: "x", at: "2026-11-01T09:00", timezone: SEOUL }, "user", now), /지난 시각/u);
  assert.throws(() => createSchedule("s1", { prompt: "x" }, "user", now), /at\) 또는 반복\(cron/u);
  assert.throws(() => createSchedule("s1", { at: "2026-11-04T09:00" }, "user", now), /prompt/u);
  assert.throws(() => createSchedule("s1", { prompt: "x", cron: "0 9 * * *", timezone: "Mars/Base" }, "user", now), /시간대/u);
  const repeat = applySchedulePatch(once, { cron: "0 9 * * 1-5" }, now);
  assert.equal(repeat.at, undefined, "cron replaces the one-off time");
  assert.equal(repeat.nextRunAt, "2026-11-04T00:00:00.000Z");
  const paused = applySchedulePatch(repeat, { enabled: false }, now);
  assert.equal(paused.enabled, false);
  assert.equal(applySchedulePatch(paused, { prompt: "새 내용" }, now).prompt, "새 내용");
});

test("missed-fire rule: due within a day runs once, older is skipped; a one-off closes, a cron moves on", () => {
  const made = new Date("2026-11-01T00:00:00Z");
  const daily = createSchedule("s1", { prompt: "매일", cron: "0 9 * * *", timezone: SEOUL }, "user", made);
  const once = createSchedule("s1", { prompt: "한 번", at: "2026-11-02T09:00", timezone: SEOUL }, "user", made);
  const old = createSchedule("s1", { prompt: "오래됨", cron: "0 9 * * *", timezone: SEOUL }, "user", made);
  const now = new Date("2026-11-02T00:30:00Z");
  old.nextRunAt = new Date(now.getTime() - MISSED_GRACE_MS - 60_000).toISOString();
  const due = dueSchedules([daily, once, old], now);
  assert.deepEqual(due.map((item) => [item.schedule.prompt, item.action]), [["매일", "fire"], ["한 번", "fire"], ["오래됨", "missed"]]);
  assert.equal(daily.nextRunAt, "2026-11-03T00:00:00.000Z");
  assert.equal(daily.lastRunAt, now.toISOString());
  assert.equal(once.enabled, false);
  assert.equal(once.nextRunAt, undefined);
  assert.equal(old.lastMissedAt, now.toISOString());
  assert.equal(old.lastRunAt, undefined);
  assert.equal(old.nextRunAt, "2026-11-03T00:00:00.000Z");
  assert.deepEqual(dueSchedules([daily, once, old], now), [], "nothing runs twice");
});

test("schedules are saved to schedules.json and read back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-schedules-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadSchedules(dir), []);
  const item = createSchedule("s1", { prompt: "p", cron: "0 9 * * *", timezone: SEOUL }, "user");
  await saveSchedules(dir, [item]);
  assert.deepEqual(await loadSchedules(dir), [item]);
  assert.match(await readFile(schedulesPath(dir), "utf8"), /"schedules"/u);
});

test("a schedule fires into the lead's latest chat, shows cards, persists and survives a restart", async (t) => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "sinawi-schedule-fire-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const prompts: string[] = [];
  let chatId = "";
  let made: any;
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "orchestrator" && !options.readOnly) {
      prompts.push(options.prompt);
      // The lead decides to make a schedule while talking.
      if (prompts.length === 1) made = await orchestra.leadToolCall(chatId, "schedule_create", { title: "배포 점검", prompt: "배포 상태를 확인해 줘", cron: "0 9 * * *", timezone: SEOUL });
    }
    return { exitCode: 0, finalText: "네" };
  };
  const orchestra: Orchestra = new Orchestra(undefined, runner);
  orchestra.stewardDataDir = dataDir;
  const saved: Schedule[][] = [];
  orchestra.persistSchedules = async (list) => { saved.push(structuredClone(list)); await saveSchedules(dataDir, list); };
  const steward = orchestra.createSteward({ name: "ops", agent: "claude", workers: [{ agent: "codex" }], cwds: [dataDir] });
  const chat = await orchestra.create({ prompt: "매일 아침 배포 확인해야 해", steward: { id: steward.id } } as never);
  chatId = chat.id;
  await waitFor(() => chat.status === "done" && Boolean(made));
  assert.equal(made.cron, "0 9 * * *");
  assert.equal(made.createdBy, "lead");
  const card = chat.events.find((event) => event.metadata?.schedule?.action === "created");
  assert.equal(card?.metadata?.schedule?.by, "lead", "the chat shows a card for the lead's new schedule");
  assert.equal(orchestra.listSchedules(steward.id).length, 1);
  assert.equal(saved.at(-1)?.length, 1, "written to schedules.json");

  // Not due yet: nothing happens.
  const next = new Date(made.nextRunAt);
  await orchestra.stewardTick(new Date(next.getTime() - 60_000));
  assert.equal(prompts.length, 1);
  // Due: the prompt goes to the lead's chat as a turn.
  await orchestra.stewardTick(new Date(next.getTime() + 1_000));
  await waitFor(() => prompts.length === 2 && chat.status === "done");
  assert.match(prompts[1], /\[일정 "배포 점검"\]\n배포 상태를 확인해 줘/u);
  assert.ok(chat.events.some((event) => event.metadata?.schedule?.action === "fired"));
  const after = orchestra.listSchedules(steward.id)[0];
  assert.equal(after.nextRunAt, new Date(next.getTime() + 24 * 60 * 60_000).toISOString(), "a daily schedule moves to tomorrow");

  // Restart: a new Orchestra reads the file; a run missed by more than a day is skipped, not sent.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const restored = new Orchestra(undefined, async (options: RunCliOptions) => { if (!options.readOnly && options.usageContext?.role === "orchestrator") prompts.push(options.prompt); return { exitCode: 0, finalText: "네" }; });
  restored.stewardDataDir = dataDir;
  restored.restore(orchestra.list(), orchestra.listStewards());
  restored.restoreSchedules(await loadSchedules(dataDir));
  assert.equal(restored.listSchedules(steward.id).length, 1);
  const late = new Date(Date.parse(after.nextRunAt!) + MISSED_GRACE_MS + 60_000);
  await restored.stewardTick(late);
  const restoredChat = restored.get(chat.id)!;
  assert.ok(restoredChat.events.some((event) => event.metadata?.schedule?.action === "missed"), "the chat says it was skipped");
  assert.equal(prompts.length, 2, "a run missed by more than a day is not sent");
  assert.ok(Date.parse(restored.listSchedules(steward.id)[0].nextRunAt!) > late.getTime());

  // The lead edits and deletes only its own schedules.
  await assert.rejects(restored.leadToolCall(chat.id, "schedule_update", { id: "nope", enabled: false }), /일정을 찾을 수 없습니다/u);
  const listed = await restored.leadToolCall(chat.id, "schedule_list", {}) as any;
  assert.equal(listed.schedules[0].title, "배포 점검");
  const paused = await restored.leadToolCall(chat.id, "schedule_update", { id: made.id, enabled: false }) as any;
  assert.equal(paused.enabled, false);
  await restored.leadToolCall(chat.id, "schedule_delete", { id: made.id });
  assert.deepEqual(restored.listSchedules(steward.id), []);
  assert.ok(restoredChat.events.some((event) => event.metadata?.schedule?.action === "deleted"));
  // Deleting a lead removes its schedules.
  restored.createLeadSchedule(steward.id, { prompt: "x", cron: "0 9 * * *" }, "user");
  restored.deleteSteward(steward.id);
  assert.deepEqual(restored.listSchedules(), []);
});

test("the minute tick reads the clock: with fake timers a schedule fires once its time comes", async (t) => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "sinawi-schedule-clock-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "네" }));
  orchestra.stewardDataDir = dataDir;
  const steward = orchestra.createSteward({ name: "clock", agent: "claude", workers: [{ agent: "codex" }], cwds: [dataDir] });
  const chat = await orchestra.create({ prompt: "안녕", steward: { id: steward.id } } as never);
  await waitFor(() => chat.status === "done");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T23:00:00Z") });
  const schedule = orchestra.createLeadSchedule(steward.id, { prompt: "아침 점검", at: "2026-11-04T09:00", timezone: SEOUL }, "user");
  assert.equal(schedule.nextRunAt, "2026-11-04T00:00:00.000Z");
  t.mock.timers.setTime(Date.parse("2026-11-03T23:59:00Z"));
  await orchestra.stewardTick();
  assert.ok(!chat.events.some((event) => event.metadata?.schedule?.action === "fired"));
  t.mock.timers.setTime(Date.parse("2026-11-04T00:00:30Z"));
  await orchestra.stewardTick();
  assert.ok(chat.events.some((event) => event.metadata?.schedule?.action === "fired"));
  assert.equal(orchestra.listSchedules(steward.id)[0].enabled, false, "a one-off closes after it ran");
  t.mock.timers.reset();
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.text.includes("아침 점검")));
});
