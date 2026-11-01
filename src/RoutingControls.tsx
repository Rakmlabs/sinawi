import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { AgentMark } from "./AgentMark";
import { createContext, useContext, useState } from "react";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AgentId, AgentSelection, SkillInfo, WorkspaceId } from "../server/types";
import type { RoutingRecommendation, RoutingSettings } from "../server/routing";
import { GlassSelect } from "./GlassSelect";
import "./routing.css";

export const WorkspaceAgentPolicy = createContext<{ workspaceId: WorkspaceId; allowedAgents: AgentId[] } | undefined>(undefined);

const agents: AgentId[] = ["claude", "codex", "grok"];
const names = { claude: "Claude", codex: "Codex", grok: "Grok Build" };

export function AuthBadges({ settings }: { settings?: RoutingSettings }) {
  return <div className="auth-badges" aria-live="polite">{agents.map((id) => {
    const option = settings?.modelOptions[id];
    return option?.authStatus === "unauthenticated" ? <span className="auth-badge" key={id} role="status"><AgentMark agent={id} size="small" />{names[id]} · {option.authDetail}</span> : null;
  })}</div>;
}

export function ModelChoice<T extends AgentSelection>({ value, settings, onChange, label, disabled = false, chooseAgent = true, excludedAgents = [], availableAgents, workerSession = false }: {
  value: T; settings?: RoutingSettings; onChange: (value: T) => void;
  label: string; disabled?: boolean; chooseAgent?: boolean; excludedAgents?: AgentId[]; availableAgents?: AgentId[]; workerSession?: boolean;
}) {
  const policy = useContext(WorkspaceAgentPolicy);
  const options = settings?.modelOptions[value.agent];
  return <fieldset className="model-choice" disabled={disabled}>
    <legend>{label}</legend>
    <div className="model-fields">
      {chooseAgent ? <GlassSelect
        disabled={disabled}
        label={`${label} 에이전트`}
        value={value.agent}
        options={agents.map((id) => ({
          value: id,
          label: names[id],
          icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>,
          disabled: excludedAgents.includes(id) || Boolean(availableAgents && !availableAgents.includes(id)) || Boolean(policy && !policy.allowedAgents.includes(id)),
          title: policy?.workspaceId === "company" && id === "codex" ? "회사 공간에서는 사용 안 함" : policy && !policy.allowedAgents.includes(id) ? "이 공간에서는 사용 안 함" : undefined,
        }))}
        onChange={(agent) => onChange({ ...value, agent: agent as AgentId, model: undefined, reasoningEffort: undefined })}
      /> : <strong className="agent-label"><AgentMark agent={value.agent} size="small" />{names[value.agent]}<RemainingChip agent={value.agent} /></strong>}
      <GlassSelect
        allowCustom
        disabled={disabled}
        label={`${label} 모델`}
        value={value.model ?? ""}
        placeholder="CLI 기본 모델"
        options={(options?.models ?? []).map((model) => ({ value: model, label: model }))}
        onChange={(model) => onChange({ ...value, model: model || undefined })}
      />
      <GlassSelect
        disabled={disabled}
        label={`${label} 추론 수준`}
        value={value.reasoningEffort ?? ""}
        options={[
          { value: "", label: "기본 추론" },
          ...Array.from(new Set([...(options?.reasoningEfforts ?? []), ...(value.reasoningEffort ? [value.reasoningEffort] : [])])).map((effort) => ({ value: effort, label: effort })),
        ]}
        onChange={(reasoningEffort) => onChange({ ...value, reasoningEffort: reasoningEffort || undefined })}
      />
      {workerSession && <GlassSelect disabled={disabled} label={`${label} 세션`} value={value.sessionMode ?? "resume"}
        options={[{ value: "resume", label: "이어서" }, { value: "new", label: "새 세션" }]}
        onChange={(sessionMode) => onChange({ ...value, sessionMode: sessionMode as "new" | "resume" })} />}
    </div>
    {value.reason && <small>{value.reason}</small>}
  </fieldset>;
}

export function RecommendationCard({ value, settings, skills, editing, busy, runDisabled, availableAgents, onEdit, onChange, onRun }: {
  value: RoutingRecommendation; settings?: RoutingSettings; skills: SkillInfo[]; editing: boolean; busy: boolean; runDisabled?: boolean; availableAgents?: AgentId[];
  onEdit: () => void; onChange: (value: RoutingRecommendation) => void; onRun: () => void;
}) {
  const summary = (selection: AgentSelection) => <span className="agent-label"><AgentMark agent={selection.agent} size="small" />{names[selection.agent]}<RemainingChip agent={selection.agent} />{selection.model ? ` (${selection.model})` : ""}</span>;
  return <section className="glass recommendation" aria-label="자동 추천 팀" aria-live="polite">
    <div className="recommendation-summary">
      <div><h2>추천: {summary(value.orchestrator)} → {value.workers.map((worker, index) => <span key={worker.id ?? index}>{summary(worker)} </span>)}</h2>
        <p>{value.reason}</p><small>계획: {summary(value.planner)} · 스킬 {value.skills.length}개</small>
      </div>
      <div className="recommendation-actions"><button className="button light" onClick={onEdit} disabled={busy}>{editing ? "접기" : "수정"}</button>
        <button className="button primary" onClick={onRun} disabled={busy || runDisabled || !value.workers.length}>실행</button></div>
    </div>
    {value.warning && <p className="routing-warning" role="status">{value.warning}</p>}
    {editing ? <div className="recommendation-editor">
      <ModelChoice availableAgents={availableAgents} label="계획 담당" value={value.planner} settings={settings} onChange={(planner) => onChange({ ...value, planner })} />
      <ModelChoice availableAgents={availableAgents} label="총괄" value={value.orchestrator} settings={settings} onChange={(orchestrator) => onChange({ ...value, orchestrator })} />
      {value.workers.map((worker, index) => <div className="worker-config" key={index}>
        <ModelChoice workerSession availableAgents={availableAgents} label={`작업자 ${index + 1}`} value={worker} settings={settings} onChange={(next) => onChange({ ...value, workers: changeWorkerConfig(value.workers, index, next) })} />
        <button className="icon-button" aria-label={`작업자 ${index + 1} 제거`} disabled={value.workers.length === 1} onClick={() => onChange({ ...value, workers: value.workers.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>
      </div>)}
      {value.workers.length < 3 && agents.some((agent) => !availableAgents || availableAgents.includes(agent)) && <button className="button light" onClick={() => {
        const agent = agents.find((agent) => (!availableAgents || availableAgents.includes(agent)) && !value.workers.some((worker) => worker.agent === agent)) ?? agents.find((agent) => !availableAgents || availableAgents.includes(agent));
        if (agent) onChange({ ...value, workers: normalizeWorkerConfigs([...value.workers.map((worker) => worker.agent), agent], [...value.workers, { id: crypto.randomUUID(), agent, reason: "직접 추가" }]) });
      }}><Plus size={14} />작업자 추가</button>}
      <fieldset className="routing-skills"><legend>적용 스킬 · 이름과 설명으로 자동 선택</legend>
        {skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={value.skills.includes(skill.id)} disabled={!value.skills.includes(skill.id) && value.skills.length >= 20} onChange={(e) => onChange({ ...value, skills: e.target.checked ? [...value.skills, skill.id] : value.skills.filter((id) => id !== skill.id) })} />{skill.name}<small>{skill.description}</small></label>)}
        {!skills.length && <p>발견된 로컬 스킬이 없습니다.</p>}
      </fieldset>
    </div> : <div className="recommendation-reasons">
      {[value.planner, value.orchestrator, ...value.workers].map((selection, i) => <span className="agent-label" key={i}><AgentMark agent={selection.agent} size="small" />{names[selection.agent]}: {selection.reason}</span>)}
      {value.skills.length > 0 && <span>스킬: {value.skills.map((id) => skills.find((s) => s.id === id)?.name ?? id).join(", ")}</span>}
    </div>}
  </section>;
}

export function RoutingSettingsPage({ value, busy, onSave, onRefresh }: { value: RoutingSettings; busy: boolean; onSave: (next: RoutingSettings) => Promise<void>; onRefresh: () => Promise<RoutingSettings> }) {
  const [planner, setPlanner] = useState(value.planner);
  const [rules, setRules] = useState(JSON.stringify(value.rules, null, 2));
  const [models, setModels] = useState(JSON.stringify(value.modelOptions, null, 2));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  return <section className="glass routing-settings">
    <h2>자동 라우팅 설정</h2><p className="muted">요청을 분석할 계획 담당과 작업별 배정 규칙을 설정하세요. 저장한 규칙은 다음 추천부터 적용되며 .data/routing-settings.json에 보관됩니다.</p>
    <AuthBadges settings={value} />
    <button className="button light" disabled={busy || refreshing} onClick={() => {
      setError(""); setRefreshing(true); setRefreshed(false); setSaved(false);
      void (async () => {
        try { const next = await onRefresh(); setModels(JSON.stringify(next.modelOptions, null, 2)); setRefreshed(true); }
        catch (e) { setError((e as Error).message); }
        finally { setRefreshing(false); }
      })();
    }}><RefreshCw size={15} />{refreshing ? "모델 확인 중…" : "모델 새로고침"}</button>
    <p className="muted">CLI와 로컬 설정에서 모델 및 로그인 상태를 다시 확인합니다. 모델 목록 편집 내용은 새로고침 결과로 바뀝니다.</p>
    {refreshed && <p role="status">모델 목록과 로그인 상태를 새로고침했습니다. 배정 규칙과 계획 담당 편집 내용은 유지됩니다.</p>}
    <ModelChoice label="요청 분석 담당" value={planner} settings={value} onChange={(next) => { setPlanner(next); setSaved(false); }} />
    <label>배정 규칙 (JSON)<textarea rows={14} value={rules} spellCheck={false} onChange={(e) => { setRules(e.target.value); setSaved(false); }} /></label>
    <p className="muted">keywords에 요청의 핵심 단어를, orchestrator에 에이전트 ID를, workers에 ID 목록을 입력하세요. 여러 규칙이 일치하면 위 규칙부터 적용됩니다.</p>
    <label>에이전트별 모델 목록과 추론 수준 (JSON)<textarea disabled={refreshing} rows={14} value={models} spellCheck={false} onChange={(e) => { setModels(e.target.value); setSaved(false); }} /></label>
    <div className="model-sources">{agents.map((id) => <p className="agent-label" key={id}><AgentMark agent={id} size="small" />{names[id]} · {value.modelOptions[id].source === "cli" ? "로컬 CLI에서 발견" : "편집 가능한 프리셋"} · {value.modelOptions[id].sourceDetail}</p>)}</div>
    {error && <p role="alert" className="routing-warning">{error}</p>}
    <button className="button primary" disabled={busy || refreshing} onClick={() => {
      setError(""); setSaved(false);
      void (async () => {
        try { await onSave({ ...value, planner, rules: JSON.parse(rules), modelOptions: JSON.parse(models) }); setSaved(true); }
        catch (e) { setError((e as Error).message); }
      })();
    }}><Check size={15} />{busy ? "저장 중…" : "설정 저장"}</button>
    {saved && <p role="status">설정을 저장했습니다.</p>}
  </section>;
}
