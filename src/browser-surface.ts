export const RECENT_STORE = "orchestra.browser.recent";

export type RecentSite = { url: string; title: string; at: number };

export function pushRecent(list: RecentSite[], url: string, title: string, now = Date.now(), limit = 8): RecentSite[] {
  if (!/^https?:\/\//.test(url)) return list;
  const key = url.replace(/\/$/, "");
  return [{ url, title: title || url.replace(/^https?:\/\//, ""), at: now }, ...list.filter((item) => item.url.replace(/\/$/, "") !== key)].slice(0, limit);
}

/** Saved tabs of a window, and which one was on screen (it moves with the window in and out of the app). */
export function loadSavedTabs<T extends { id: string }>(raw: string | null, make: (tab: { url?: string; title?: string }) => T, blank: () => T): { tabs: T[]; activeId: string } {
  try {
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved?.tabs) && saved.tabs.length) {
      const tabs: T[] = saved.tabs.map(make);
      const index = Number.isInteger(saved.active) && saved.active >= 0 && saved.active < tabs.length ? saved.active : 0;
      return { tabs, activeId: tabs[index].id };
    }
  } catch { /* ignore */ }
  const tab = blank();
  return { tabs: [tab], activeId: tab.id };
}
