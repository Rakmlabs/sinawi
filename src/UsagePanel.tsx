import { useQuotas } from "./QuotaContext";
import { QuotaCard } from "./QuotaCard";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentId } from "../server/types";
import { aggregateUsage, filterUsageRuns, usageBarWidth, type UsagePeriod, type UsageRow, type UsageRunRecord, type UsageWorkspace } from "./usage-data";
import "./usage.css";

export type { UsagePeriod, UsageRow, UsageRunRecord, UsageWorkspace } from "./usage-data";

const number = new Intl.NumberFormat("ko-KR");
const agentNames: Record<AgentId, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const periodLabels: Record<UsagePeriod, string> = { today: "오늘", "7d": "7일", "30d": "30일" };
const workspaceLabels: Record<UsageWorkspace, string> = { all: "전체", personal: "개인", company: "회사" };

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

function UsageRows({ title, rows, agentRows = false }: { title: string; rows: UsageRow[]; agentRows?: boolean }) {
  const max = Math.max(1, ...rows.map((row) => row.totalTokens ?? 0));
  return <section className="usage-ledger">
    <h3>{title}</h3>
    <ol>
      {rows.map((row) => <li key={row.key}>
        <div className="usage-row-heading"><strong>{agentRows ? agentNames[row.key as AgentId] ?? row.key : row.key}</strong><span>{row.totalTokens === undefined ? "입력·출력 정보 없음" : `입력·출력 ${number.format(row.totalTokens)} 토큰`}</span></div>
        <div className="usage-bar" aria-hidden="true"><span style={{ width: `${usageBarWidth(row.totalTokens, max)}%` }} /></div>
        <small>입력 {row.hasInput ? number.format(row.input) : "—"} · 캐시 {row.hasCached ? number.format(row.cached) : "—"} · 출력 {row.hasOutput ? number.format(row.output) : "—"} · 추론 {row.hasReasoning ? number.format(row.reasoning) : "—"} · {row.runs}회 · {formatDuration(row.durationMs)}{row.hasCost ? ` · $${row.costUsd.toFixed(4)}` : ""}</small>
      </li>)}
    </ol>
  </section>;
}

export function UsagePanel({ initialWorkspace = "all" }: { initialWorkspace?: UsageWorkspace }) {
  const quotas = useQuotas();
  const [view, setView] = useState<"remaining" | "history">("remaining");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const [runs, setRuns] = useState<UsageRunRecord[]>([]);
  const [period, setPeriod] = useState<UsagePeriod>("today");
  const [workspace, setWorkspace] = useState<UsageWorkspace>(initialWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/usage");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "사용량을 불러오지 못했습니다.");
      setRuns(Array.isArray(payload) ? payload : Array.isArray(payload?.runs) ? payload.runs : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "사용량을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => filterUsageRuns(runs, period, workspace), [runs, period, workspace]);
  const summary = useMemo(() => aggregateUsage(filtered), [filtered]);


  return <section className="usage-panel" aria-label="에이전트 사용량">
    <div className="usage-segment" aria-label="사용량 보기"><button aria-pressed={view === "remaining"} onClick={() => setView("remaining")}>남은 한도</button><button aria-pressed={view === "history"} onClick={() => setView("history")}>기록</button></div>
    {view === "remaining" ? <div className="quota-overview">
      <p className="quota-note">계정 전체의 플랜 한도입니다. 실행 기록과 별도로 표시됩니다.</p>
      {quotas.loading && <p role="status">남은 한도를 불러오는 중…</p>}
      {quotas.error && <div role="alert"><p>{quotas.error}</p><button className="button light" onClick={() => void quotas.reload()}>다시 시도</button></div>}
      {(["codex", "claude", "grok"] as const).map((agent) => <QuotaCard key={agent} agent={agent} provider={quotas.providers.find((item) => item.agent === agent)} now={now} tokenError={error} onRetryTokens={() => void load()} tokens={aggregateUsage(runs.filter((run) => run.agent === agent)).byAgent[0]?.totalTokens} refreshing={quotas.refreshing} onRefresh={() => void quotas.refreshClaude()} />)}
    </div> : <>
    <div className="usage-controls">
      <div className="usage-segment" aria-label="기간">{(["today", "7d", "30d"] as const).map((value) => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{periodLabels[value]}</button>)}</div>
      <div className="usage-segment" aria-label="작업 공간">{(["all", "personal", "company"] as const).map((value) => <button key={value} aria-pressed={workspace === value} onClick={() => setWorkspace(value)}>{workspaceLabels[value]}</button>)}</div>
    </div>
    {loading ? <p className="usage-state" role="status">사용량을 불러오는 중…</p> : error ? <div className="usage-state" role="alert"><p>{error}</p><button onClick={() => void load()}>다시 시도</button></div> : !filtered.length ? <p className="usage-state">선택한 기간과 작업 공간에 기록된 실행이 없습니다.</p> : <>
      <dl className="usage-totals">
        <div><dt>입력</dt><dd>{summary.totals.hasInput ? number.format(summary.totals.input) : "—"}</dd></div>
        <div><dt>캐시</dt><dd>{summary.totals.hasCached ? number.format(summary.totals.cached) : "—"}</dd></div>
        <div><dt>출력</dt><dd>{summary.totals.hasOutput ? number.format(summary.totals.output) : "—"}</dd></div>
        <div><dt>추론</dt><dd>{summary.totals.hasReasoning ? number.format(summary.totals.reasoning) : "—"}</dd></div>
        <div><dt>실행</dt><dd>{number.format(summary.totals.runs)}회</dd></div>
        <div><dt>비용</dt><dd>{summary.totals.hasCost ? `$${summary.totals.costUsd.toFixed(4)}` : "—"}</dd></div>
      </dl>
      <div className="usage-columns"><UsageRows title="모델별" rows={summary.byModel} /><UsageRows title="에이전트별" rows={summary.byAgent} agentRows /></div>
    </>}
    </>}
  </section>;
}
