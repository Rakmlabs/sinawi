import type { PendingInstruction, Session, SessionEvent } from "./types.js";

/** Low-cost default Grok model for read-only status answers. */
export const STATUS_AGENT_MODEL = "grok-4.7-build-fast";

export interface LiveWorker {
  id: string;
  label: string;
  agent: string;
}

export type LiveIntent = "stop" | "status" | "directive" | "ambiguous";

export interface LiveClassification {
  intent: LiveIntent;
  targetWorkerId?: string;
}

const stopPattern = /^(?:작업\s*)?(?:중지|중단|멈춰|멈추|그만)(?:해|요|줘|주세요)?[.!…]*$|^(?:stop|cancel|abort)[.!]*$/iu;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keysFor(worker: LiveWorker, workers: LiveWorker[]): string[] {
  const keys = [worker.label, worker.id];
  if (workers.filter((item) => item.agent === worker.agent).length === 1) keys.push(worker.agent);
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort((left, right) => right.length - left.length);
}

function mentions(text: string, key: string): boolean {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(key)}(?=$|[^\\p{L}\\p{N}_]|\\p{Script=Hangul})`, "iu");
  return pattern.test(` ${text}`);
}

function workerByAddress(text: string, workers: LiveWorker[]): LiveWorker | undefined {
  let best: { worker: LiveWorker; index: number; length: number } | undefined;
  for (const worker of workers) {
    for (const key of keysFor(worker, workers)) {
      const match = new RegExp(`${escapeRegExp(key)}\\s*(?:한테|에게)`, "iu").exec(text);
      if (!match) continue;
      if (!best || match.index < best.index || (match.index === best.index && key.length > best.length)) {
        best = { worker, index: match.index, length: key.length };
      }
    }
  }
  return best?.worker;
}

function workerByMention(text: string, workers: LiveWorker[]): LiveWorker | undefined {
  const lower = text.toLowerCase();
  let best: { worker: LiveWorker; index: number; length: number } | undefined;
  for (const worker of workers) {
    for (const key of keysFor(worker, workers)) {
      if (!mentions(text, key)) continue;
      const index = lower.indexOf(key.toLowerCase());
      if (index < 0) continue;
      if (!best || index < best.index || (index === best.index && key.length > best.length)) {
        best = { worker, index, length: key.length };
      }
    }
  }
  return best?.worker;
}

function isDirective(text: string): boolean {
  if (/(?:하라고|해\s*줘|해줘|시켜|부터\s*봐|보라고|봐\s*달라고|봐달라고)/u.test(text)) return true;
  return /(?:한테|에게)/u.test(text) && /(?:해|봐|보|시켜)/u.test(text);
}

function isBareWorkerQuestion(text: string, workers: LiveWorker[]): boolean {
  return workers.some((worker) => keysFor(worker, workers).some((key) => new RegExp(`^${escapeRegExp(key)}(?:\\s*(?:는|은|이))?\\s*[?？]?$`, "iu").test(text)));
}

function isStatusQuestion(text: string, workers: LiveWorker[]): boolean {
  if (isBareWorkerQuestion(text, workers)) return true;
  return /(?:뭐\s*하|뭐\s*해|뭐야|뭐니|상태|진행|어디까지|어떻게\s*되|상황)/u.test(text);
}

export function classifyLiveMessage(text: string, workers: LiveWorker[] = []): LiveClassification {
  const fence = text.indexOf("```orchestra-attachments");
  const raw = compact(fence >= 0 ? text.slice(0, fence) : text);
  if (!raw) return { intent: "ambiguous" };
  if (stopPattern.test(raw)) return { intent: "stop" };
  const target = workerByAddress(raw, workers) ?? workerByMention(raw, workers);
  const asks = isStatusQuestion(raw, workers);
  const orders = isDirective(raw);
  const targetWorkerId = target?.id;
  if (orders && !asks) return { intent: "directive", targetWorkerId };
  const hardOrder = /(?:하라고|시켜|부터\s*봐|보라고)/u.test(raw);
  const softAsk = /(?:뭐\s*하|뭐\s*해|상태|진행|어디까지|어떻게\s*되)/u.test(raw);
  if (asks && orders && hardOrder && !softAsk) return { intent: "directive", targetWorkerId };
  if (asks) return { intent: "status", targetWorkerId };
  return { intent: "ambiguous", targetWorkerId };
}

function clip(text: string, limit = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
}

function groupKey(event: SessionEvent): string {
  if (event.workerLabel) return event.workerLabel;
  if (event.workerId) return event.workerId;
  if (event.role === "worker") return event.agent;
  return "총괄";
}

/** Recent tools, results, errors and delegations, grouped so a status answer can name each worker. */
export function statusDigest(session: Pick<Session, "status" | "agent" | "events" | "pendingInstructions">): string {
  const lines = [`세션: ${session.status}`, `총괄: ${session.agent}`];
  const pending = session.pendingInstructions ?? [];
  if (pending.length) {
    lines.push("대기 중인 지시:");
    for (const item of pending) lines.push(`- ${item.targetWorkerId ?? "총괄"}: ${clip(item.text)}`);
  }
  const relevant = session.events.filter((event) => !event.metadata?.live && ["delegation", "tool", "command", "edit", "error", "status", "message"].includes(event.type));
  const groups = new Map<string, SessionEvent[]>();
  for (const event of relevant) {
    const key = groupKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  for (const [key, events] of groups) {
    lines.push(`[${key}]`);
    for (const event of events.slice(-6)) lines.push(`${event.type}: ${clip(event.text)}`);
  }
  return lines.join("\n");
}

export function statusPrompt(question: string, digest: string): string {
  return [
    "당신은 진행 중인 작업의 상태를 묻는 질문에만 답하는 에이전트입니다.",
    "아래 로그에 있는 사실만 한국어로 짧게 답하세요.",
    "파일을 수정하지 말고, 도구를 호출하지 말고, 작업을 지시하거나 위임하지 마세요.",
    "<<DELEGATE>>를 출력하지 마세요.",
    "로그에 없으면 모른다고 말하세요.",
    "",
    "작업 로그:",
    digest || "아직 기록된 작업이 없습니다.",
    "",
    "질문:",
    question,
  ].join("\n");
}

export function instructionSuffix(items: PendingInstruction[]): string {
  if (!items.length) return "";
  return [
    "사용자가 진행 중에 보낸 지시입니다. 이미 시작한 작업을 폐기하지 말고, 이 턴에서 이 지시를 반영하세요.",
    ...items.map((item) => `- ${item.text}`),
  ].join("\n");
}

/** Messages queued during a run that ended before any turn read them, put ahead of the newest one. */
export function carriedOverPrompt(items: PendingInstruction[], prompt: string): string {
  if (!items.length) return prompt;
  return [
    "앞선 작업이 진행 중일 때 보냈지만 아직 처리되지 않은 메시지입니다(보낸 순서).",
    ...items.map((item) => `- ${item.text}`),
    "",
    "가장 최근 메시지:",
    prompt,
    "",
    "앞선 메시지와 최근 메시지가 어긋나면 최근 메시지를 따르세요.",
  ].join("\n");
}

export function pushInstruction(pending: PendingInstruction[] | undefined, item: PendingInstruction, limit = 20): PendingInstruction[] {
  return [...(pending ?? []), item].slice(-limit);
}

export function takePending(pending: PendingInstruction[] | undefined, role: "worker" | "orchestrator" | "planner" | undefined, workerId?: string): { taken: PendingInstruction[]; rest: PendingInstruction[] } {
  const items = pending ?? [];
  if (role !== "worker" && role !== "orchestrator") return { taken: [], rest: items };
  const taken = items.filter((item) => role === "worker" ? Boolean(workerId) && item.targetWorkerId === workerId : !item.targetWorkerId);
  const ids = new Set(taken.map((item) => item.id));
  return { taken, rest: items.filter((item) => !ids.has(item.id)) };
}
