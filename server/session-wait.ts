import { originLabel } from "../src/origin.js";
import type { Session, SessionEvent } from "./types.js";
import { sessionSummary } from "./steward.js";
import type { Steward } from "./types.js";

/** One line of a chat for a caller outside the app: who said it and what. */
export interface WaitMessage {
  id: string;
  from: string;
  text: string;
  time: string;
  sentBy?: string;
}

const MAX_MESSAGE_CHARS = 6_000;

/** The conversation's own lines: the user's (or an orchestrator's) messages, the lead's answers and errors; not worker logs or tool noise. */
function conversationLine(event: SessionEvent): boolean {
  if (event.role === "worker") return false;
  if (event.type === "message") return true;
  return event.type === "error" || event.type === "warning";
}

function fromLabel(event: SessionEvent): string {
  // The name the app shows (Grok Bot, Codex), not the client's raw id (review L4).
  if (event.agent === "user") return event.metadata?.via ? originLabel(event.metadata.via) : "user";
  return event.type === "message" ? event.agent : `${event.agent} (${event.type})`;
}

/**
 * What wait_for_session answers (GET /api/sessions/:id/wait): whether the chat is done, the lead's
 * last answer, its checklist, and the conversation lines after `afterId` (all of them, newest last,
 * when it is unset or no longer in the chat). `working` is Orchestra.isWorking.
 */
/** `since`: the events after `afterId`, archive included (server/event-archive.ts eventsSince). */
export function waitResult(session: Session, working: boolean, afterId?: string, steward?: Steward, maxMessages = 30, since?: { events: SessionEvent[]; found: boolean }) {
  const summary = sessionSummary(session, steward);
  const events = session.events;
  const start = afterId ? events.findIndex((event) => event.id === afterId) + 1 : 0;
  const lines = (since?.events ?? events.slice(start)).filter(conversationLine);
  const messages: WaitMessage[] = lines.slice(-maxMessages).map((event) => ({
    id: event.id, from: fromLabel(event), time: event.time,
    text: event.text.length > MAX_MESSAGE_CHARS ? `${event.text.slice(0, MAX_MESSAGE_CHARS)}…` : event.text,
    ...(event.metadata?.via ? { sentBy: `${event.metadata.via.client} (${event.metadata.via.kind})` } : {}),
  }));
  const done = !working;
  return {
    id: session.id, title: session.title, status: session.status, done,
    lastAnswer: summary.lastAnswer, checklist: summary.checklist, pendingMerge: summary.pendingMerge,
    ...(summary.steward ? { lead: { id: summary.steward.id, name: summary.steward.name } } : {}),
    messages, skipped: Math.max(0, lines.length - messages.length),
    // The id given is in neither the chat nor its archive: these are the latest messages, not "since".
    ...(since && !since.found ? { cursorLost: true } : {}),
    lastEventId: events.at(-1)?.id ?? null,
    next: done
      ? (summary.pendingMerge ? "끝났습니다. 담당이 끝낸 브랜치가 사용자의 병합 승인을 기다립니다(앱의 병합 카드)." : "끝났습니다. 이어서 시킬 일은 send_message로 같은 채팅에 보내세요.")
      : "아직 진행 중입니다. after_event_id에 lastEventId를 넣어 wait_for_session을 다시 부르세요.",
  };
}
