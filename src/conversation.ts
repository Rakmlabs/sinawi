import { parseWorkerLog, workerLogSummary } from "./worker-log";
import type { AgentId, Session, SessionEvent, SessionStatus } from "../server/types";
import { t } from "./i18n";

export function conversationText(text: string): string {
  return text.replace(/<<DELEGATE\s+to=["'][^"'<>]+["']>>[\s\S]*?<<\/DELEGATE>>/gi, "").trim();
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

export function mergeSession(current: Session, incoming: Session): Session {
  const events = [...new Map([...current.events, ...incoming.events].map((event) => [event.id, event])).values()].slice(-2000);
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
    const displayedEvent = current ? { ...event, agent: current.agent, model: current.model ?? event.model, reasoningEffort: current.reasoningEffort ?? event.reasoningEffort } : event;
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
    if (event.type !== "message") return false;
    if (event.agent === "user") return true;
    if (event.role === "worker" || event.role === "planner") return false;
    return (event.role === "orchestrator" || (event.agent === orchestrator && !workerEvents.has(event.id))) && Boolean(conversationText(event.text));
  });
}
