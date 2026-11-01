import { Activity, Check, LoaderCircle, Search, WandSparkles, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { FolderPicker } from "../FolderPicker";
import { GlassSelect } from "../GlassSelect";
import { UsagePanel } from "../UsagePanel";
import { ModelChoice } from "../RoutingControls";
import { RemainingChip } from "../QuotaContext";
import { ONBOARDING_OPEN_EVENT } from "../onboarding-state";
import { names } from "./labels";
import { AppearanceSettings } from "./AppearanceSettings";
import { UpdateSettings } from "../updates/UpdateSettings";
import type { Bootstrap } from "./api";
import type { RoutingSettings } from "../../server/routing";
import type { AgentId, SkillInfo as Skill, WorkspaceId } from "../../server/types";
import { t, translatedMap } from "../i18n";

export type AppModalProps = {
  modal: string;
  setModal: (modal: string | undefined) => void;
  workspaceId: WorkspaceId;
  error: string;
  clearError: () => void;
  busy: boolean;
  agents: Bootstrap["agents"];
  availableSkills: Skill[];
  skills: string[];
  setSkills: React.Dispatch<React.SetStateAction<string[]>>;
  search: string;
  setSearch: (value: string) => void;
  skillReturn: string | undefined;
  setSkillReturn: (value: string | undefined) => void;
  shownCwd: string;
  cwd: string;
  onUseFolder: (path: string) => void;
  botName: string;
  setBotName: (value: string) => void;
  agent: AgentId;
  chooseAgent: (id: AgentId) => void;
  allowedAgents: AgentId[];
  model: string;
  reasoningEffort: string;
  onModelChange: (model: string, reasoningEffort: string) => void;
  routingSettings: RoutingSettings | undefined;
  autoSwitch: boolean;
  setAutoSwitch: (value: boolean) => void;
  systemPrompt: string;
  setSystemPrompt: (value: string) => void;
  onOpenRouting: () => void;
  onRefreshSkills: () => void;
  onSaveBot: () => void;
};

const titles: Record<string, string> = translatedMap({
  usage: "modal.usage",
  skills: "modal.skills",
  directory: "modal.directory",
  bot: "modal.bot",
  settings: "modal.settings",
});

const reopenOnboarding = (close: () => void) => { close(); window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT)); };

/** Usage, skills, folder, session settings, bot and help dialogs. */
export function AppModal(props: AppModalProps) {
  const { modal, setModal, workspaceId, error, clearError, busy, skills, setSkills, search, setSearch, shownCwd, agent, allowedAgents, model, reasoningEffort, routingSettings, autoSwitch, setAutoSwitch, systemPrompt, setSystemPrompt } = props;
  const close = () => setModal(undefined);
  return <div className="modal-backdrop" onClick={close}>
    <section
      className={`glass modal ${modal === "usage" ? "usage-modal" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="panel-header">
        <h2 id="modal-title">
          {titles[modal] ?? t("modal.help")}
        </h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label={t("modal.close")}
        >
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              aria-label={t("modal.closeError")}
              onClick={clearError}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {modal === "skills" && (
          <>
            <p>{t("modal.skillsIntro")}</p>
            <button className="button light" disabled={busy || !shownCwd} onClick={props.onRefreshSkills}>{busy ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{t("modal.refreshSkills")}</button>
            <div className="search-field">
              <Search size={16} />
              <input
                placeholder={t("modal.searchSkillsPlaceholder")}
                aria-label={t("modal.searchSkills")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="skill-list">
              {props.availableSkills
                .filter((s) =>
                  (s.name + " " + s.source)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((s) => (
                  <label className="skill-row" key={s.id}>
                    <input
                      type="checkbox"
                      checked={skills.includes(s.id)}
                      disabled={
                        !skills.includes(s.id) && skills.length >= 20
                      }
                      onChange={() =>
                        setSkills((old) =>
                          old.includes(s.id)
                            ? old.filter((x) => x !== s.id)
                            : [...old, s.id],
                        )
                      }
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.description || s.source}</small>
                    </span>
                    <span className="source-tag">{s.source}<br />{s.agents?.map((id) => names[id]).join(" · ")}</span>
                  </label>
                ))}
              {!props.availableSkills.length && (
                <p>{t("modal.noSkills")}</p>
              )}
            </div>
            <button
              className="button primary"
              onClick={() => {
                setModal(props.skillReturn);
                props.setSkillReturn(undefined);
              }}
            >
              {t("modal.useSkills", { n: skills.length })} <Check size={15} />
            </button>
          </>
        )}
        {modal === "usage" && <UsagePanel initialWorkspace={workspaceId} />}
        {modal === "directory" && <FolderPicker key={workspaceId} workspaceId={workspaceId} currentPath={props.cwd} onUse={props.onUseFolder} />}
        {(modal === "settings" || modal === "bot") && (
          <>
            {modal === "bot" && (
              <label>
                {t("modal.botName")}
                <input
                  value={props.botName}
                  onChange={(e) => props.setBotName(e.target.value)}
                  placeholder={t("modal.botNamePlaceholder")}
                />
              </label>
            )}
            <label>
              {t("modal.agent")}
              <GlassSelect label={t("modal.agent")} value={agent} disabled={busy} onChange={(value) => props.chooseAgent(value as AgentId)} options={(["codex", "claude", "grok"] as AgentId[]).map((id) => ({ value: id, label: names[id], icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>, disabled: !allowedAgents.includes(id) }))} />
            </label>
            <ModelChoice disabled={busy} label={t("modal.sessionModel")} value={{ agent, model, reasoningEffort }} settings={routingSettings} chooseAgent={false} onChange={(next) => props.onModelChange(next.model ?? "", next.reasoningEffort ?? "")} />
            {modal === "settings" && <label className="auto-switch-setting">
              <span><strong>{t("modal.autoSwitch")}</strong><small>{t("modal.autoSwitchHint")}</small></span>
              <input type="checkbox" checked={autoSwitch} disabled={busy} onChange={(event) => setAutoSwitch(event.target.checked)} />
            </label>}
            {modal === "settings" && <AppearanceSettings />}
            {modal === "settings" && <UpdateSettings />}
            {modal === "settings" && <button className="button light" onClick={props.onOpenRouting}>{t("modal.editRouting")}</button>}
            {modal === "settings" && <button className="button light" onClick={() => reopenOnboarding(close)}>{t("modal.reopenOnboarding")}</button>}
            <label>
              {t("modal.systemPrompt")}
              <textarea
                rows={5}
                placeholder={t("modal.systemPromptPlaceholder")}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
            </label>
            <button
              className="button light"
              onClick={() => {
                props.setSkillReturn(modal);
                setModal("skills");
              }}
            >
              <WandSparkles size={15} />
              {t("modal.skillsSelected", { n: skills.length })}
            </button>
            <p className="muted">{t("modal.appliesToNew")}</p>
            <button
              className="button primary"
              disabled={busy || (modal === "bot" && !props.botName.trim())}
              onClick={() => modal === "bot" ? props.onSaveBot() : close()}
            >
              {modal === "bot" ? t("modal.saveBot") : t("modal.done")}
              <Check size={15} />
            </button>
          </>
        )}
        {modal === "help" && (
          <>
            <button className="button primary onboarding-reopen" onClick={() => reopenOnboarding(close)}>{t("modal.reopenOnboarding")}</button>
            <p>{t("modal.helpBody")}</p>
            <h3 className="help-heading">{t("modal.shortcuts")}</h3>
            <ul className="help-shortcuts">
              {[`⌘N · ${t("common.newChat")}`, `⌘K · ${t("side.search")}`, `⌘R · ${t("common.reload")}`, ...t("comp.hints").split(" · ")].map((hint) => <li key={hint}>{hint}</li>)}
            </ul>
            <div className="cli-status-list">
              {props.agents.map((a) => (
                <div key={a.id}>
                  <AgentMark agent={a.id} />
                  <strong>{a.name}</strong>
                  <span
                    className={
                      a.available ? "available" : "unavailable"
                    }
                  >
                    {a.available ? t("modal.installed") : t("modal.unavailable")}
                  </span>
                </div>
              ))}
            </div>
            <p>{t("modal.authNote")}</p>
            <p className="muted">{t("modal.serverInfo", { host: location.host })}</p>
          </>
        )}
      </div>
    </section>
  </div>;
}
