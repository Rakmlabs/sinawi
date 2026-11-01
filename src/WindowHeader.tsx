import { useEffect, type ReactNode, type Ref } from "react";
import { PanelLeft, RotateCw, Settings2, SquareTerminal, Wrench } from "lucide-react";
import { installAppReload, reloadApp } from "./reload";
import type { WorkspaceId } from "../server/types";
import { WorkspacePill } from "./WorkspacePill";
import { t } from "./i18n";
import { SinawiMark } from "./SinawiMark";
import { Beat } from "./Beat";
import { Elapsed } from "./app/Elapsed";
import { railToggleLabel } from "./sidebar-rail";

export function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type WindowHeaderProps = {
  title?: string;
  /** Muted breadcrumb between the brand and the title (project or folder). */
  project?: string;
  /** ISO time the current run started; shows the running pill while set. */
  runningSince?: string;
  sidebar?: { open: boolean; controls: string; onToggle: () => void; buttonRef?: Ref<HTMLButtonElement> };
  workspaceId?: WorkspaceId;
  onSwitchWorkspace?: () => void;
  otherRunning?: number;
  onTools?: () => void;
  toolsActive?: boolean;
  onSettings?: () => void;
  settingsActive?: boolean;
  onTerminal?: () => void;
  notifications?: ReactNode;
};

/**
 * App title bar: a plain flex row. In Tauri the macOS traffic lights overlay its left edge, so a
 * spacer reserves them; the sidebar toggle always sits right after it. Every non-interactive
 * element carries data-tauri-drag-region because the drag listener only reacts to direct hits.
 */
export function WindowHeader({ title, project, runningSince, sidebar, workspaceId, onSwitchWorkspace, otherRunning, onTools, toolsActive, onSettings, settingsActive, onTerminal, notifications }: WindowHeaderProps) {
  useEffect(() => installAppReload(window), []);
  const desktop = isTauri();
  if (!desktop && !sidebar && !onTerminal && !notifications) return null;
  const heading = title || t("common.newChat");
  const toggleLabel = sidebar ? railToggleLabel(!sidebar.open) : "";

  // Tauri's drag-region listener also handles native double-click maximize.
  return (
    <header className="window-header" data-tauri-drag-region>
      {desktop && <div className="window-header-traffic" aria-hidden="true" data-tauri-drag-region />}
      {sidebar && <button ref={sidebar.buttonRef} type="button" className="header-icon-button window-header-sidebar" aria-label={toggleLabel} title={t("side.toggleTitle", { label: toggleLabel })}
        aria-expanded={sidebar.open} aria-controls={sidebar.controls} onClick={sidebar.onToggle}><PanelLeft size={18} aria-hidden="true" /></button>}
      <div className="window-header-crumbs" role="group" aria-label={t("header.location")} data-tauri-drag-region>
        <span className="window-header-brand" data-tauri-drag-region><SinawiMark size={20} />Sinawi</span>
        {project && <>
          <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>/</span>
          <span className="window-header-project" data-tauri-drag-region title={project}>{project}</span>
        </>}
        <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>/</span>
        <span className="window-header-conversation" data-tauri-drag-region title={heading}>{heading}</span>
        {runningSince && <span className="window-header-status" data-tauri-drag-region><Beat />{t("status.running")} · <Elapsed start={runningSince} /></span>}
      </div>
      <div className="window-header-actions" data-tauri-drag-region>
        {workspaceId && onSwitchWorkspace && <WorkspacePill workspaceId={workspaceId} onSwitch={onSwitchWorkspace} otherRunning={otherRunning} />}
        {onTerminal && <button className="header-icon-button" type="button" aria-label={t("header.terminal")} title={t("header.terminalTitle")} onClick={onTerminal}><SquareTerminal size={18} aria-hidden="true" /></button>}
        {notifications}
        {onTools && <button type="button" className="header-icon-button" aria-label={t("header.tools")} aria-current={toolsActive ? "page" : undefined} title={t("header.toolsTitle")} onClick={onTools}><Wrench size={18} aria-hidden="true" /></button>}
        {onSettings && <button type="button" className="header-icon-button" aria-label={t("side.settings")} aria-current={settingsActive ? "page" : undefined} title={t("side.settings")} onClick={onSettings}><Settings2 size={18} aria-hidden="true" /></button>}
        <button type="button" className="header-icon-button" aria-label={t("common.reload")} title={t("header.reloadTitle")} onClick={() => reloadApp()}>
          <RotateCw size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
