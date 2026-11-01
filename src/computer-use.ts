/**
 * App side of computer use: relays `computer-command` frames from the server to the native
 * `computer_exec` command and keeps a small store for the UI. Approval is not decided here:
 * `computer_exec` shows a native macOS alert for a session without a grant, and only that alert
 * grants anything. This page (user-writable, like the server) can only relay, revoke or stop.
 */
import type { ComputerActivity, ComputerDialogContext } from "../server/computer-bridge";

export type ComputerSessionGrant = { key: string; agent?: string; title?: string; sessionId?: string; workspaceId: string; since: string; last: string };
export type ComputerState = { active: boolean; stopped: boolean; sessions: ComputerSessionGrant[]; busy: number };
export type ComputerSnapshot = { state: ComputerState; activity: ComputerActivity[]; native: boolean };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriInternals = { invoke: Invoke; metadata?: { currentWindow?: { label?: string } } };

const internals = (): TauriInternals | undefined => (globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
/** Only the main app window executes commands; other windows (and plain browsers) only show state. */
export const isExecutor = (tauri = internals()) => Boolean(tauri) && (tauri?.metadata?.currentWindow?.label ?? "main") === "main";

const EMPTY: ComputerState = { active: false, stopped: false, sessions: [], busy: 0 };
let snapshot: ComputerSnapshot = { state: EMPTY, activity: [], native: Boolean(internals()) };
const listeners = new Set<() => void>();
const emit = (next: Partial<ComputerSnapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach((l) => l()); };
export const subscribeComputer = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getComputerSnapshot = () => snapshot;

/** Activities for one session that happened in [from, to) — the chat shows them after the message at `from`. */
export function activitiesBetween(list: readonly ComputerActivity[], sessionId: string, from: string | undefined, to: string | undefined): ComputerActivity[] {
  const start = from ? Date.parse(from) : -Infinity;
  const end = to ? Date.parse(to) : Infinity;
  return list.filter((a) => a.sessionId === sessionId && Date.parse(a.time) >= start && Date.parse(a.time) < end);
}

/** Merges activity entries by id, keeping time order and the newest 500. */
export function mergeActivity(current: readonly ComputerActivity[], incoming: readonly ComputerActivity[]): ComputerActivity[] {
  const byId = new Map(current.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-500);
}

export const imageUrl = (name: string) => `/api/computer/image/${encodeURIComponent(name)}`;

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type NativeOutcome = { value?: unknown; grant?: "once" | "session" | null };

async function execute(command: { id: string; nonce?: string; key: string; action: string; args: Record<string, unknown>; context?: ComputerDialogContext }) {
  const tauri = internals();
  if (!tauri || !isExecutor(tauri)) return; // a plain browser tab never answers; the app window does
  let body: { ok: boolean; result?: unknown; error?: string; grant?: "once" | "session" };
  try {
    const out = (await tauri.invoke("computer_exec", { id: command.id, key: command.key, action: command.action, args: command.args, context: command.context ?? null })) as NativeOutcome;
    body = { ok: true, result: out?.value, ...(out?.grant ? { grant: out.grant } : {}) };
  } catch (error) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
    if (message === "duplicate") return;
    body = { ok: false, error: message };
  }
  // The nonce was sent only to this connection; the server accepts no result without it.
  await post("/api/computer/result", { id: command.id, nonce: command.nonce ?? "", ...body }).catch(() => undefined);
}

/** Handles every `computer-*` WebSocket frame. */
export function handleComputerMessage(message: { type: string; [key: string]: any }) {
  const tauri = internals();
  switch (message.type) {
    case "computer-command": void execute(message as never); break;
    case "computer-state": emit({ state: { ...EMPTY, ...(message.state as ComputerState) } }); break;
    case "computer-activity": emit({ activity: mergeActivity(snapshot.activity, [message.activity as ComputerActivity]) }); break;
    case "computer-revoked": if (tauri && isExecutor(tauri)) void tauri.invoke("computer_revoke", { key: message.key ?? null }).catch(() => undefined); break;
  }
}

export async function stopComputer(reason = "ui") {
  const tauri = internals();
  if (tauri) await tauri.invoke("computer_stop").catch(() => undefined);
  await post("/api/computer/stop", { reason }).catch(() => undefined);
}

export async function revokeComputer(key: string) {
  const tauri = internals();
  if (tauri) await tauri.invoke("computer_revoke", { key }).catch(() => undefined);
  await post("/api/computer/revoke", { key }).catch(() => undefined);
}

let started = false;
/** Loads state/activity and wires the native stop hotkey. */
export function startComputerUse() {
  if (started) return;
  started = true;
  void fetch("/api/computer/state").then((r) => r.ok ? r.json() : undefined).then((state?: ComputerState) => { if (state) emit({ state: { ...EMPTY, ...state } }); }).catch(() => undefined);
  void fetch("/api/computer/activity").then((r) => r.ok ? r.json() : []).then((list: ComputerActivity[]) => emit({ activity: mergeActivity(snapshot.activity, list) })).catch(() => undefined);
  if (internals() && isExecutor()) {
    // The native watcher (Esc held / ⌃⌥⌘.) already revoked the app's grants; tell the server to drop its queue.
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ reason?: string }>("computer-stop", (event) => { void post("/api/computer/stop", { reason: event.payload?.reason ?? "hotkey" }).catch(() => undefined); })).catch(() => undefined);
  }
}
