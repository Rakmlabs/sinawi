import type { EventType, SessionEvent } from "../server/types";

export type ItemStatus = "in_progress" | "completed" | "failed";
export interface WorkerLogRow {
  event: SessionEvent;
  type: EventType;
  text: string;
  itemId?: string;
  status?: ItemStatus;
  exitCode?: number;
  output?: string;
  changes?: { path: string; kind: "add" | "modify" | "delete" }[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseWorkerLog(event: SessionEvent): WorkerLogRow {
  const fallback: WorkerLogRow = { event, type: event.type, text: event.text };
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(event.text)); } catch { return fallback; }
  if (!envelope) return fallback;
  const item = object(envelope.item) ?? envelope;
  const itemType = item.type;
  if (typeof itemType !== "string") return fallback;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : undefined;
  const status: ItemStatus | undefined = item.status === "failed" || (exitCode !== undefined && exitCode !== 0)
    ? "failed"
    : item.status === "completed" || envelope.type === "item.completed" || exitCode === 0
      ? "completed"
      : item.status === "in_progress" || envelope.type === "item.started" || envelope.type === "item.updated"
        ? "in_progress" : undefined;
  if (itemType === "command_execution") {
    return { event, type: "command", itemId, status: status ?? "in_progress", exitCode,
      text: typeof item.command === "string" ? item.command : "",
      output: typeof item.aggregated_output === "string" ? item.aggregated_output : undefined };
  }
  if (itemType === "file_change") {
    const changes: NonNullable<WorkerLogRow["changes"]> = [];
    if (Array.isArray(item.changes)) for (const value of item.changes) {
      const change = object(value);
      if (typeof change?.path !== "string") continue;
      changes.push({ path: change.path, kind: change.kind === "add" || change.kind === "delete" ? change.kind : "modify" });
    }
    return { event, type: "edit", itemId, status, text: "파일 변경 내역이 없습니다.", changes: Array.isArray(item.changes) ? changes : undefined };
  }
  if (itemType === "agent_message" || itemType === "reasoning") {
    return { event, type: "message", itemId, text: typeof item.text === "string" ? item.text : "" };
  }
  return fallback;
}

/** Keep the first event's identity/order so an expanded output survives live updates. */
export function workerLogRows(events: SessionEvent[]): WorkerLogRow[] {
  const rows: WorkerLogRow[] = [];
  const items = new Map<string, number>();
  let legacyScope = 0;
  for (const event of events) {
    if (event.type === "delegation" || event.agent === "user") legacyScope += 1;
    const row = parseWorkerLog(event);
    const key = row.itemId ? JSON.stringify([event.sessionId, event.delegationId ?? legacyScope, event.agent, row.type, row.itemId]) : undefined;
    const index = key ? items.get(key) : undefined;
    if (index === undefined) {
      if (key) items.set(key, rows.length);
      rows.push(row);
    } else {
      const previous = rows[index];
      // A delayed start must not undo an already completed command.
      if (previous.status && previous.status !== "in_progress" && row.status === "in_progress") continue;
      rows[index] = { ...previous, ...row, event: previous.event,
        text: row.type === "command" ? row.text || previous.text : row.text,
        changes: row.changes ?? previous.changes,
        output: row.output ?? previous.output,
        exitCode: row.exitCode ?? previous.exitCode };
    }
  }
  return rows;
}

export function workerLogSummary(row: WorkerLogRow): string {
  return row.changes?.length ? row.changes.map((change) => change.path).join(", ") : row.text.replace(/\s+/g, " ").trim() || (row.type === "command" ? "명령을 확인할 수 없습니다." : "");
}
