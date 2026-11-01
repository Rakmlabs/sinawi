import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { AgentMark } from "./AgentMark";
import { useState } from "react";
import { Check, ChevronDown, Plus, Users, X } from "lucide-react";
import type { AgentId, AgentSelection } from "../server/types";
import type { RoutingSettings } from "../server/routing";
import { ModelChoice } from "./RoutingControls";
import { t } from "./i18n";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const ids: AgentId[] = ["codex", "claude", "grok"];
export const selectionLabel = (value: AgentSelection) => `${names[value.agent]} · ${value.model || t("usage.cliDefaultModel")} · ${value.reasoningEffort || t("team.defaultReasoning")}`;

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
    <div className="team-chips" aria-label={t("team.current")}>
      <span className="team-caption"><Users size={14} />{t("team.orchestrator")}{automatic ? t("team.autoPick") : ""}</span>
      <button className="team-chip" onClick={edit} aria-expanded={open} aria-controls="team-editor" title={t("team.changeOrchestrator")}><AgentMark agent={orchestrator.agent} size="small" /><strong>{selectionLabel(orchestrator)}</strong><RemainingChip agent={orchestrator.agent} /><ChevronDown size={13} /></button>
      <span className="team-caption">{t("team.workers")}</span>
      {workers.map((worker, index) => <button className="team-chip" key={worker.id ?? index} onClick={edit} aria-expanded={open} aria-controls="team-editor"><AgentMark agent={worker.agent} size="small" />{worker.label ? `${worker.label} · ` : ""}{selectionLabel(worker)}<RemainingChip agent={worker.agent} /></button>)}
      <button className="icon-button" onClick={edit} aria-label={t("team.edit")} aria-expanded={open} aria-controls="team-editor"><Plus size={15} /></button>
    </div>
    {open && <section className="team-editor" id="team-editor" aria-label={t("team.edit")}>
      {running && <p role="status">{t("team.runningLocked")}</p>}
      <ModelChoice label={t("team.orchestrator")} value={draft} settings={settings} disabled={disabled || running} availableAgents={availableAgents} onChange={(next) => { setDraft(next); }} />
      {crew.map((worker, index) => <div className="team-worker-editor" key={worker.id ?? index}>
        <ModelChoice workerSession label={t("team.workerN", { n: index + 1 })} value={worker} settings={settings} availableAgents={availableAgents} disabled={disabled || running} onChange={(next) => setCrew((current) => changeWorkerConfig(current, index, next))} />
        <button className="icon-button" disabled={disabled || running || crew.length === 1} aria-label={t("team.removeWorker", { agent: names[worker.agent] })} onClick={() => setCrew((current) => current.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>)}
      <div className="team-editor-actions">
        {crew.length < 3 && ids.some((id) => !availableAgents || availableAgents.includes(id)) && <button className="button light" disabled={disabled || running} onClick={() => {
          const id = ids.find((id) => (!availableAgents || availableAgents.includes(id)) && !crew.some((item) => item.agent === id)) ?? ids.find((id) => !availableAgents || availableAgents.includes(id));
          if (id) setCrew((current) => normalizeWorkerConfigs([...current.map((worker) => worker.agent), id], [...current, { id: crypto.randomUUID(), agent: id }]));
        }}><Plus size={14} />{t("team.addWorker")}</button>}
        <button className="button light" disabled={disabled} onClick={() => setOpen(false)}>{t("desk.close")}</button>
        <button className="button primary" disabled={disabled || running || !crew.length} onClick={() => { void onSave(draft, crew).then((saved) => { if (saved) setOpen(false); }); }}><Check size={14} />{t("team.apply")}</button>
      </div>
    </section>}
  </div>;
}
