import type { AgentId } from "../server/types";
import type { ProviderQuota } from "../server/quota";
import { AgentMark } from "./AgentMark";
import { formatKst, resetCountdown, isQuotaStale } from "./quota-data";
import { getLang, t } from "./i18n";
const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
export function QuotaCard({ agent, provider, now, tokens, refreshing, onRefresh, tokenError, onRetryTokens }: { agent: AgentId; provider?: ProviderQuota; now: number; tokens?: number; refreshing?: boolean; onRefresh?: () => void; tokenError?: string; onRetryTokens?: () => void }) {
  return <section className="quota-provider" aria-label={t("quotaCard.label", { agent: names[agent] })}>
    <div className="quota-heading"><h3><AgentMark agent={agent} size="small" />{names[agent]}</h3>{agent === "claude" && onRefresh && <button className="button light" disabled={refreshing} onClick={onRefresh}>{refreshing ? t("quotaCard.checking") : t("quotaCard.checkNow")}</button>}</div>
    {agent === "claude" && onRefresh && <p className="quota-note">{t("quotaCard.checkNote")}</p>}
    {!provider?.windows.length ? <p className="quota-unavailable">{agent === "grok" ? t("quotaCard.grokUnsupported") : t("quotaCard.noData")}</p> : provider.windows.map((window) => {
      const valid = Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100;
      const expired = isQuotaStale(provider, now) || Boolean(window.resetsAt && window.resetsAt * 1000 <= now);
      return <div key={window.key} className={`quota-window${valid && window.remainingPercent < 20 ? " low" : ""}${expired ? " expired" : ""}`}>
        <div className="quota-window-heading"><strong>{window.label}</strong><span>{valid ? `${t("quotaCard.remaining", { percent: window.remainingPercent.toLocaleString(getLang() === "en" ? "en-US" : "ko-KR", { maximumFractionDigits: 1 }) })}${expired ? t("quotaCard.lastChecked") : ""}` : t("common.noInfo")}</span></div>
        {valid && !expired && <div className="usage-bar" role="meter" aria-label={t("quotaCard.windowLabel", { agent: names[agent], window: window.label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}><span style={{ width: `${window.remainingPercent}%` }} /></div>}
        <small>{isQuotaStale(provider, now) ? t("quotaCard.stale") : ""}{resetCountdown(window.resetsAt, now)}{window.resetsAt ? ` · ${formatKst(window.resetsAt)}` : ""}</small>
      </div>;
    })}
    {provider?.credits && <p className="quota-note">{t("quotaCard.credits", { credits: Object.entries(provider.credits).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ") })}</p>}
    {agent === "grok" && tokenError ? <div role="alert" className="quota-note"><p>{t("quotaCard.tokensFailed", { error: tokenError })}</p><button className="button light" onClick={onRetryTokens}>{t("quotaCard.retryTokens")}</button></div> : agent === "grok" && <p className="quota-note">{t("quotaCard.tokens", { tokens: tokens === undefined ? t("common.noInfo") : t("quotaCard.tokenCount", { n: tokens.toLocaleString(getLang() === "en" ? "en-US" : "ko-KR") }) })}</p>}
    <p className="quota-updated">{t("quotaCard.updated", { time: formatKst(provider?.updatedAt) })}</p>
  </section>;
}
