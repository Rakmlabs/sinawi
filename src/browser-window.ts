// A browser window outside the app window: the same BrowserPanel, in its own OS window (a second
// Tauri window in the app, a popup in a plain browser on `npm run dev`). It loads this same page with
// `?browser-window=<window id>&workspace=<workspace id>` (main.tsx renders BrowserWindowApp for it),
// keeps the in-app window's id so its tabs come along, and has its own socket to the server
// (`/ws/browser`), which sends it its workspace's agents' browser commands (server/browser-windows.ts).
import { useSyncExternalStore } from "react";
import { appKeyFragment } from "./app-key";

export type BrowserWindowTarget = { id: string; workspaceId: string };

const TOKEN = /^[\w-]{1,64}$/u;

/** The window this page is, from its address; undefined for the app window itself. */
export function browserWindowTarget(search: string): BrowserWindowTarget | undefined {
  const params = new URLSearchParams(search);
  const id = params.get("browser-window") ?? "";
  const workspaceId = params.get("workspace") ?? "";
  return TOKEN.test(id) && TOKEN.test(workspaceId) ? { id, workspaceId } : undefined;
}

export function browserWindowPath(target: BrowserWindowTarget): string {
  return `/?${new URLSearchParams({ "browser-window": target.id, workspace: target.workspaceId })}`;
}

export function browserWindowSocketPath(target: BrowserWindowTarget): string {
  return `/ws/browser?${new URLSearchParams({ workspace: target.workspaceId, id: target.id })}`;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const tauri = (): Invoke | undefined => (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
const popups = new Map<string, Window>();
const popupName = (id: string) => `sinawi-browser-${id}`;

/**
 * Opens the window, or brings it to the front when it is already open. False when it could not be
 * opened (a popup blocker in a plain browser, an older app binary without the command).
 */
export async function openBrowserWindow(target: BrowserWindowTarget, title: string): Promise<boolean> {
  const invoke = tauri();
  if (invoke) {
    try { await invoke("browser_window_open", { id: target.id, workspace: target.workspaceId, title }); return true; } catch { return false; }
  }
  const known = popups.get(target.id);
  if (known && !known.closed) { known.focus(); return true; }
  // The dev link's key is this tab's alone (app-key.ts): hand it to the popup the same way, in the fragment.
  const opened = window.open(`${browserWindowPath(target)}${appKeyFragment()}`, popupName(target.id), "popup,width=1180,height=820");
  if (!opened) return false;
  popups.set(target.id, opened);
  opened.focus();
  return true;
}

/** Closes this window (called from inside it). */
export function closeThisBrowserWindow(target: BrowserWindowTarget): void {
  const invoke = tauri();
  if (invoke) void invoke("browser_window_close", { id: target.id }).catch(() => window.close());
  else window.close();
}

// ---- the app window's view of the windows outside it (a `browser-windows` frame from the server) ----

let outside: BrowserWindowTarget[] = [];
/** Counts the server's reports; 0 while the list is not known (no report yet, or the app's socket dropped). */
let report = 0;
let reports = 0;
const listeners = new Set<() => void>();

export function setOutsideWindows(list: unknown): void {
  const next = (Array.isArray(list) ? list : []).filter((item): item is BrowserWindowTarget => Boolean(item) && typeof item.id === "string" && typeof item.workspaceId === "string");
  if (JSON.stringify(next) !== JSON.stringify(outside)) outside = next;
  report = ++reports;
  for (const listener of listeners) listener();
}

/** The app's socket dropped: which windows are open out there is not known until the server says again. */
export function outsideWindowsUnknown(): void {
  if (!report) return;
  report = 0;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const NONE: BrowserWindowTarget[] = [];
/** Every workspace's browser windows that are open outside the app window right now. */
export const useOutsideWindows = () => useSyncExternalStore(subscribe, () => outside, () => NONE);
/** Changes with every report from the server; 0 while the list is not known. */
export const useOutsideReport = () => useSyncExternalStore(subscribe, () => report, () => 0);

/** A window outside the app asked to come back in: `detail` is its BrowserWindowTarget. */
export const DOCK_EVENT = "orchestra:browser-dock";

// ---- which windows were moved out (saved, so one that is gone out there comes back with its tabs) ----

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const outsideKey = (workspaceId: string) => `orchestra.browser.outside.${workspaceId}`;
const local = (): Store | undefined => { try { return localStorage; } catch { return undefined; } };

/** Ids of this workspace's windows that were moved out of the app and have not come back. */
export function rememberedOutside(workspaceId: string, store: Store | undefined = local()): string[] {
  try {
    const list = JSON.parse(store?.getItem(outsideKey(workspaceId)) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && TOKEN.test(id)) : [];
  } catch { return []; }
}

function saveOutside(workspaceId: string, ids: string[], store: Store | undefined): void {
  try { if (ids.length) store?.setItem(outsideKey(workspaceId), JSON.stringify(ids)); else store?.removeItem(outsideKey(workspaceId)); } catch { /* this session only */ }
}

/** When each window was moved out in this app session: one that is still opening is not lost yet. */
const movedOutAt = new Map<string, number>();
/** How long a window may take to open outside and connect (create the window, load the page, get its key). */
export const OUTSIDE_OPENING_MS = 20_000;

export function rememberOutside(workspaceId: string, id: string, store: Store | undefined = local(), now = Date.now()): void {
  movedOutAt.set(id, now);
  const ids = rememberedOutside(workspaceId, store);
  if (!ids.includes(id)) saveOutside(workspaceId, [...ids, id], store);
}

/** Moved out moments ago: its window may not have connected yet. */
export function stillOpening(id: string, now = Date.now()): boolean {
  const at = movedOutAt.get(id);
  return at !== undefined && now - at < OUTSIDE_OPENING_MS;
}

export function forgetOutside(workspaceId: string, id: string, store: Store | undefined = local()): void {
  movedOutAt.delete(id);
  const ids = rememberedOutside(workspaceId, store);
  if (ids.includes(id)) saveOutside(workspaceId, ids.filter((item) => item !== id), store);
}

/**
 * Windows that were moved out but are not open out there: closed with their own close button, or
 * the app was restarted. They come back into the app (minimized) instead of taking their tabs away.
 */
export function lostOutside(remembered: readonly string[], open: readonly BrowserWindowTarget[], workspaceId: string): string[] {
  return remembered.filter((id) => !open.some((item) => item.id === id && item.workspaceId === workspaceId));
}

/** How long a window may be missing (its socket reconnecting, the server restarting) before it counts as closed. */
export const OUTSIDE_GRACE_MS = 6_000;
