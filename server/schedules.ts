import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A lead's schedule: a prompt the app sends to the lead's chat at a time (once) or on a cron
 * pattern. The lead makes these itself through its tools (lead-tools.ts) or the user does in the
 * lead's settings. Fired from the minute tick (Orchestra.stewardTick), stored in schedules.json.
 */
export interface Schedule {
  id: string;
  stewardId: string;
  title: string;
  /** What the lead gets in its chat when the schedule fires. */
  prompt: string;
  /** ISO time for a one-off schedule. */
  at?: string;
  /** 5-field cron (minute hour day-of-month month day-of-week) for a repeating one. */
  cron?: string;
  /** IANA zone the cron fields and a zone-less `at` are read in. */
  timezone: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  /** Set when the app was off for longer than MISSED_GRACE_MS and the run was skipped. */
  lastMissedAt?: string;
  createdBy: "user" | "lead";
  createdAt: string;
  updatedAt?: string;
}

export interface ScheduleInput {
  title?: unknown;
  prompt?: unknown;
  at?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
}

/**
 * Missed-fire rule: a run that came due while the app was off still runs once if it is at most this
 * late; older ones are skipped (a cron moves on to its next time, a one-off is closed).
 */
export const MISSED_GRACE_MS = 24 * 60 * 60_000;
export const SCHEDULE_LIMIT = 50;
const PROMPT_LIMIT = 8_000;
const TITLE_LIMIT = 120;

export const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function validTimezone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// ---------- cron ----------

interface CronFields { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; dayAny: boolean; weekdayAny: boolean }

function cronField(text: string, min: number, max: number, label: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  const any = text === "*" || text === "?";
  for (const part of text.split(",")) {
    const match = /^(\*|\?|\d+)(?:-(\d+))?(?:\/(\d+))?$/u.exec(part.trim());
    if (!match) throw new Error(`cron ${label} 값이 올바르지 않습니다: ${part}`);
    const star = match[1] === "*" || match[1] === "?";
    const start = star ? min : Number(match[1]);
    const end = match[2] !== undefined ? Number(match[2]) : star || match[3] ? max : start;
    const step = match[3] ? Number(match[3]) : 1;
    if (start < min || end > max || start > end || step < 1) throw new Error(`cron ${label} 범위(${min}-${max})를 벗어났습니다: ${part}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, any };
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) throw new Error("cron은 '분 시 일 월 요일' 다섯 칸입니다 (예: '0 9 * * 1-5').");
  const minute = cronField(parts[0], 0, 59, "분");
  const hour = cronField(parts[1], 0, 23, "시");
  const day = cronField(parts[2], 1, 31, "일");
  const month = cronField(parts[3], 1, 12, "월");
  const weekday = cronField(parts[4], 0, 7, "요일");
  // 7 is Sunday too.
  if (weekday.values.has(7)) { weekday.values.delete(7); weekday.values.add(0); }
  return { minute: minute.values, hour: hour.values, day: day.values, month: month.values, weekday: weekday.values, dayAny: day.any, weekdayAny: weekday.any };
}

/** Wall-clock parts of `instant` in `zone`, as a UTC timestamp (so the arithmetic below is zone-free). */
function wallClock(instant: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
}

/** The instant whose wall-clock time in `zone` is `wall` (a UTC-encoded wall time). */
function fromWallClock(wall: number, zone: string): number {
  let guess = wall - (wallClock(wall, zone) - wall);
  guess = wall - (wallClock(guess, zone) - guess);
  return guess;
}

/** First cron time strictly after `after`, read in `zone`. Undefined when none within ~5 years. */
export function nextCronRun(expression: string, after: Date, zone = systemTimezone()): Date | undefined {
  const cron = parseCron(expression);
  const dayMatches = (date: Date) => {
    const dom = cron.day.has(date.getUTCDate());
    const dow = cron.weekday.has(date.getUTCDay());
    // Standard cron: when both are restricted, either one matching is enough.
    if (cron.dayAny && cron.weekdayAny) return true;
    if (cron.dayAny) return dow;
    if (cron.weekdayAny) return dom;
    return dom || dow;
  };
  let wall = Math.floor(wallClock(after.getTime(), zone) / 60_000) * 60_000 + 60_000;
  const limit = wall + 5 * 366 * 24 * 60 * 60_000;
  while (wall < limit) {
    const date = new Date(wall);
    if (!cron.month.has(date.getUTCMonth() + 1)) { wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); continue; }
    if (!dayMatches(date)) { wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1); continue; }
    if (!cron.hour.has(date.getUTCHours())) { wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1); continue; }
    if (!cron.minute.has(date.getUTCMinutes())) { wall += 60_000; continue; }
    const instant = fromWallClock(wall, zone);
    if (instant > after.getTime()) return new Date(instant);
    wall += 60_000;
  }
  return undefined;
}

/** `2026-11-04T09:00` (read in `zone`) or a full ISO time with an offset. */
export function parseAt(text: string, zone = systemTimezone()): Date {
  const trimmed = text.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(trimmed);
  if (local) {
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
    return new Date(fromWallClock(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)), zone));
  }
  const date = new Date(trimmed);
  if (!/\d{4}-\d{2}-\d{2}T/u.test(trimmed) || Number.isNaN(date.getTime())) throw new Error(`시각을 읽지 못했습니다: ${text} (예: 2026-11-04T09:00)`);
  return date;
}

export function nextRun(schedule: Pick<Schedule, "at" | "cron" | "timezone">, after: Date): Date | undefined {
  if (schedule.cron) return nextCronRun(schedule.cron, after, schedule.timezone);
  if (schedule.at) return new Date(schedule.at);
  return undefined;
}

// ---------- create / patch ----------

const text = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : undefined;

/** Builds a new schedule from untrusted input (API body or a lead's tool call). Throws on bad input. */
export function createSchedule(stewardId: string, input: ScheduleInput, createdBy: Schedule["createdBy"], now = new Date()): Schedule {
  const schedule: Schedule = { id: randomUUID(), stewardId, title: "", prompt: "", timezone: systemTimezone(), enabled: true, createdBy, createdAt: now.toISOString() };
  return applySchedulePatch(schedule, input, now, true);
}

export function applySchedulePatch(current: Schedule, input: ScheduleInput, now = new Date(), creating = false): Schedule {
  const next: Schedule = { ...current };
  if (input.title !== undefined) next.title = text(input.title, TITLE_LIMIT) ?? "";
  if (input.prompt !== undefined) next.prompt = text(input.prompt, PROMPT_LIMIT) ?? "";
  if (input.timezone !== undefined) {
    const zone = text(input.timezone, 80) || systemTimezone();
    if (!validTimezone(zone)) throw new Error(`알 수 없는 시간대입니다: ${zone}`);
    next.timezone = zone;
  }
  const timing = input.at !== undefined || input.cron !== undefined || input.timezone !== undefined;
  if (input.cron !== undefined) {
    const cron = text(input.cron, 120);
    if (cron) { parseCron(cron); next.cron = cron; delete next.at; } else delete next.cron;
  }
  if (input.at !== undefined) {
    const at = text(input.at, 60);
    if (at) { next.at = parseAt(at, next.timezone).toISOString(); delete next.cron; } else delete next.at;
  }
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (!next.prompt) throw new Error("일정에 보낼 내용(prompt)을 적으세요.");
  if (!next.at && !next.cron) throw new Error("한 번(at) 또는 반복(cron) 시각을 정하세요.");
  if (!next.title) next.title = next.prompt.split("\n")[0].slice(0, 60);
  if (timing || creating || (input.enabled === true && !current.enabled)) {
    const upcoming = nextRun(next, now);
    if (next.at && upcoming && upcoming.getTime() <= now.getTime()) throw new Error("이미 지난 시각입니다. 앞으로의 시각을 정하세요.");
    if (!upcoming) throw new Error("이 cron은 앞으로 실행될 시각이 없습니다.");
    next.nextRunAt = upcoming.toISOString();
  }
  if (!creating) next.updatedAt = now.toISOString();
  return next;
}

// ---------- firing ----------

export type ScheduleOutcome = { schedule: Schedule; action: "fire" | "missed" };

/**
 * What the minute tick does with each due schedule. Mutates the schedules (next/last run times,
 * a one-off closed) and returns the ones to send or report as skipped.
 */
export function dueSchedules(schedules: Iterable<Schedule>, now: Date): ScheduleOutcome[] {
  const out: ScheduleOutcome[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled || !schedule.nextRunAt) continue;
    const due = new Date(schedule.nextRunAt).getTime();
    if (Number.isNaN(due) || due > now.getTime()) continue;
    const action = now.getTime() - due <= MISSED_GRACE_MS ? "fire" : "missed";
    if (action === "fire") schedule.lastRunAt = now.toISOString();
    else schedule.lastMissedAt = now.toISOString();
    const upcoming = schedule.cron ? nextCronRun(schedule.cron, now, schedule.timezone) : undefined;
    if (upcoming) schedule.nextRunAt = upcoming.toISOString();
    else { delete schedule.nextRunAt; schedule.enabled = false; }
    out.push({ schedule, action });
  }
  return out;
}

/** One line for the chat card and the lead's tool output. */
export function describeSchedule(schedule: Schedule): string {
  const when = schedule.cron ? `cron \`${schedule.cron}\` (${schedule.timezone})` : `한 번 ${schedule.at}`;
  return `${schedule.title} — ${when}${schedule.enabled ? schedule.nextRunAt ? `, 다음 ${schedule.nextRunAt}` : "" : ", 꺼짐"}`;
}

// ---------- storage ----------

export const schedulesPath = (dataDir: string) => join(dataDir, "schedules.json");

export async function loadSchedules(dataDir: string): Promise<Schedule[]> {
  try {
    const parsed = JSON.parse(await readFile(schedulesPath(dataDir), "utf8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { schedules?: unknown })?.schedules;
    return Array.isArray(list) ? list.filter((item): item is Schedule => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.stewardId === "string" && typeof item.prompt === "string")) : [];
  } catch { return []; }
}

let writeQueue: Promise<void> = Promise.resolve();
export function saveSchedules(dataDir: string, schedules: Schedule[]): Promise<void> {
  const body = `${JSON.stringify({ schedules }, null, 2)}\n`;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const file = schedulesPath(dataDir);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, file);
  });
  return writeQueue;
}
