import { useEffect, type ReactNode, type Ref } from "react";
import { Activity, Globe, PanelLeft, SquareTerminal } from "lucide-react";
import { installAppReload } from "./reload";
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
  /** Workspace switcher (renders nothing with a single workspace). */
  workspace?: ReactNode;
  onTerminal?: () => void;
  onBrowser?: () => void;
  notifications?: ReactNode;
  /** Activity panel toggle for the open conversation. */
  activity?: { open: boolean; controls: string; onToggle: () => void };
  /** Contextual controls placed before the fixed icons (e.g. folding the chat beside the browser). */
  extra?: ReactNode;
};

/**
 * App title bar: lights · sidebar toggle · brand / project / title · run status, and on the right
 * only the workspace switcher and panel toggles. In Tauri the macOS traffic lights overlay the left
 * edge, so a spacer reserves them. Reload has no button: ⌘R (installAppReload) and settings/help.
 * Every non-interactive element carries data-tauri-drag-region because the drag listener only
 * reacts to direct hits.
 */
export function WindowHeader({ title, project, runningSince, sidebar, workspace, onTerminal, onBrowser, notifications, activity, extra }: WindowHeaderProps) {
  useEffect(() => installAppReload(window), []);
  const desktop = isTauri();
  if (!desktop && !sidebar && !onTerminal && !notifications) return null;
  const heading = title || t("common.newChat");
  const toggleLabel = sidebar ? railToggleLabel(!sidebar.open) : "";

  // Tauri's drag-region listener also handles native double-click maximize.
  return (
    <header className={`window-header${desktop ? " has-traffic-lights" : ""}`} data-tauri-drag-region>
      {desktop && <div className="window-header-traffic" aria-hidden="true" data-tauri-drag-region />}
      {sidebar && <button ref={sidebar.buttonRef} type="button" className="header-icon-button window-header-sidebar" aria-label={toggleLabel} title={t("side.toggleTitle", { label: toggleLabel })}
        aria-expanded={sidebar.open} aria-controls={sidebar.controls} onClick={sidebar.onToggle}><PanelLeft size={18} aria-hidden="true" /></button>}
      <div className="window-header-crumbs" role="group" aria-label={t("header.location")} data-tauri-drag-region>
        <span className="window-header-brand" data-tauri-drag-region><SinawiMark size={18} />Sinawi</span>
        {project && <>
          <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>/</span>
          <span className="window-header-project" data-tauri-drag-region title={project}>{project}</span>
        </>}
        <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>/</span>
        <span className="window-header-conversation" data-tauri-drag-region title={heading}>{heading}</span>
        {runningSince && <span className="window-header-status" data-tauri-drag-region><Beat />{t("status.running")} · <Elapsed start={runningSince} /></span>}
      </div>
      <div className="window-header-actions" data-tauri-drag-region>
        {workspace}
        {extra}
        {onTerminal && <button className="header-icon-button" type="button" aria-label={t("header.terminal")} title={t("header.terminalTitle")} onClick={onTerminal}><SquareTerminal size={18} aria-hidden="true" /></button>}
        {onBrowser && <button className="header-icon-button" type="button" aria-label={t("ws.browser")} title={t("ws.browserTitle")} onClick={onBrowser}><Globe size={18} aria-hidden="true" /></button>}
        {notifications}
        {activity && <button className="header-icon-button" type="button" aria-label={t("activity.label")} title={t("activity.title")} aria-expanded={activity.open} aria-controls={activity.controls} onClick={activity.onToggle}><Activity size={18} aria-hidden="true" /></button>}
      </div>
    </header>
  );
}
