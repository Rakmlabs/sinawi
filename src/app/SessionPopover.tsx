import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Settings2, WandSparkles, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { ModelChoice } from "../RoutingControls";
import { RemainingChip } from "../QuotaContext";
import { openSettings } from "../settings/settings-nav";
import { names } from "./labels";
import { SkillPicker } from "./SkillPicker";
import type { RoutingSettings } from "../../server/routing";
import type { AgentId, SkillInfo as Skill } from "../../server/types";
import { t } from "../i18n";

export type SessionPopoverProps = {
  /** Element the popover sits above (the composer's team chip). */
  anchor: HTMLElement | null;
  onClose: () => void;
  busy: boolean;
  /** A conversation is open: these values seed new conversations only. */
  hasActive: boolean;
  agent: AgentId; allowedAgents: AgentId[]; chooseAgent: (id: AgentId) => void;
  model: string; reasoningEffort: string; onModelChange: (model: string, reasoningEffort: string) => void;
  routingSettings: RoutingSettings | undefined;
  systemPrompt: string; setSystemPrompt: (value: string) => void;
  availableSkills: Skill[]; skills: string[]; setSkills: (next: string[]) => void;
  onRefreshSkills: () => void; refreshingSkills: boolean;
  autoSwitch: boolean; quotaFallback: boolean;
};

/** Session options (agent, model, instructions, skills) as a popover above the composer's team chip. */
export function SessionPopover(props: SessionPopoverProps) {
  const { anchor, onClose, busy, hasActive, agent, allowedAgents, model, reasoningEffort, routingSettings, systemPrompt, setSystemPrompt, availableSkills, skills, setSkills, autoSwitch, quotaFallback } = props;
  const root = useRef<HTMLElement>(null);
  const [view, setView] = useState<"main" | "skills">("main");
  const [instructions, setInstructions] = useState(Boolean(systemPrompt));
  const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number }>();
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor?.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      const left = box ? Math.max(12, Math.min(box.left, window.innerWidth - width - 12)) : (window.innerWidth - width) / 2;
      const top = box?.top ?? window.innerHeight - 80;
      setPosition({ left, bottom: Math.max(12, window.innerHeight - top + 8), maxHeight: Math.max(240, top - 24) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("button, input, textarea")?.focus());
    const down = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && (root.current?.contains(target) || target.closest(".glass-select-menu") || anchor?.contains(target))) return;
      onClose();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [anchor, onClose]);
  const switched = useRef(false);
  useEffect(() => {
    // Keep focus inside the popover when the skills subview opens or closes, so Esc keeps working.
    if (!switched.current) { switched.current = true; return; }
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(view === "skills" ? "input, button" : "[data-skills-row]")?.focus());
  }, [view]);
  const close = () => { onClose(); anchor?.querySelector<HTMLElement>("button")?.focus(); };
  const locked = busy;
  const applies = hasActive ? t("set.session.appliesNew") : t("set.session.appliesNext");
  return createPortal(<section ref={root} className="session-popover" role="dialog" aria-label={t("set.session.title")} style={position ?? { visibility: "hidden" }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (view === "skills") setView("main"); else close(); } }}>
    {view === "skills" ? <SkillPicker skills={availableSkills} selected={skills} onChange={setSkills} onBack={() => setView("main")} onRefresh={props.onRefreshSkills} refreshing={props.refreshingSkills} disabled={locked} /> : <>
      <header className="session-popover-head">
        <div><strong>{t("set.session.title")}</strong><small>{applies}</small></div>
        <button type="button" className="settings-icon" aria-label={t("modal.close")} onClick={close}><X size={15} /></button>
      </header>
      {locked && <p className="session-popover-note" role="status">{t("set.session.locked")}</p>}
      <div className="session-popover-body">
        <div className="session-field">
          <span className="session-label">{t("modal.agent")}</span>
          <GlassSelect className="settings-select" label={t("modal.agent")} value={agent} disabled={locked} onChange={(value) => props.chooseAgent(value as AgentId)}
            options={(["codex", "claude", "grok"] as AgentId[]).map((id) => ({ value: id, label: names[id], icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>, disabled: !allowedAgents.includes(id), title: allowedAgents.includes(id) ? undefined : t("rt.notInSpace") }))} />
        </div>
        <ModelChoice disabled={locked} label={t("modal.sessionModel")} value={{ agent, model, reasoningEffort }} settings={routingSettings} chooseAgent={false}
          onChange={(next) => props.onModelChange(next.model ?? "", next.reasoningEffort ?? "")} />
        <button type="button" className="session-row" aria-expanded={instructions} onClick={() => setInstructions((open) => !open)}>
          {instructions ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{t("modal.systemPrompt")}</span>
          <small>{systemPrompt.trim() ? t("set.session.promptSet") : t("set.session.promptNone")}</small>
        </button>
        {instructions && <textarea className="session-prompt" rows={4} aria-label={t("modal.systemPrompt")} placeholder={t("modal.systemPromptPlaceholder")} value={systemPrompt} disabled={locked} onChange={(event) => setSystemPrompt(event.target.value)} />}
        <button type="button" className="session-row" data-skills-row onClick={() => setView("skills")}>
          <WandSparkles size={14} aria-hidden="true" /><span>{t("set.session.skillsTitle")}</span><small>{t("modal.skillsSelected", { n: skills.length })}</small><ChevronRight size={14} aria-hidden="true" />
        </button>
        <p className="session-static">
          <span>{t("set.session.switching", { quota: quotaFallback ? t("set.on") : t("set.off"), route: autoSwitch ? t("set.on") : t("set.off") })}</span>
          <button type="button" className="settings-link" onClick={() => { onClose(); openSettings("agents", "quotaFallback"); }}>{t("set.session.change")}</button>
        </p>
      </div>
      <footer className="session-popover-foot">
        <button type="button" className="settings-link" onClick={() => { onClose(); openSettings(); }}><Settings2 size={13} aria-hidden="true" />{t("set.session.more")}</button>
        <kbd aria-hidden="true">⌘,</kbd>
      </footer>
    </>}
  </section>, document.body);
}
