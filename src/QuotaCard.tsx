import type { AgentId } from "../server/types";
import type { ProviderQuota } from "../server/quota";
import { AgentMark } from "./AgentMark";
import { formatKst, resetCountdown, isQuotaStale } from "./quota-data";
const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
export function QuotaCard({ agent, provider, now, tokens, refreshing, onRefresh, tokenError, onRetryTokens }: { agent: AgentId; provider?: ProviderQuota; now: number; tokens?: number; refreshing?: boolean; onRefresh?: () => void; tokenError?: string; onRetryTokens?: () => void }) {
  return <section className="quota-provider" aria-label={`${names[agent]} 남은 한도`}>
    <div className="quota-heading"><h3><AgentMark agent={agent} size="small" />{names[agent]}</h3>{agent === "claude" && onRefresh && <button className="button light" disabled={refreshing} onClick={onRefresh}>{refreshing ? "확인 중…" : "지금 확인"}</button>}</div>
    {agent === "claude" && onRefresh && <p className="quota-note">지금 확인은 Haiku에 짧은 요청을 보내며 한도를 조금 사용합니다.</p>}
    {!provider?.windows.length ? <p className="quota-unavailable">{agent === "grok" ? "남은 한도 정보 제공 안 함" : "아직 확인된 남은 한도 정보가 없습니다."}</p> : provider.windows.map((window) => {
      const valid = Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100;
      const expired = isQuotaStale(provider, now) || Boolean(window.resetsAt && window.resetsAt * 1000 <= now);
      return <div key={window.key} className={`quota-window${valid && window.remainingPercent < 20 ? " low" : ""}${expired ? " expired" : ""}`}>
        <div className="quota-window-heading"><strong>{window.label}</strong><span>{valid ? `${window.remainingPercent.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}% 남음${expired ? " (마지막 확인)" : ""}` : "정보 없음"}</span></div>
        {valid && !expired && <div className="usage-bar" role="meter" aria-label={`${names[agent]} ${window.label} 남은 한도`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}><span style={{ width: `${window.remainingPercent}%` }} /></div>}
        <small>{isQuotaStale(provider, now) ? "오래된 확인 정보 · 다시 확인 필요 · " : ""}{resetCountdown(window.resetsAt, now)}{window.resetsAt ? ` · ${formatKst(window.resetsAt)}` : ""}</small>
      </div>;
    })}
    {provider?.credits && <p className="quota-note">크레딧: {Object.entries(provider.credits).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ")}</p>}
    {agent === "grok" && tokenError ? <div role="alert" className="quota-note"><p>세션 토큰 기록을 불러오지 못했습니다: {tokenError}</p><button className="button light" onClick={onRetryTokens}>기록 다시 시도</button></div> : agent === "grok" && <p className="quota-note">기록된 세션 입력·출력 합계: {tokens === undefined ? "정보 없음" : `${tokens.toLocaleString("ko-KR")} 토큰`}</p>}
    <p className="quota-updated">마지막 확인: {formatKst(provider?.updatedAt)}</p>
  </section>;
}
