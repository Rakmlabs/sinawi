// The project lead in the UI (server/steward.ts): its name, the line under it in the sidebar, and
// the messages the app puts in its chat for it (another lead's question or answer, the daily report).
import type { Session } from "../server/types";
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
    if (isReportPrompt(event.text)) continue;
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
