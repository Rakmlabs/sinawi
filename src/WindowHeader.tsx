import { useEffect, type ReactNode } from "react";
import { RotateCw, Wrench, SquareTerminal } from "lucide-react";
import { installAppReload, reloadApp } from "./reload";
import type { WorkspaceId } from "../server/types";
import { WorkspacePill } from "./WorkspacePill";
import { t } from "./i18n";
import { SinawiMark } from "./SinawiMark";

export function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type WindowHeaderProps = {
  title?: string;
  workspaceId?: WorkspaceId;
  onSwitchWorkspace?: () => void;
  otherRunning?: number;
  onTools?: () => void;
  toolsActive?: boolean;
  onTerminal?: () => void;
  notifications?: ReactNode;
};

export function WindowHeader({ title, workspaceId, onSwitchWorkspace, otherRunning, onTools, toolsActive, onTerminal, notifications }: WindowHeaderProps) {
  useEffect(() => installAppReload(window), []);
  if (!isTauri() && !onTerminal && !notifications) return null;

  // Tauri's drag-region listener also handles native double-click maximize.
  return (
    <header className="window-header" data-tauri-drag-region>
      <div className="window-header-title" data-tauri-drag-region>
        <span className="window-header-brand" data-tauri-drag-region><SinawiMark size={16} />Sinawi</span>
        <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>·</span>
        <span className="window-header-conversation" data-tauri-drag-region title={title || t("common.newChat")}>
          {title || t("common.newChat")}
        </span>
        {workspaceId && onSwitchWorkspace && <WorkspacePill workspaceId={workspaceId} onSwitch={onSwitchWorkspace} otherRunning={otherRunning} />}
      </div>
      {notifications && <div className="window-header-notifications">{notifications}</div>}
      {onTerminal && <button className="window-header-terminal" type="button" aria-label={t("header.terminal")} title={t("header.terminalTitle")} onClick={onTerminal}><SquareTerminal size={15} /></button>}
      {onTools && <button type="button" className="window-header-tools" aria-label={t("header.tools")} aria-current={toolsActive ? "page" : undefined} title={t("header.toolsTitle")} onClick={onTools}><Wrench size={14} aria-hidden="true" /></button>}
      <button
        type="button"
        className="window-header-reload"
        aria-label={t("common.reload")}
        title={t("header.reloadTitle")}
        onClick={() => reloadApp()}
      >
        <RotateCw size={14} aria-hidden="true" />
      </button>
    </header>
  );
}

