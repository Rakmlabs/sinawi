import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { AgentMark } from "./AgentMark";
import { useState } from "react";
import { Check, ChevronDown, Plus, Users, X } from "lucide-react";
import type { AgentId, AgentSelection } from "../server/types";
import type { RoutingSettings } from "../server/routing";
import { ModelChoice } from "./RoutingControls";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const ids: AgentId[] = ["codex", "claude", "grok"];
export const selectionLabel = (value: AgentSelection) => `${names[value.agent]} · ${value.model || "CLI 기본 모델"} · ${value.reasoningEffort || "기본 추론"}`;

export function TeamBar({ orchestrator, workers, settings, availableAgents, disabled, running, automatic, onSave }: {
  orchestrator: AgentSelection; workers: AgentSelection[]; settings?: RoutingSettings; availableAgents?: AgentId[];
  disabled: boolean; running: boolean; automatic: boolean;
  onSave: (orchestrator: AgentSelection, workers: AgentSelection[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(orchestrator);
  const [crew, setCrew] = useState(workers);
  const edit = () => {
    if (!open) { setDraft({ ...orchestrator }); setCrew(workers.map((worker, index) => ({ ...worker }))); }
    setOpen(!open);
  };
  return <div className="team-bar">
    <div className="team-chips" aria-label="현재 팀 구성">
      <span className="team-caption"><Users size={14} />오케스트라{automatic ? " · 자동 추천 예정" : ""}</span>
      <button className="team-chip" onClick={edit} aria-expanded={open} aria-controls="team-editor" title="오케스트라 변경"><AgentMark agent={orchestrator.agent} size="small" /><strong>{selectionLabel(orchestrator)}</strong><RemainingChip agent={orchestrator.agent} /><ChevronDown size={13} /></button>
      <span className="team-caption">작업자</span>
      {workers.map((worker, index) => <button className="team-chip" key={worker.id ?? index} onClick={edit} aria-expanded={open} aria-controls="team-editor"><AgentMark agent={worker.agent} size="small" />{worker.label ? `${worker.label} · ` : ""}{selectionLabel(worker)}<RemainingChip agent={worker.agent} /></button>)}
      <button className="icon-button" onClick={edit} aria-label="팀 구성 변경" aria-expanded={open} aria-controls="team-editor"><Plus size={15} /></button>
    </div>
    {open && <section className="team-editor" id="team-editor" aria-label="팀 구성 변경">
      {running && <p role="status">진행 중인 작업이 끝나거나 중지한 뒤 팀을 변경할 수 있습니다.</p>}
      <ModelChoice label="오케스트라" value={draft} settings={settings} disabled={disabled || running} availableAgents={availableAgents} onChange={(next) => { setDraft(next); }} />
      {crew.map((worker, index) => <div className="team-worker-editor" key={worker.id ?? index}>
        <ModelChoice workerSession label={`작업자 ${index + 1}`} value={worker} settings={settings} availableAgents={availableAgents} disabled={disabled || running} onChange={(next) => setCrew((current) => changeWorkerConfig(current, index, next))} />
        <button className="icon-button" disabled={disabled || running || crew.length === 1} aria-label={`${names[worker.agent]} 작업자 제거`} onClick={() => setCrew((current) => current.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>)}
      <div className="team-editor-actions">
        {crew.length < 3 && ids.some((id) => !availableAgents || availableAgents.includes(id)) && <button className="button light" disabled={disabled || running} onClick={() => {
          const id = ids.find((id) => (!availableAgents || availableAgents.includes(id)) && !crew.some((item) => item.agent === id)) ?? ids.find((id) => !availableAgents || availableAgents.includes(id));
          if (id) setCrew((current) => normalizeWorkerConfigs([...current.map((worker) => worker.agent), id], [...current, { id: crypto.randomUUID(), agent: id }]));
        }}><Plus size={14} />작업자 추가</button>}
        <button className="button light" disabled={disabled} onClick={() => setOpen(false)}>닫기</button>
        <button className="button primary" disabled={disabled || running || !crew.length} onClick={() => { void onSave(draft, crew).then((saved) => { if (saved) setOpen(false); }); }}><Check size={14} />팀 적용</button>
      </div>
    </section>}
  </div>;
}
