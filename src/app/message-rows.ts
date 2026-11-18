import { canUndoAutoHandoff, type DelegationTask } from "../conversation";
import type { Session, SessionEvent } from "../../server/types";

/** Row callbacks: one stable object per list, so they never make a row look changed. */
export type RowHandlers = {
  onUndoHandoff: (eventId: string) => void;
  onOpenWorker: (workerId: string) => void;
  onPromote: (eventId: string) => void;
  onChoose: (option: string) => void;
  onExecutePlan: () => void;
};

/**
 * What one message row needs, narrowed from the session so an unrelated change (a new event, a
 * status push, a keystroke in the composer) leaves the row's props shallow-equal and React skips it.
 */
export type MessageRowProps = {
  e: SessionEvent;
  /** When the next event starts: the end of this row's computer-activity trail. */
  nextTime: string | undefined;
  sessionId: string;
  continued: boolean;
  /** Delegation rows only. */
  task: DelegationTask | undefined;
  /** Delegation rows only. */
  workerConfigs: Session["workerConfigs"];
  /** The latest handoff, undoable now. */
  undoable: boolean;
  isLatestHandoff: boolean;
  isLatestAssistant: boolean;
  showExecutePlan: boolean;
  /** The latest reply's numbered options; one shared empty array for every other row. */
  choiceOptions: readonly string[];
  streaming: boolean;
  /** The streaming row while a draft shows below it (the draft carries the caret). */
  drafting: boolean;
  /** Only rows with a button that `busy` disables get the real value. */
  busy: boolean;
  handlers: RowHandlers;
};

const NO_OPTIONS: readonly string[] = Object.freeze([]);

/** An assistant message right after another one from the same agent reads as one reply: no second header. */
export function continuesPrevious(events: SessionEvent[], index: number): boolean {
  const current = events[index], previous = events[index - 1];
  if (!current || !previous || current.agent === "user" || previous.agent !== current.agent) return false;
  const plain = (event: SessionEvent) => event.type !== "delegation" && event.type !== "handoff" && !event.metadata?.live;
  return plain(current) && plain(previous);
}

/** The props of the row for `events[index]`. */
export function messageRowProps(input: {
  active: Pick<Session, "id" | "status" | "permissionMode" | "workerConfigs">;
  events: SessionEvent[]; index: number;
  tasksById: Map<string, DelegationTask>;
  latestHandoffId: string | undefined; latestAssistantId: string | undefined;
  choiceOptions: string[]; streamingMessageId: string | undefined;
  busy: boolean; drafting: boolean; canExecutePlan: boolean; handlers: RowHandlers;
}): MessageRowProps {
  const { active, events, index, latestHandoffId, latestAssistantId } = input;
  const e = events[index];
  const isLatestHandoff = e.type === "handoff" && e.id === latestHandoffId;
  const isLatestAssistant = e.id === latestAssistantId;
  const isUser = e.agent === "user";
  const showExecutePlan = !isUser && isLatestAssistant && active.permissionMode === "plan" && active.status !== "running" && input.canExecutePlan && e.type === "message";
  const streaming = input.streamingMessageId === e.id;
  return {
    e,
    nextTime: events[index + 1]?.time,
    sessionId: active.id,
    continued: continuesPrevious(events, index),
    task: e.type === "delegation" ? input.tasksById.get(e.id) : undefined,
    workerConfigs: e.type === "delegation" ? active.workerConfigs : undefined,
    undoable: isLatestHandoff && canUndoAutoHandoff(e, active.status, latestHandoffId),
    isLatestHandoff,
    isLatestAssistant,
    showExecutePlan,
    choiceOptions: !isUser && isLatestAssistant && input.choiceOptions.length ? input.choiceOptions : NO_OPTIONS,
    streaming,
    drafting: streaming && input.drafting,
    busy: (isLatestHandoff || showExecutePlan) && input.busy,
    handlers: input.handlers,
  };
}
