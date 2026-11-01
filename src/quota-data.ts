import type { ProviderQuota } from "../server/quota";
import { getLang, t } from "./i18n";

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
  if (!resetsAt || !Number.isFinite(resetsAt)) return t("quota.resetUnknown");
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60_000);
  if (minutes <= 0) return t("quota.resetPassed");
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  const parts = [days ? t("time.days", { n: days }) : "", hours ? t("time.hours", { n: hours }) : "", rest || (!days && !hours) ? t("time.minutes", { n: rest }) : ""];
  return t("quota.resetsIn", { time: parts.filter(Boolean).join(" ") });
}
export function formatKst(value: string | number | undefined): string {
  const date = new Date(typeof value === "number" ? value * 1000 : value ?? "");
  if (!Number.isFinite(date.getTime())) return t("common.noInfo");
  return `${new Intl.DateTimeFormat(getLang() === "en" ? "en-US" : "ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} KST`;
}
