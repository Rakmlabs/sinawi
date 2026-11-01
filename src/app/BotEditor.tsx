import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, WandSparkles, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { RemainingChip } from "../QuotaContext";
import { ConfirmDialog } from "../settings/controls";
import { names } from "./labels";
import { SkillPicker } from "./SkillPicker";
import type { RoutingSettings } from "../../server/routing";
import type { AgentId, SkillInfo as Skill } from "../../server/types";
import { t } from "../i18n";

export type BotDraft = { name: string; agent: AgentId; model: string; systemPrompt: string; skills: string[] };

/** New bot: its own draft (never touches the current session's settings); saved explicitly. */
export function BotEditor({ initialAgent, allowedAgents, routingSettings, availableSkills, onSave, onClose }: {
  initialAgent: AgentId; allowedAgents: AgentId[]; routingSettings: RoutingSettings | undefined; availableSkills: Skill[];
  onSave: (draft: BotDraft) => Promise<boolean>; onClose: () => void;
}) {
  const empty = useRef<BotDraft>({ name: "", agent: allowedAgents.includes(initialAgent) ? initialAgent : allowedAgents[0] ?? initialAgent, model: "", systemPrompt: "", skills: [] });
  const [draft, setDraft] = useState<BotDraft>(empty.current);
  const [view, setView] = useState<"main" | "skills">("main");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const id = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(empty.current);
  const requestClose = () => { if (dirty) setConfirmDiscard(true); else onClose(); };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    // Escape asks before throwing away a draft (the app-wide modal trap would close at once).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".glass-select-menu")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (confirmDiscard) setConfirmDiscard(false);
      else if (view === "skills") setView("main");
      else closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [view, confirmDiscard]);
  const set = (patch: Partial<BotDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const missingName = !draft.name.trim();
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section className="glass modal bot-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="panel-header">
        <h2 id={`${id}-title`}>{t("modal.bot")}</h2>
        <button type="button" className="icon-button" onClick={requestClose} aria-label={t("modal.close")}><X size={20} /></button>
      </div>
      <div className="modal-body bot-editor-body">
        {view === "skills" ? <SkillPicker skills={availableSkills} selected={draft.skills} onChange={(skills) => set({ skills })} onBack={() => setView("main")} /> : <>
          <div className="session-field">
            <label className="session-label" htmlFor={`${id}-name`}>{t("modal.botName")}</label>
            <input id={`${id}-name`} className="settings-input" autoFocus value={draft.name} maxLength={100} placeholder={t("modal.botNamePlaceholder")} aria-describedby={missingName ? `${id}-need` : undefined} onChange={(event) => set({ name: event.target.value })} />
          </div>
          <div className="session-field">
            <span className="session-label">{t("modal.agent")}</span>
            <GlassSelect className="settings-select" label={t("modal.agent")} value={draft.agent} onChange={(value) => set({ agent: value as AgentId, model: "" })}
              options={(["codex", "claude", "grok"] as AgentId[]).map((agent) => ({ value: agent, label: names[agent], icon: <><AgentMark agent={agent} size="small" /><RemainingChip agent={agent} /></>, disabled: !allowedAgents.includes(agent), title: allowedAgents.includes(agent) ? undefined : t("rt.notInSpace") }))} />
          </div>
          <div className="session-field">
            <span className="session-label">{t("set.bot.model")}</span>
            <GlassSelect className="settings-select" allowCustom label={t("set.bot.model")} value={draft.model} placeholder={t("usage.cliDefaultModel")}
              options={(routingSettings?.modelOptions[draft.agent]?.models ?? []).map((model) => ({ value: model, label: model }))} onChange={(model) => set({ model })} />
          </div>
          <div className="session-field">
            <label className="session-label" htmlFor={`${id}-prompt`}>{t("modal.systemPrompt")}</label>
            <textarea id={`${id}-prompt`} className="session-prompt" rows={5} placeholder={t("modal.systemPromptPlaceholder")} value={draft.systemPrompt} onChange={(event) => set({ systemPrompt: event.target.value })} />
          </div>
          <button type="button" className="session-row" onClick={() => setView("skills")}>
            <WandSparkles size={14} aria-hidden="true" /><span>{t("set.bot.skills")}</span><small>{t("modal.skillsSelected", { n: draft.skills.length })}</small><ChevronRight size={14} aria-hidden="true" />
          </button>
        </>}
      </div>
      <footer className="bot-editor-foot">
        {missingName && <small id={`${id}-need`} className="bot-editor-need">{t("set.bot.needName")}</small>}
        <span className="settings-spacer" />
        <button type="button" className="settings-button" onClick={requestClose}>{t("side.cancel")}</button>
        <button type="button" className="settings-button primary" disabled={missingName || saving} onClick={() => {
          setSaving(true);
          void onSave({ ...draft, name: draft.name.trim() }).then((ok) => { if (ok) onClose(); }).finally(() => setSaving(false));
        }}>{saving && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t("modal.saveBot")}</button>
      </footer>
    </section>
    {confirmDiscard && <ConfirmDialog title={t("set.bot.discard")} body={t("set.bot.discardBody")} confirmLabel={t("set.bot.discardAction")} onCancel={() => setConfirmDiscard(false)} onConfirm={() => { setConfirmDiscard(false); onClose(); }} />}
  </div>;
}
