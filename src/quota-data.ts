import type { ProviderQuota } from "../server/quota";

export function isQuotaStale(provider: ProviderQuota | undefined, now = Date.now()): boolean {
  const updated = Date.parse(provider?.updatedAt ?? "");
  return !Number.isFinite(updated) || now - updated > 24 * 60 * 60 * 1000 || updated - now > 5 * 60 * 1000;
}

export function remainingQuota(provider: ProviderQuota | undefined, now = Date.now()): number | undefined {
  if (isQuotaStale(provider, now)) return undefined;
  const values = provider?.windows.filter((window) => Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 && (!window.resetsAt || window.resetsAt * 1000 > now)).map((window) => window.remainingPercent) ?? [];
  return values.length ? Math.min(...values) : undefined;
}
export function resetCountdown(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "초기화 시각 정보 없음";
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60_000);
  if (minutes <= 0) return "초기화 시각 지남 · 다시 확인 필요";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return `${days ? `${days}일 ` : ""}${hours ? `${hours}시간 ` : ""}${rest || (!days && !hours) ? `${rest}분 ` : ""}후 초기화`;
}
export function formatKst(value: string | number | undefined): string {
  const date = new Date(typeof value === "number" ? value * 1000 : value ?? "");
  if (!Number.isFinite(date.getTime())) return "정보 없음";
  return `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} KST`;
}
