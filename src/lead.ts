// The project lead in the UI (server/steward.ts): its name, the line under it in the sidebar, and
// the messages the app puts in its chat for it (another lead's question or answer, the daily report).
import type { Session, Steward } from "../server/types";
import { conversationText } from "./conversation";

/** The name the user gave the lead, or its project folder's name (as the server's stewardName). */
export function leadName(session: Pick<Session, "steward" | "cwd">): string {
  const name = session.steward?.name?.trim();
  if (name) return name;
  return session.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? session.cwd;
}

export type LeadMessage = { from: string; kind: "ask" | "reply"; body: string };

const LEAD_MESSAGE = /^\[담당 「(.+?)」(이 보낸 질문|의 답)\]\n/u;

/** Another lead's question or answer, as the app wrote it into this chat; the app's instructions left out. */
export function leadMessage(text: string): LeadMessage | undefined {
  const match = LEAD_MESSAGE.exec(text);
  if (!match) return undefined;
  const body = text.slice(match[0].length).replace(/\n+\[앱\][\s\S]*$/u, "").trim();
  return { from: match[1], kind: match[2] === "의 답" ? "reply" : "ask", body };
}

export const isReportPrompt = (text: string) => text.startsWith("[앱 — 정기 보고]");

const SCHEDULE_PROMPT = /^\[일정 "(.*?)"\]\n/u;

/** A schedule's prompt the app sent into the lead's chat (Orchestra.scheduleTick). */
export function schedulePrompt(text: string): { title: string; body: string } | undefined {
  const match = SCHEDULE_PROMPT.exec(text);
  return match ? { title: match[1], body: text.slice(match[0].length).trim() } : undefined;
}

/** When a schedule runs, in words: a one-off's local time, or the cron and its zone. */
export function scheduleWhen(schedule: { at?: string; cron?: string; timezone?: string }, locale = "ko-KR"): string {
  if (schedule.cron) return `cron ${schedule.cron}${schedule.timezone ? ` (${schedule.timezone})` : ""}`;
  if (!schedule.at) return "";
  const date = new Date(schedule.at);
  return Number.isNaN(date.getTime()) ? schedule.at : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...(schedule.timezone ? { timeZone: schedule.timezone } : {}) });
}

/** Markdown read as plain text: one line in the sidebar has no room for headings or code marks. */
const plain = (text: string) => text.replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, "").replace(/[*_`~]+/gu, "").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");

/** The last thing said in the lead's chat, for the line under its name. */
export function leadPreview(session: Session): string {
  return plain(lastSaid(session));
}

function lastSaid(session: Session): string {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index];
    if (event.type !== "message" || event.role === "worker") continue;
    if (event.agent !== "user") {
      const text = conversationText(event.text);
      if (text) return text;
      continue;
    }
    if (isReportPrompt(event.text) || schedulePrompt(event.text)) continue;
    const lead = leadMessage(event.text);
    return lead ? `「${lead.from}」 ${lead.body}` : event.text;
  }
  return "";
}

/** A steady hue per lead, so each one keeps its color in the sidebar. */
export function leadHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** One line about a lead for a picker: the first line of its instructions, else its folder. */
export function stewardDescription(steward: Pick<Steward, "systemPrompt" | "cwds">): string {
  const line = steward.systemPrompt.split("\n").map((item) => item.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/u, "").trim()).find(Boolean);
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return steward.cwds[0] ?? "";
}

/** The Steward a chat is a thread of (chats saved before leads were entities use their own id). */
export const stewardIdOf = (session: Pick<Session, "id" | "steward">) => session.steward ? session.steward.id ?? session.id : undefined;

export type LeadGroup = {
  id: string;
  name: string;
  steward?: Steward;
  /** The chat used last; the sidebar's row for the lead opens it. Unset for a lead with no chat yet. */
  latest?: Session;
  /** Its other chats, most recently used first. */
  others: Session[];
};

const lastUsed = (session: Session) => session.events.at(-1)?.time ?? session.createdAt;

/**
 * Lead chats grouped by their lead, as the sidebar lists them: one row per lead (its latest chat)
 * with its other chats under it. Leads that have no chat yet come last, so they can start one.
 */
export function leadGroups(sessions: Session[], stewards: Steward[] = []): LeadGroup[] {
  const byId = new Map<string, Session[]>();
  for (const session of sessions) {
    const id = stewardIdOf(session);
    if (id) byId.set(id, [...(byId.get(id) ?? []), session]);
  }
  const known = new Map(stewards.map((steward) => [steward.id, steward]));
  const groups: LeadGroup[] = [...byId.entries()].map(([id, chats]) => {
    const [latest, ...others] = [...chats].sort((a, b) => lastUsed(b).localeCompare(lastUsed(a)) || b.createdAt.localeCompare(a.createdAt));
    return { id, name: known.get(id)?.name || leadName(latest), steward: known.get(id), latest, others };
  }).sort((a, b) => lastUsed(b.latest!).localeCompare(lastUsed(a.latest!)));
  for (const steward of stewards) if (!byId.has(steward.id)) groups.push({ id: steward.id, name: steward.name, steward, others: [] });
  return groups;
}
