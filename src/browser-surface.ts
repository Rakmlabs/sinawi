export const RECENT_STORE = "orchestra.browser.recent";

export type RecentSite = { url: string; title: string; at: number };

export function pushRecent(list: RecentSite[], url: string, title: string, now = Date.now(), limit = 8): RecentSite[] {
  if (!/^https?:\/\//.test(url)) return list;
  const key = url.replace(/\/$/, "");
  return [{ url, title: title || url.replace(/^https?:\/\//, ""), at: now }, ...list.filter((item) => item.url.replace(/\/$/, "") !== key)].slice(0, limit);
}
