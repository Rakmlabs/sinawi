import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { names } from "./labels";
import type { AgentId, WorkspaceId } from "../../server/types";
import { t } from "../i18n";

export type AllowedAgentsSettingsProps = {
  workspaceId: WorkspaceId;
  allowedAgents: AgentId[];
  busy: boolean;
  quotaFallback: boolean;
  setQuotaFallback: (value: boolean) => void;
  quotaThreshold: number;
  setQuotaThreshold: (value: number) => void;
  fallbackOrder: Partial<Record<AgentId, AgentId[]>>;
  setFallbackOrder: (update: (old: Partial<Record<AgentId, AgentId[]>>) => Partial<Record<AgentId, AgentId[]>>) => void;
  onAllowedChange: (next: AgentId[]) => void;
};

const fallbackCandidates = (source: AgentId): AgentId[] => source === "codex" ? ["claude", "grok"] : source === "claude" ? ["codex", "grok"] : ["claude", "codex"];

/** Settings tab: which agents this workspace may use, and quota-exhaustion fallback order. */
export function AllowedAgentsSettings({ workspaceId, allowedAgents, busy, quotaFallback, setQuotaFallback, quotaThreshold, setQuotaThreshold, fallbackOrder, setFallbackOrder, onAllowedChange }: AllowedAgentsSettingsProps) {
  return <section className="glass routing-settings" aria-label={t("allowed.label")}>
    <h2>{t("allowed.title", { space: workspaceId === "company" ? t("workspace.company") : t("workspace.personal") })}</h2>
    <p className="muted">{t("allowed.body")}</p>
    <div className="routing-skills">{(["codex", "claude", "grok"] as AgentId[]).map((id) => <label key={id} title={workspaceId === "company" && id === "codex" ? t("allowed.codexOffAtWork") : undefined}>
      <input type="checkbox" checked={allowedAgents.includes(id)} disabled={busy || (workspaceId === "company" && id === "codex")} onChange={(event) => {
        onAllowedChange(event.target.checked ? [...allowedAgents, id] : allowedAgents.filter((item) => item !== id));
      }} /><AgentMark agent={id} size="small" />{names[id]}{workspaceId === "company" && id === "codex" && <small>{t("allowed.codexOffAtWork")}</small>}
    </label>)}</div>
    <div className="quota-fallback-settings">
      <label className="auto-switch-setting"><span>{t("allowed.autoSwitch")}</span><input type="checkbox" checked={quotaFallback} disabled={busy} onChange={(event) => setQuotaFallback(event.target.checked)} /></label>
      <label className="quota-threshold">{t("allowed.threshold")}<input type="number" min="0" max="100" step="0.5" value={quotaThreshold} disabled={busy || !quotaFallback} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setQuotaThreshold(Math.max(0, Math.min(100, value))); }} /></label>
      <p className="muted">{t("allowed.order")}</p>
      {allowedAgents.map((source) => {
        const candidates = fallbackCandidates(source).filter((id) => allowedAgents.includes(id));
        if (!candidates.length) return null;
        const first = fallbackOrder[source]?.find((id) => candidates.includes(id)) ?? candidates[0];
        return <GlassSelect key={source} label={t("allowed.priority", { agent: names[source] })} value={first} disabled={busy || !quotaFallback} onChange={(value) => setFallbackOrder((old) => ({ ...old, [source]: [value as AgentId, ...candidates.filter((id) => id !== value)] }))} options={candidates.map((id) => ({ value: id, label: [id, ...candidates.filter((other) => other !== id)].map((target) => names[target]).join(" → "), icon: <AgentMark agent={id} size="small" /> }))} />;
      })}
    </div>
    {!allowedAgents.length && <p role="status">{t("allowed.needOne")}</p>}
  </section>;
}
