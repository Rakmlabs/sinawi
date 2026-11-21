// Chats waiting on the user: a permission question from a running agent, or an approval a lead's
// MCP tool asked for. The sidebar marks those chats and their lead ("needs you"), so they show
// without opening anything (review round 2, §3.4).
import { useSyncExternalStore } from "react";

/** Same names as PermissionPrompts / AppApprovals dispatch (the server's pushes, re-sent as window events). */
const PERMISSIONS_EVENT = "orchestra:permissions";
const APP_APPROVALS_EVENT = "orchestra:app-approvals";

type Waiting = { sessionId?: string };

let permissions = new Set<string>();
let approvals = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let installed = false;

const ids = (list: unknown): Set<string> => new Set(Array.isArray(list) ? (list as Waiting[]).map((item) => item?.sessionId).filter((id): id is string => typeof id === "string" && Boolean(id)) : []);

function publish(): void {
  snapshot = new Set([...permissions, ...approvals]);
  for (const listener of listeners) listener();
}

/** Takes a pushed list (or a fetched one) of permission questions or pending approvals. */
export function takeWaiting(kind: "permissions" | "approvals", list: unknown): void {
  if (kind === "permissions") permissions = ids(list); else approvals = ids(list);
  publish();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(PERMISSIONS_EVENT, (event) => takeWaiting("permissions", (event as CustomEvent).detail));
  window.addEventListener(APP_APPROVALS_EVENT, (event) => takeWaiting("approvals", (event as CustomEvent).detail));
  void fetch("/api/permissions").then((res) => res.ok ? res.json() : undefined).then((body) => { if (body) takeWaiting("permissions", (body as { requests?: unknown }).requests); }).catch(() => undefined);
  void fetch("/api/app-approvals?status=pending").then((res) => res.ok ? res.json() : undefined).then((body) => { if (body) takeWaiting("approvals", Array.isArray(body) ? body : (body as { approvals?: unknown }).approvals); }).catch(() => undefined);
}

const subscribe = (listener: () => void) => { install(); listeners.add(listener); return () => { listeners.delete(listener); }; };
const empty: ReadonlySet<string> = new Set();

/** Ids of the chats waiting on the user right now. */
export function useNeedsYou(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot, () => empty);
}

export function waitingNow(): ReadonlySet<string> { return snapshot; }
