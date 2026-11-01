import { useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { names } from "./labels";
import type { SkillInfo as Skill } from "../../server/types";
import { t } from "../i18n";

export const SKILL_LIMIT = 20;

/**
 * "Skills for this session / bot": search + checklist (max 20). Distinct from Tools › Skills,
 * which turns skills on or off for the whole workspace.
 */
export function SkillPicker({ skills, selected, onChange, onBack, onRefresh, refreshing = false, disabled = false }: {
  skills: Skill[]; selected: string[]; onChange: (next: string[]) => void; onBack: () => void;
  onRefresh?: () => void; refreshing?: boolean; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const shown = term ? skills.filter((skill) => `${skill.name} ${skill.source} ${skill.description ?? ""}`.toLocaleLowerCase().includes(term)) : skills;
  return <div className="skill-picker">
    <header className="skill-picker-head">
      <button type="button" className="settings-icon" aria-label={t("set.session.back")} onClick={onBack}><ArrowLeft size={15} /></button>
      <strong>{t("set.session.skillsTitle")}</strong>
      <span className="settings-spacer" />
      <small aria-live="polite">{t("set.session.skillsCount", { n: selected.length, max: SKILL_LIMIT })}</small>
      {onRefresh && <button type="button" className="settings-icon" aria-label={t("modal.refreshSkills")} title={t("modal.refreshSkills")} disabled={refreshing} onClick={onRefresh}>{refreshing ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button>}
    </header>
    <div className="settings-search-field inline">
      <Search size={14} aria-hidden="true" />
      <input type="search" autoFocus value={query} placeholder={t("modal.searchSkillsPlaceholder")} aria-label={t("modal.searchSkills")} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
    </div>
    <ul className="skill-picker-list">
      {shown.map((skill) => {
        const checked = selected.includes(skill.id);
        const full = !checked && selected.length >= SKILL_LIMIT;
        return <li key={skill.id}><label className={`skill-picker-row${full ? " full" : ""}`} title={full ? t("comp.skillLimit") : undefined}>
          <input type="checkbox" checked={checked} disabled={disabled || full} onChange={() => onChange(checked ? selected.filter((id) => id !== skill.id) : [...selected, skill.id])} />
          <span><strong>{skill.name}</strong><small>{skill.description || skill.source}</small></span>
          <small className="skill-picker-source">{skill.agents?.length ? skill.agents.map((id) => names[id]).join(" · ") : skill.source}</small>
        </label></li>;
      })}
      {!skills.length && <li className="settings-empty-line">{t("modal.noSkills")}</li>}
      {skills.length > 0 && !shown.length && <li className="settings-empty-line">{t("set.search.none", { query: query.trim() })}</li>}
    </ul>
    <p className="settings-hint">{t("set.session.skillsHint")}</p>
  </div>;
}
