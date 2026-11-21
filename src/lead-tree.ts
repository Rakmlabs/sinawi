// A lead's chats and, under each, the workers that chat (or an outside orchestrator through it) put
// to work: what the sidebar tree and the tab bar's chat list show (src/app/LeadChatList.tsx).
import type { AgentId, Session, SessionStatus } from "../server/types";
import { delegationWorkers } from "./conversation";
import { t } from "./i18n";
import { originLabel } from "./origin";

export type WorkerRow = { id: string; label: string; agent: AgentId; status: SessionStatus; task: string; startedAt: string; endedAt?: string };
export type ChatRow = { session: Session; lastAt: string; workers: WorkerRow[]; runningWorkers: number; openedBy?: string };

const lastAt = (session: Session) => session.events.at(-1)?.time ?? session.createdAt;

/** Workers of one chat, latest task first line as what it is doing. */
export function chatWorkers(session: Session, now = Date.now()): WorkerRow[] {
  return delegationWorkers(session, now).map((worker) => {
    const latest = worker.tasks.at(-1)!;
    const task = latest.event.text.split("\n").find((line) => line.trim())?.trim().slice(0, 160) ?? "";
    return { id: worker.id, label: worker.label, agent: worker.agent, status: worker.status as SessionStatus, task, startedAt: latest.startedAt, endedAt: latest.endedAt };
  });
}

/** A lead's chats, most recently active first, filtered by a search over titles, workers and who opened them. */
export function chatRows(chats: Session[], query = "", now = Date.now()): ChatRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return chats
    .map((session) => {
      const workers = chatWorkers(session, now);
      return { session, lastAt: lastAt(session), workers, runningWorkers: workers.filter((worker) => worker.status === "running").length, openedBy: session.origin ? originLabel(session.origin) : undefined };
    })
    .filter((row) => !needle || [row.session.title, row.openedBy ?? "", ...row.workers.flatMap((worker) => [worker.label, worker.task])].some((text) => text.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(b.session.status === "running") - Number(a.session.status === "running") || b.lastAt.localeCompare(a.lastAt));
}

/** "방금", "3분", "2시간", "4일": how long ago, short enough for a list row. */
export function shortAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t("ago.now");
  if (minutes < 60) return t("ago.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ago.hours", { n: hours });
  return t("ago.days", { n: Math.floor(hours / 24) });
}

// Tabs the user closed: hidden from the tab bar only (the chat stays, in the list and the sidebar).
const hiddenKey = (stewardId: string) => `sinawi.leadTabs.hidden.${stewardId}`;

export function hiddenTabs(stewardId: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Set<string> {
  try { return new Set(JSON.parse(storage?.getItem(hiddenKey(stewardId)) ?? "[]") as string[]); } catch { return new Set(); }
}

export function saveHiddenTabs(stewardId: string, ids: Set<string>, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(hiddenKey(stewardId), JSON.stringify([...ids].slice(-200))); } catch { /* a convenience only */ }
}

/** The tabs to show: closed ones stay hidden unless open now or running. */
export function visibleTabs(threads: Session[], hidden: Set<string>, activeId?: string): Session[] {
  return threads.filter((thread) => !hidden.has(thread.id) || thread.id === activeId || thread.status === "running");
}
