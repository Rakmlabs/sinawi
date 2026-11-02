import type { EventType, SessionEvent } from "../server/types";
import { t } from "./i18n";

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
    return { event, type: "edit", itemId, status, text: t("workerLog.noChanges"), changes: Array.isArray(item.changes) ? changes : undefined };
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
  return row.changes?.length ? row.changes.map((change) => change.path).join(", ") : row.text.replace(/\s+/g, " ").trim() || (row.type === "command" ? t("workerLog.unknownCommand") : "");
}

/** A transcript line: a call (tool/command/edit) with its result folded in, or any other row as-is. */
export interface WorkerLogItem {
  row: WorkerLogRow;
  /** Short verb shown in bold ("명령", "파일 읽기"); empty for prose/status rows. */
  name: string;
  /** One-line argument after the verb. */
  detail: string;
  /** Full output shown when expanded (merged result, command output, or a multi-line detail). */
  output?: string;
}

// server/cli.ts normalizeCliLine: Grok `tool_call_update` → "결과: …", Claude `tool_result` → "도구 결과: …".
const resultPrefixes = ["도구 결과: ", "결과: "];
// A Claude `user` turn that only reports a loaded skill; it answers no call.
const skillPrefix = "스킬 불러옴: ";

export function toolResultText(row: WorkerLogRow): string | undefined {
  if (row.type !== "tool") return undefined;
  const prefix = resultPrefixes.find((value) => row.text.startsWith(value));
  return prefix === undefined ? undefined : row.text.slice(prefix.length);
}

/** "파일 읽기: path" → name + detail (describeToolCall shape). A multi-line remainder becomes output. */
export function splitToolCall(text: string): { name: string; detail: string; output?: string } {
  const at = text.indexOf(": ");
  const head = at > 0 && at <= 40 && !text.slice(0, at).includes("\n") ? text.slice(0, at) : "";
  const rest = head ? text.slice(at + 2) : text;
  if (!head && !rest.includes("\n")) return { name: rest.trim(), detail: "" };
  const trimmed = rest.trim();
  if (!trimmed.includes("\n")) return { name: head, detail: trimmed };
  return { name: head, detail: summarizeOutput(trimmed).line, output: trimmed };
}

const isCall = (row: WorkerLogRow) => row.type === "command" || row.type === "edit" || (row.type === "tool" && !toolResultText(row) && !row.text.startsWith(skillPrefix));

/**
 * Fold result rows into the call they answer. Claude batches parallel calls then their results in order
 * (FIFO); Grok interleaves call/update, and a call without output emits nothing, so it takes the newest call.
 */
export function groupWorkerLog(rows: WorkerLogRow[]): WorkerLogItem[] {
  const items: WorkerLogItem[] = [];
  let pending: WorkerLogItem[] = [];
  let lastAnswered: WorkerLogItem | undefined;
  let previousWasResult = false;
  for (const row of rows) {
    const result = toolResultText(row);
    if (result !== undefined) {
      const target = row.event.agent === "grok" ? pending.at(-1) ?? lastAnswered : pending.shift() ?? (previousWasResult ? lastAnswered : undefined);
      if (row.event.agent === "grok") pending = [];
      if (target) {
        if (target.output !== result) target.output = target.output ? `${target.output}\n${result}` : result;
        lastAnswered = target;
      } else items.push({ row, name: "", detail: "", output: result });
      previousWasResult = true;
      continue;
    }
    if (previousWasResult) pending = [];
    previousWasResult = false;
    lastAnswered = undefined;
    if (row.type === "command") {
      items.push({ row, name: t("worker.run"), detail: row.text.replace(/\s+/g, " ").trim(), output: row.output });
    } else if (row.type === "edit") {
      const count = row.changes?.length ?? 0;
      if (row.changes) items.push({ row, name: t("event.edit"), detail: count === 1 ? row.changes[0].path : count ? t("worker.fileCount", { n: count }) : row.text });
      else {
        const text = row.text.trim();
        items.push({ row, name: t("event.edit"), detail: summarizeOutput(text).line, output: text.includes("\n") ? text : undefined });
      }
    } else if (row.type === "tool") {
      const item = { row, ...splitToolCall(row.text) };
      items.push(item);
      if (isCall(row)) pending.push(item);
    } else items.push({ row, name: "", detail: "" });
  }
  return items;
}

const clipLine = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** First meaningful line (JSON collapsed to one line) and how many more lines the full text has. */
export function summarizeOutput(text: string, max = 160): { line: string; extraLines: number } {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  if (!lines[0]) return { line: "", extraLines: 0 };
  const extraLines = lines.length - 1;
  // An image read back as tool output (a screenshot) is base64 data: name it instead of dumping it.
  if (/"type"\s*:\s*"image"/.test(lines[0]) && /"data"\s*:\s*"[A-Za-z0-9+/=]{100}/.test(lines[0])) return { line: t("worker.imageOutput"), extraLines: 0 };
  if (/^[[{]/.test(lines[0])) {
    try { return { line: clipLine(JSON.stringify(JSON.parse(lines.join("\n"))), max), extraLines }; } catch { /* not JSON */ }
  }
  const first = lines.find((line) => /[\p{L}\p{N}]/u.test(line)) ?? lines.find((line) => line.trim()) ?? "";
  return { line: clipLine(first.replace(/\s+/g, " ").trim(), max), extraLines };
}

const inlineMarkdown = (line: string) => line
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/(\*\*|__)(.+?)\1/g, "$2")
  .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=$|[\s).,:;!?])/g, "$1$2")
  .replace(/`([^`]*)`/g, "$1")
  .replace(/\s+/g, " ")
  .trim();

/** One plain line for a markdown brief: a short generic heading ("## 목표") yields to the line under it. */
export function cleanBriefTitle(markdown: string, max = 140): string {
  let heading = "";
  let fenced = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const isHeading = /^\s*#{1,6}\s/.test(raw);
    const line = inlineMarkdown(raw.replace(/^(\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+))+/, "").replace(/\s#+\s*$/, ""));
    if (!line) continue;
    if (isHeading && !heading && line.length <= 12) { heading = line; continue; }
    return clipLine(line, max);
  }
  return clipLine(heading, max);
}
