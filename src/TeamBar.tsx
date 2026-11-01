import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { useState, type ReactNode } from "react";
import { ArrowRight, Check, Plus, X } from "lucide-react";
import type { AgentId, AgentSelection } from "../server/types";
import type { RoutingSettings } from "../server/routing";
import { ModelChoice } from "./RoutingControls";
import { t } from "./i18n";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const ids: AgentId[] = ["codex", "claude", "grok"];
export const selectionLabel = (value: AgentSelection) => `${names[value.agent]} · ${value.model || t("usage.cliDefaultModel")} · ${value.reasoningEffort || t("team.defaultReasoning")}`;

export function TeamBar({ orchestrator, workers, settings, availableAgents, disabled, running, automatic, actions, onSave }: {
  orchestrator: AgentSelection; workers: AgentSelection[]; settings?: RoutingSettings; availableAgents?: AgentId[];
  disabled: boolean; running: boolean; automatic: boolean; actions?: ReactNode;
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
    <div className="team-row">
      <div className="team-chips" role="group" aria-label={t("team.current")}>
        <span className="team-caption">{t("team.label")}</span>
        <button className="team-chip" onClick={edit} aria-expanded={open} aria-controls="team-editor" title={`${t("team.changeOrchestrator")} · ${selectionLabel(orchestrator)}`}>
          <span className={`agent-dot ${orchestrator.agent}`} aria-hidden="true" /><strong>{names[orchestrator.agent]}</strong>
          <span className="team-chip-meta">{t("team.orchestrator")}{automatic ? t("team.autoPick") : ` · ${orchestrator.model || t("usage.cliDefaultModel")}`}</span><RemainingChip agent={orchestrator.agent} />
        </button>
        {workers.length > 0 && <ArrowRight className="team-arrow-icon" size={16} aria-hidden="true" />}
        {workers.map((worker, index) => <button key={worker.id ?? index} className="team-chip" onClick={edit} aria-expanded={open} aria-controls="team-editor" title={`${t("team.workers")} · ${worker.label ? `${worker.label} · ` : ""}${selectionLabel(worker)}`}>
            <span className={`agent-dot ${worker.agent}`} aria-hidden="true" />{worker.label ?? names[worker.agent]}<RemainingChip agent={worker.agent} />
          </button>)}
        <button className="team-edit" onClick={edit} aria-label={t("team.edit")} aria-expanded={open} aria-controls="team-editor">{t("team.editShort")}</button>
      </div>
      {actions}
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
