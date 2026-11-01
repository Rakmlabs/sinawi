/**
 * Per-tab back/forward history kept by the app (not the WebView).
 * The iframe's own history.back() walks the *joint* session history: on the first page of a tab it
 * navigates the top-level app window instead (→ tauri://localhost, app crashes). So we never call it.
 */
export type TabHistory = { entries: string[]; index: number; pending?: number };

export const emptyHistory = (): TabHistory => ({ entries: [], index: -1 });

/** Only http(s) hrefs are accepted; anything unparsable is ignored. */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

/** Record a location the frame reported. */
export function recordLocation(history: TabHistory, value: unknown): TabHistory {
  const href = safeHref(value);
  if (!href) return history;
  if (history.pending !== undefined && history.entries[history.pending] === href) return { entries: history.entries, index: history.pending };
  if (history.entries[history.index] === href) return { entries: history.entries, index: history.index };
  const entries = [...history.entries.slice(0, history.index + 1), href].slice(-100);
  return { entries, index: entries.length - 1 };
}

/** Start a back/forward traversal; returns the href to load (with location.replace) or undefined. */
export function traverse(history: TabHistory, delta: -1 | 1): { history: TabHistory; href: string } | undefined {
  const target = history.index + delta;
  const href = history.entries[target];
  if (target < 0 || !href) return undefined;
  return { history: { ...history, pending: target }, href };
}

export const canGo = (history: TabHistory | undefined, delta: -1 | 1) => Boolean(history && history.entries[history.index + delta]);
