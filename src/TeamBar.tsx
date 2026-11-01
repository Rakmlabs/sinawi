import { changeWorkerConfig } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { RemainingChip } from "./QuotaContext";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Plus, SlidersHorizontal, X } from "lucide-react";
import type { AgentId, AgentSelection } from "../server/types";
import type { RoutingSettings } from "../server/routing";
import { ModelChoice } from "./RoutingControls";
import { t } from "./i18n";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const ids: AgentId[] = ["codex", "claude", "grok"];
export const selectionLabel = (value: AgentSelection) => `${names[value.agent]} · ${value.model || t("usage.cliDefaultModel")} · ${value.reasoningEffort || t("team.defaultReasoning")}`;

/**
 * Team picker in the composer's bottom bar (like a model picker): "Claude · model ▾" plus compact
 * worker chips. Clicking opens the team editor as a popover above the composer.
 */
export function TeamBar({ orchestrator, workers, settings, availableAgents, disabled, running, automatic, onSave, onAdvanced }: {
  orchestrator: AgentSelection; workers: AgentSelection[]; settings?: RoutingSettings; availableAgents?: AgentId[];
  disabled: boolean; running: boolean; automatic: boolean;
  onSave: (orchestrator: AgentSelection, workers: AgentSelection[]) => Promise<boolean>;
  /** Opens the advanced session settings dialog (system prompt, auto switch, skills). */
  onAdvanced?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(orchestrator);
  const [crew, setCrew] = useState(workers);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editorId = `team-editor-${useId().replace(/:/g, "")}`;
  const edit = () => {
    if (!open) { setDraft({ ...orchestrator }); setCrew(workers.map((worker) => ({ ...worker }))); }
    setOpen(!open);
  };
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target;
      // Model selects render their listbox in a portal: clicks inside it are not "outside".
      if (target instanceof Element && (root.current?.contains(target) || target.closest(".glass-select-popover, .glass-select-menu, [role=listbox]"))) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  }, [open]);
  const meta = automatic ? t("team.autoShort") : orchestrator.model || t("usage.cliDefaultModel");
  return <div className="team-picker" ref={root}>
    <button ref={trigger} type="button" className="team-trigger" onClick={edit} aria-haspopup="dialog" aria-expanded={open} aria-controls={editorId}
      title={`${t("team.changeOrchestrator")} · ${selectionLabel(orchestrator)}`}>
      <span className={`agent-dot ${orchestrator.agent}`} aria-hidden="true" /><strong>{names[orchestrator.agent]}</strong>
      <span className="team-trigger-meta">{meta}</span><RemainingChip agent={orchestrator.agent} />
      {workers.length > 0 && <span className="team-trigger-workers" aria-label={t("team.workerSummary", { names: workers.map((worker) => worker.label ?? names[worker.agent]).join(", ") })}>
        {workers.length === 1
          ? <><span className={`agent-dot ${workers[0].agent}`} aria-hidden="true" /><span aria-hidden="true">{workers[0].label ?? names[workers[0].agent]}</span></>
          : <>{workers.map((worker, index) => <span key={worker.id ?? index} className={`agent-dot ${worker.agent}`} aria-hidden="true" />)}<span aria-hidden="true">+{workers.length}</span></>}
      </span>}
      <ChevronDown size={14} aria-hidden="true" className="team-trigger-chevron" />
    </button>
    {open && <section className="team-editor" id={editorId} role="dialog" aria-label={t("team.edit")}>
      <header className="team-editor-heading"><strong>{t("team.label")}</strong>{automatic && <small>{t("team.autoPickNote")}</small>}</header>
      {running && <p role="status">{t("team.runningLocked")}</p>}
      <ModelChoice label={t("team.orchestrator")} value={draft} settings={settings} disabled={disabled || running} availableAgents={availableAgents} onChange={(next) => { setDraft(next); }} />
      {crew.map((worker, index) => <div className="team-worker-editor" key={worker.id ?? index}>
        <ModelChoice workerSession label={t("team.workerN", { n: index + 1 })} value={worker} settings={settings} availableAgents={availableAgents} disabled={disabled || running} onChange={(next) => setCrew((current) => changeWorkerConfig(current, index, next))} />
        <button type="button" className="icon-button" disabled={disabled || running || crew.length === 1} aria-label={t("team.removeWorker", { agent: names[worker.agent] })} onClick={() => setCrew((current) => current.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>)}
      <div className="team-editor-actions">
        {crew.length < 3 && ids.some((id) => !availableAgents || availableAgents.includes(id)) && <button type="button" className="button light" disabled={disabled || running} onClick={() => {
          const id = ids.find((id) => (!availableAgents || availableAgents.includes(id)) && !crew.some((item) => item.agent === id)) ?? ids.find((id) => !availableAgents || availableAgents.includes(id));
          if (id) setCrew((current) => normalizeWorkerConfigs([...current.map((worker) => worker.agent), id], [...current, { id: crypto.randomUUID(), agent: id }]));
        }}><Plus size={14} />{t("team.addWorker")}</button>}
        {onAdvanced && <button type="button" className="button light" onClick={() => { setOpen(false); onAdvanced(); }}><SlidersHorizontal size={14} />{t("team.advanced")}</button>}
        <span className="team-editor-spacer" />
        <button type="button" className="button light" disabled={disabled} onClick={() => close()}>{t("desk.close")}</button>
        <button type="button" className="button primary" disabled={disabled || running || !crew.length} onClick={() => { void onSave(draft, crew).then((saved) => { if (saved) close(); }); }}><Check size={14} />{t("team.apply")}</button>
      </div>
    </section>}
  </div>;
}
