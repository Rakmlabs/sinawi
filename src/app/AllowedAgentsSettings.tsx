import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { names } from "./labels";
import type { AgentId, WorkspaceId } from "../../server/types";

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
  return <section className="glass routing-settings" aria-label="허용 에이전트">
    <h2>{workspaceId === "company" ? "회사" : "개인"} 공간 · 허용 에이전트</h2>
    <p className="muted">이 공간의 총괄, 작업자, 계획 담당과 라우터에 적용됩니다.</p>
    <div className="routing-skills">{(["codex", "claude", "grok"] as AgentId[]).map((id) => <label key={id} title={workspaceId === "company" && id === "codex" ? "회사 공간에서는 사용 안 함" : undefined}>
      <input type="checkbox" checked={allowedAgents.includes(id)} disabled={busy || (workspaceId === "company" && id === "codex")} onChange={(event) => {
        onAllowedChange(event.target.checked ? [...allowedAgents, id] : allowedAgents.filter((item) => item !== id));
      }} /><AgentMark agent={id} size="small" />{names[id]}{workspaceId === "company" && id === "codex" && <small>회사 공간에서는 사용 안 함</small>}
    </label>)}</div>
    <div className="quota-fallback-settings">
      <label className="auto-switch-setting"><span>한도 소진 시 자동 전환</span><input type="checkbox" checked={quotaFallback} disabled={busy} onChange={(event) => setQuotaFallback(event.target.checked)} /></label>
      <label className="quota-threshold">전환 기준 · 남은 한도 (%)<input type="number" min="0" max="100" step="0.5" value={quotaThreshold} disabled={busy || !quotaFallback} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setQuotaThreshold(Math.max(0, Math.min(100, value))); }} /></label>
      <p className="muted">로그인한 허용 에이전트 중 남은 한도가 많은 순서로 전환합니다. 한도가 같거나 확인되지 않으면 아래 순서를 따릅니다.</p>
      {allowedAgents.map((source) => {
        const candidates = fallbackCandidates(source).filter((id) => allowedAgents.includes(id));
        if (!candidates.length) return null;
        const first = fallbackOrder[source]?.find((id) => candidates.includes(id)) ?? candidates[0];
        return <GlassSelect key={source} label={`${names[source]} 전환 우선순위`} value={first} disabled={busy || !quotaFallback} onChange={(value) => setFallbackOrder((old) => ({ ...old, [source]: [value as AgentId, ...candidates.filter((id) => id !== value)] }))} options={candidates.map((id) => ({ value: id, label: [id, ...candidates.filter((other) => other !== id)].map((target) => names[target]).join(" → "), icon: <AgentMark agent={id} size="small" /> }))} />;
      })}
    </div>
    {!allowedAgents.length && <p role="status">팀 실행에는 에이전트를 한 개 이상 허용해야 합니다.</p>}
  </section>;
}
