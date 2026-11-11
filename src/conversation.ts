import { parseWorkerLog, workerLogSummary } from "./worker-log";
import { trimEvents } from "../server/events";
import type { AgentId, Session, SessionEvent, SessionStatus } from "../server/types";
import { t } from "./i18n";

export function conversationText(text: string): string {
  return text.replace(/<<DELEGATE\b[^<>]{0,500}>{1,2}[\s\S]*?<<?\/DELEGATE>{1,2}/gi, "")
    // The goal panel shows the checklist; a commander's goals read as one line each.
    // While a reply streams, the closing marker may not have arrived yet. Hide the app-only block
    // from its opening marker onward, then remove any orphan closing marker left by older output.
    .replace(/<<(CHECKLIST|NOTES)>>[\s\S]*?(?:<<\/\1>>|$)/giu, "")
    .replace(/<<\/(?:CHECKLIST|NOTES)>>/giu, "")
    // A question for another project's lead: the app sends it when the turn ends.
    .replace(/<<ASK\s+to="([^"\n]*)">>([\s\S]*?)<<\/ASK>>/gu, (_match, to: string, body: string) => `> **${t("conv.askTo", { to: to.trim() })}** ${body.trim().replace(/\n+/gu, " ")}`)
    .replace(/<<NEW_CHAT(?:\s+title="([^"\n]*)")?\s*>>([\s\S]*?)<<\/NEW_CHAT>>/gu, (_match, title: string | undefined, body: string) => `> **${title?.trim() ? t("conv.newChatTitled", { title: title.trim() }) : t("conv.newChat")}** ${body.trim().replace(/\n+/gu, " ")}`)
    .replace(/<<NEW_LEAD\s+name="([^"\n]*)"\s+cwd="([^"\n]*)"\s*>>[\s\S]*?<<\/NEW_LEAD>>/gu, (_match, name: string, cwd: string) => `> **${t("conv.newLead", { name: name.trim() })}** \`${cwd.trim()}\``)
    .replace(/<<GOAL([^>]*)>>([\s\S]*?)<<\/GOAL>>/gu, (_match, attrs: string, body: string) => {
      const key = /id\s*=\s*"([^"]*)"/u.exec(attrs)?.[1];
      const title = /title\s*=\s*"([^"]*)"/u.exec(attrs)?.[1] || body.trim().split("\n")[0].replace(/^#+\s*/u, "");
      return `- **${key ? `[${key}] ` : ""}${title}**`;
    })
    .trim();
}

/**
 * For a reply that is still streaming only (never for stored text): conversationText hides control
 * blocks once their closing marker arrives, so until then `<<ASK to="x">>…` or a half-written
 * `<<DELE` would show raw. Hide an unterminated block to the end, and a trailing partial marker.
 */
export function streamingText(text: string): string {
  return conversationText(text)
    .replace(/<<(?:DELEGATE|ASK|NEW_CHAT|NEW_LEAD|GOAL)\b[\s\S]*$/iu, "")
    .replace(/<<?\/?[A-Z_]*(?:\s[^<>]*)?>?$/u, "")
    .trimEnd();
}

export interface DelegationTask {
  event: SessionEvent;
  thread: SessionEvent[];
  status: SessionStatus;
  elapsed: string;
  /** Start and end (absent while running) of the task, for a live elapsed clock. */
  startedAt: string;
  endedAt?: string;
  activity: string;
}

export interface DelegationWorker {
  id: string;
  label: string;
  agent: AgentId;
  tasks: DelegationTask[];
  status: SessionStatus;
  elapsed: string;
  activity: string;
}

export function liveBadgeLabel(event: Pick<SessionEvent, "metadata">): string | undefined {
  if (event.metadata?.live === "status") return t("live.status");
  if (event.metadata?.live === "directive") return t("live.directive");
}

export function canPromoteLive(event: Pick<SessionEvent, "metadata">): boolean {
  return event.metadata?.live === "status" && event.metadata.ambiguous === true && event.metadata.promoted !== true;
}

const lastEventTime = (session: Session) => {
  const time = session.events.at(-1)?.time;
  return time ? Date.parse(time) : Number.NEGATIVE_INFINITY;
};

/**
 * True when `snapshot` (a whole session from a REST response) is older than `current`: `current`
 * already has a later event the snapshot lacks, e.g. from a WebSocket frame that overtook it.
 */
export function isStaleSnapshot(current: Session, snapshot: Session): boolean {
  const latest = current.events.at(-1);
  if (!latest || snapshot.events.some((event) => event.id === latest.id)) return false;
  return lastEventTime(current) >= lastEventTime(snapshot);
}

/**
 * `snapshot`: `incoming` is a whole session from a REST call, which may be older than WebSocket
 * frames already applied; its status would roll a finished run back to "running", so the run state
 * of the newer copy wins. WebSocket frames arrive in order and always win (an incremental frame may
 * carry no events at all, just a status change).
 */
export function mergeSession(current: Session, incoming: Session, { snapshot = false }: { snapshot?: boolean } = {}): Session {
  const events = trimEvents([...new Map([...current.events, ...incoming.events].map((event) => [event.id, event])).values()]);
  if (snapshot && isStaleSnapshot(current, incoming)) return { ...incoming, status: current.status, endedAt: current.endedAt, events };
  return { ...incoming, events };
}

export function canUndoAutoHandoff(event: SessionEvent, status: SessionStatus, latestHandoffId: string | undefined): boolean {
  return event.id === latestHandoffId && event.type === "handoff" && event.metadata?.auto === true && event.metadata.undone !== true && status !== "running";
}

/** `m:ss` between two instants (ms), clamped at zero. */
export function formatElapsed(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const defaultNames: Record<AgentId, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };

/** A default label ("Codex", "Codex 2") names the original agent; a custom label stays. */
function relabel(label: string | undefined, from: AgentId, to: AgentId): string | undefined {
  if (!label) return undefined;
  return new RegExp(`^${defaultNames[from]}(?: \\d+)?$`, "u").test(label) ? defaultNames[to] : label;
}

export function delegationTasks(session: Session, now: number): DelegationTask[] {
  const tasks: DelegationTask[] = [];
  session.events.forEach((event, start) => {
    if (event.type !== "delegation") return;
    const next = session.events.findIndex((item, index) => index > start && (item.type === "delegation" || item.agent === "user"));
    const isWorkerEvent = (item: SessionEvent) => item.agent !== "user" && item.role !== "orchestrator" && item.role !== "planner" && !item.metadata?.live;
    const thread = session.events.slice(start + 1).filter((item, offset) =>
      isWorkerEvent(item) && (item.delegationId
        ? item.delegationId === event.id
        : (next < 0 || start + 1 + offset < next) && item.agent === event.agent),
    );
    const last = thread.at(-1);
    const reverseRetry = [...thread].reverse().findIndex((item) => item.taskStatus === "running");
    const retryStart = reverseRetry < 0 ? -1 : thread.length - 1 - reverseRetry;
    const currentAttempt = thread.slice(retryStart + 1);
    const terminal = [...currentAttempt].reverse().find((item) => item.taskStatus && item.taskStatus !== "running");
    const status = terminal?.taskStatus ?? (currentAttempt.some((item) => item.type === "error") ? "error" : event.delegationId ? session.status : next >= 0 ? "done" : session.status);
    const end = terminal?.time ?? (status === "running" ? undefined : last?.time ?? session.endedAt ?? event.time);
    const current = [...thread].reverse().find((item) => item.role === "worker" && item.agent !== "user");
    // After a quota fallback the worker that actually runs is another agent: show its name and model, not the original's.
    const switched = current && current.agent !== event.agent && current.agent !== "user" && event.agent !== "user";
    const displayedEvent = !current ? event : switched
      ? { ...event, agent: current.agent, model: current.model, reasoningEffort: current.reasoningEffort, workerLabel: relabel(event.workerLabel, event.agent as AgentId, current.agent as AgentId) }
      : { ...event, agent: current.agent, model: current.model ?? event.model, reasoningEffort: current.reasoningEffort ?? event.reasoningEffort };
    tasks.push({ event: displayedEvent, thread, status, elapsed: formatElapsed(Date.parse(event.time), end ? Date.parse(end) : now), startedAt: event.time, endedAt: end, activity: (last ? workerLogSummary(parseWorkerLog(last)) : "") || t("delegation.preparing") });
  });
  return tasks;
}

export function delegationWorkers(session: Session, now: number): DelegationWorker[] {
  const workers = new Map<string, DelegationTask[]>();
  for (const task of delegationTasks(session, now)) {
    if (task.event.metadata?.deletedWorker) continue;
    const tasks = workers.get(task.event.workerId ?? task.event.agent) ?? [];
    tasks.push(task);
    workers.set(task.event.workerId ?? task.event.agent, tasks);
  }
  return [...workers].map(([id, tasks]) => {
    const latest = tasks.at(-1)!;
    const status = tasks.some((task) => task.status === "running") ? "running" : latest.status;
    const agent = latest.event.agent as AgentId;
    const config = session.workerConfigs?.find((worker) => worker.id === id);
    const label = latest.event.workerLabel ?? config?.label ?? ({ codex: "Codex", claude: "Claude", grok: "Grok Build" })[agent];
    return { id, label, agent, tasks, status, elapsed: latest.elapsed, activity: latest.activity };
  });
}

export function mainConversation(session: Session): SessionEvent[] {
  const firstHandoff = session.events.find((event) => event.type === "handoff");
  let orchestrator: AgentId = firstHandoff?.metadata?.from ?? session.agent;
  // Legacy sessions have no role metadata. Handoff messages carry the new role explicitly.
  const tasks = delegationTasks(session, Date.now());
  const workerEvents = new Set(tasks.flatMap((task) => task.thread.map((event) => event.id)));
  return session.events.filter((event) => {
    if (event.metadata?.live === "status" || event.metadata?.live === "directive") return event.type === "message";
    if (event.type === "handoff") { if (event.agent !== "user") orchestrator = event.agent; return true; }
    if (event.type === "delegation") return true;
    if (event.type === "error" || event.type === "warning") return event.role !== "worker" && !workerEvents.has(event.id);
    if (event.type === "status" && event.text === "중지됨") return true;
    // A lead's schedule or skill change: a small card in the conversation.
    if (event.type === "status" && (event.metadata?.schedule || event.metadata?.leadSkill)) return true;
    if (event.type !== "message") return false;
    if (event.agent === "user") return true;
    if (event.role === "worker" || event.role === "planner") return false;
    return (event.role === "orchestrator" || (event.agent === orchestrator && !workerEvents.has(event.id))) && Boolean(conversationText(event.text));
  });
}
