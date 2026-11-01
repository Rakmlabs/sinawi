import { useQuotas } from "./QuotaContext";
import { QuotaCard } from "./QuotaCard";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentId } from "../server/types";
import { aggregateUsage, filterUsageRuns, usageBarWidth, type UsagePeriod, type UsageRow, type UsageRunRecord, type UsageWorkspace } from "./usage-data";
import "./usage.css";
import { getLang, t, translatedMap } from "./i18n";

export type { UsagePeriod, UsageRow, UsageRunRecord, UsageWorkspace } from "./usage-data";

const numberFormats = { ko: new Intl.NumberFormat("ko-KR"), en: new Intl.NumberFormat("en-US") };
const number = { format: (value: number) => numberFormats[getLang()].format(value) };
const agentNames: Record<AgentId, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const periodLabels = translatedMap<UsagePeriod>({ today: "usage.today", "7d": "usage.7d", "30d": "usage.30d" });
const workspaceLabels = translatedMap<UsageWorkspace>({ all: "usage.all", personal: "workspace.personal", company: "workspace.company" });

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return t("time.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? t("time.minSec", { m: minutes, s: rest }) : t("time.minutes", { n: minutes });
}

function UsageRows({ title, rows, agentRows = false }: { title: string; rows: UsageRow[]; agentRows?: boolean }) {
  const max = Math.max(1, ...rows.map((row) => row.totalTokens ?? 0));
  return <section className="usage-ledger">
    <h3>{title}</h3>
    <ol>
      {rows.map((row) => <li key={row.key}>
        <div className="usage-row-heading"><strong>{agentRows ? agentNames[row.key as AgentId] ?? row.key : row.key}</strong><span>{row.totalTokens === undefined ? t("usage.noTokens") : t("usage.tokens", { n: number.format(row.totalTokens) })}</span></div>
        <div className="usage-bar" aria-hidden="true"><span style={{ width: `${usageBarWidth(row.totalTokens, max)}%` }} /></div>
        <small>{t("usage.rowDetail", { input: row.hasInput ? number.format(row.input) : "—", cached: row.hasCached ? number.format(row.cached) : "—", output: row.hasOutput ? number.format(row.output) : "—", reasoning: row.hasReasoning ? number.format(row.reasoning) : "—", runs: row.runs, duration: formatDuration(row.durationMs) })}{row.hasCost ? ` · $${row.costUsd.toFixed(4)}` : ""}</small>
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
      if (!response.ok) throw new Error(payload?.error || t("usage.loadFailed"));
      setRuns(Array.isArray(payload) ? payload : Array.isArray(payload?.runs) ? payload.runs : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("usage.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => filterUsageRuns(runs, period, workspace), [runs, period, workspace]);
  const summary = useMemo(() => aggregateUsage(filtered), [filtered]);


  return <section className="usage-panel" aria-label={t("usage.label")}>
    <div className="usage-segment" aria-label={t("usage.view")}><button aria-pressed={view === "remaining"} onClick={() => setView("remaining")}>{t("usage.remaining")}</button><button aria-pressed={view === "history"} onClick={() => setView("history")}>{t("usage.history")}</button></div>
    {view === "remaining" ? <div className="quota-overview">
      <p className="quota-note">{t("usage.planNote")}</p>
      {quotas.loading && <p role="status">{t("usage.loadingQuota")}</p>}
      {quotas.error && <div role="alert"><p>{quotas.error}</p><button className="button light" onClick={() => void quotas.reload()}>{t("common.retry")}</button></div>}
      {(["codex", "claude", "grok"] as const).map((agent) => <QuotaCard key={agent} agent={agent} provider={quotas.providers.find((item) => item.agent === agent)} now={now} tokenError={error} onRetryTokens={() => void load()} tokens={aggregateUsage(runs.filter((run) => run.agent === agent)).byAgent[0]?.totalTokens} refreshing={quotas.refreshing} onRefresh={() => void quotas.refreshClaude()} />)}
    </div> : <>
    <div className="usage-controls">
      <div className="usage-segment" aria-label={t("usage.period")}>{(["today", "7d", "30d"] as const).map((value) => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{periodLabels[value]}</button>)}</div>
      <div className="usage-segment" aria-label={t("usage.workspace")}>{(["all", "personal", "company"] as const).map((value) => <button key={value} aria-pressed={workspace === value} onClick={() => setWorkspace(value)}>{workspaceLabels[value]}</button>)}</div>
    </div>
    {loading ? <p className="usage-state" role="status">{t("usage.loading")}</p> : error ? <div className="usage-state" role="alert"><p>{error}</p><button onClick={() => void load()}>{t("common.retry")}</button></div> : !filtered.length ? <p className="usage-state">{t("usage.empty")}</p> : <>
      <dl className="usage-totals">
        <div><dt>{t("usage.input")}</dt><dd>{summary.totals.hasInput ? number.format(summary.totals.input) : "—"}</dd></div>
        <div><dt>{t("usage.cache")}</dt><dd>{summary.totals.hasCached ? number.format(summary.totals.cached) : "—"}</dd></div>
        <div><dt>{t("usage.output")}</dt><dd>{summary.totals.hasOutput ? number.format(summary.totals.output) : "—"}</dd></div>
        <div><dt>{t("usage.reasoning")}</dt><dd>{summary.totals.hasReasoning ? number.format(summary.totals.reasoning) : "—"}</dd></div>
        <div><dt>{t("usage.runs")}</dt><dd>{t("usage.runCount", { n: number.format(summary.totals.runs) })}</dd></div>
        <div><dt>{t("usage.cost")}</dt><dd>{summary.totals.hasCost ? `$${summary.totals.costUsd.toFixed(4)}` : "—"}</dd></div>
      </dl>
      <div className="usage-columns"><UsageRows title={t("usage.byModel")} rows={summary.byModel} /><UsageRows title={t("usage.byAgent")} rows={summary.byAgent} agentRows /></div>
    </>}
    </>}
  </section>;
}
