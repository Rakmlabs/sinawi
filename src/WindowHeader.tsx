import { useEffect, type ReactNode } from "react";
import { RotateCw, Wrench, SquareTerminal } from "lucide-react";
import { installAppReload, reloadApp } from "./reload";
import type { WorkspaceId } from "../server/types";
import { WorkspacePill } from "./WorkspacePill";

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
        <span className="window-header-brand" data-tauri-drag-region>Agent Orchestra</span>
        <span className="window-header-separator" aria-hidden="true" data-tauri-drag-region>·</span>
        <span className="window-header-conversation" data-tauri-drag-region title={title || "새 채팅"}>
          {title || "새 채팅"}
        </span>
        {workspaceId && onSwitchWorkspace && <WorkspacePill workspaceId={workspaceId} onSwitch={onSwitchWorkspace} otherRunning={otherRunning} />}
      </div>
      {notifications && <div className="window-header-notifications">{notifications}</div>}
      {onTerminal && <button className="window-header-terminal" type="button" aria-label="통합 터미널" title="통합 터미널 (⌃`)" onClick={onTerminal}><SquareTerminal size={15} /></button>}
      {onTools && <button type="button" className="window-header-tools" aria-label="도구 관리" aria-current={toolsActive ? "page" : undefined} title="도구 관리 (⌘⇧T · F3)" onClick={onTools}><Wrench size={14} aria-hidden="true" /></button>}
      <button
        type="button"
        className="window-header-reload"
        aria-label="새로고침"
        title="새로고침 (⌘R / ⌘⇧R)"
        onClick={() => reloadApp()}
      >
        <RotateCw size={14} aria-hidden="true" />
      </button>
    </header>
  );
}

