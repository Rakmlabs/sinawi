// How a snapped browser window and the chat share the width: one preference for the whole app,
// set by dragging the edge between them (BrowserDesktop). Every workspace's desktop reads the same
// value, so it lives in a tiny store rather than in one component's state.
import { useSyncExternalStore } from "react";
import { clampSplit, SPLIT_DEFAULT } from "./desktop-windows";

export const SPLIT_STORE = "orchestra.browser.split";

function stored(): number {
  try { const value = Number(localStorage.getItem(SPLIT_STORE)); return value ? clampSplit(value) : SPLIT_DEFAULT; } catch { return SPLIT_DEFAULT; }
}

let split: number | undefined;
const listeners = new Set<() => void>();
const current = () => (split ??= stored());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setDeskSplit(next: number): void {
  const value = clampSplit(next);
  if (value === current()) return;
  split = value;
  try { localStorage.setItem(SPLIT_STORE, String(value)); } catch { /* private window: this session only */ }
  for (const listener of listeners) listener();
}

export const useDeskSplit = () => useSyncExternalStore(subscribe, current, () => SPLIT_DEFAULT);
