import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { AgentMark } from "./AgentMark";
import { createContext, useContext } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AgentId, AgentSelection, SkillInfo, WorkspaceId } from "../server/types";
import type { RoutingRecommendation, RoutingSettings } from "../server/routing";
import { GlassSelect } from "./GlassSelect";
import "./routing.css";
import { t } from "./i18n";

export const WorkspaceAgentPolicy = createContext<{ workspaceId: WorkspaceId; allowedAgents: AgentId[] } | undefined>(undefined);

const agents: AgentId[] = ["claude", "codex", "grok"];
const names = { claude: "Claude", codex: "Codex", grok: "Grok Build" };

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
        label={t("rt.agent", { label })}
        value={value.agent}
        options={agents.map((id) => ({
          value: id,
          label: names[id],
          icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>,
          disabled: excludedAgents.includes(id) || Boolean(availableAgents && !availableAgents.includes(id)) || Boolean(policy && !policy.allowedAgents.includes(id)),
          title: policy && !policy.allowedAgents.includes(id) ? t("rt.notInSpace") : undefined,
        }))}
        onChange={(agent) => onChange({ ...value, agent: agent as AgentId, model: undefined, reasoningEffort: undefined })}
      /> : <strong className="agent-label"><AgentMark agent={value.agent} size="small" />{names[value.agent]}<RemainingChip agent={value.agent} /></strong>}
      <GlassSelect
        allowCustom
        disabled={disabled}
        label={t("rt.model", { label })}
        value={value.model ?? ""}
        placeholder={t("usage.cliDefaultModel")}
        options={(options?.models ?? []).map((model) => ({ value: model, label: model }))}
        onChange={(model) => onChange({ ...value, model: model || undefined })}
      />
      <GlassSelect
        disabled={disabled}
        label={t("rt.reasoning", { label })}
        value={value.reasoningEffort ?? ""}
        options={[
          { value: "", label: t("team.defaultReasoning") },
          ...Array.from(new Set([...(options?.reasoningEfforts ?? []), ...(value.reasoningEffort ? [value.reasoningEffort] : [])])).map((effort) => ({ value: effort, label: effort })),
        ]}
        onChange={(reasoningEffort) => onChange({ ...value, reasoningEffort: reasoningEffort || undefined })}
      />
      {workerSession && <GlassSelect disabled={disabled} label={t("rt.session", { label })} value={value.sessionMode ?? "resume"}
        options={[{ value: "resume", label: t("rt.resume") }, { value: "new", label: t("sessions.new") }]}
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
  return <section className="panel recommendation" aria-label={t("rt.autoTeam")} aria-live="polite">
    <div className="recommendation-summary">
      <div><h2>{t("rt.recommended")}{summary(value.orchestrator)} → {value.workers.map((worker, index) => <span key={worker.id ?? index}>{summary(worker)} </span>)}</h2>
        <p>{value.reason}</p><small>{t("rt.plan")}{summary(value.planner)}{t("rt.skillCount", { n: value.skills.length })}</small>
      </div>
      <div className="recommendation-actions"><button className="button light" onClick={onEdit} disabled={busy}>{editing ? t("media.collapse") : t("rt.edit")}</button>
        <button className="button primary" onClick={onRun} disabled={busy || runDisabled || !value.workers.length}>{t("rt.run")}</button></div>
    </div>
    {value.warning && <p className="routing-warning" role="status">{value.warning}</p>}
    {editing ? <div className="recommendation-editor">
      <ModelChoice availableAgents={availableAgents} label={t("rt.planner")} value={value.planner} settings={settings} onChange={(planner) => onChange({ ...value, planner })} />
      <ModelChoice availableAgents={availableAgents} label={t("rt.lead")} value={value.orchestrator} settings={settings} onChange={(orchestrator) => onChange({ ...value, orchestrator })} />
      {value.workers.map((worker, index) => <div className="worker-config" key={index}>
        <ModelChoice workerSession availableAgents={availableAgents} label={t("team.workerN", { n: index + 1 })} value={worker} settings={settings} onChange={(next) => onChange({ ...value, workers: changeWorkerConfig(value.workers, index, next) })} />
        <button className="icon-button" aria-label={t("rt.removeWorker", { n: index + 1 })} disabled={value.workers.length === 1} onClick={() => onChange({ ...value, workers: value.workers.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>
      </div>)}
      {value.workers.length < 3 && agents.some((agent) => !availableAgents || availableAgents.includes(agent)) && <button className="button light" onClick={() => {
        const agent = agents.find((agent) => (!availableAgents || availableAgents.includes(agent)) && !value.workers.some((worker) => worker.agent === agent)) ?? agents.find((agent) => !availableAgents || availableAgents.includes(agent));
        if (agent) onChange({ ...value, workers: normalizeWorkerConfigs([...value.workers.map((worker) => worker.agent), agent], [...value.workers, { id: crypto.randomUUID(), agent, reason: t("rt.addedManually") }]) });
      }}><Plus size={14} />{t("team.addWorker")}</button>}
      <fieldset className="routing-skills"><legend>{t("rt.skillsLegend")}</legend>
        {skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={value.skills.includes(skill.id)} disabled={!value.skills.includes(skill.id) && value.skills.length >= 20} onChange={(e) => onChange({ ...value, skills: e.target.checked ? [...value.skills, skill.id] : value.skills.filter((id) => id !== skill.id) })} />{skill.name}<small>{skill.description}</small></label>)}
        {!skills.length && <p>{t("rt.noSkills")}</p>}
      </fieldset>
    </div> : <div className="recommendation-reasons">
      {[value.planner, value.orchestrator, ...value.workers].map((selection, i) => <span className="agent-label" key={i}><AgentMark agent={selection.agent} size="small" />{names[selection.agent]}: {selection.reason}</span>)}
      {value.skills.length > 0 && <span>{t("rt.skills", { list: value.skills.map((id) => skills.find((s) => s.id === id)?.name ?? id).join(", ") })}</span>}
    </div>}
  </section>;
}
