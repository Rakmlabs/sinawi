import type { WorkspaceId } from "../server/types";

const workspaceLabels: Record<WorkspaceId, string> = {
  personal: "개인",
  company: "회사",
};
const workspaceDestinations: Record<WorkspaceId, string> = {
  personal: "개인으로",
  company: "회사로",
};

export function workspaceTargetLabel(workspaceId: WorkspaceId) {
  return `${workspaceDestinations[workspaceId === "personal" ? "company" : "personal"]} 이동`;
}

type WorkspacePillProps = {
  workspaceId: WorkspaceId;
  onSwitch: () => void;
  otherRunning?: number;
  className?: string;
};

export function WorkspacePill({ workspaceId, onSwitch, otherRunning = 0, className = "" }: WorkspacePillProps) {
  const current = workspaceLabels[workspaceId];
  const otherId = workspaceId === "personal" ? "company" : "personal";
  const other = workspaceLabels[otherId];
  return <button
    type="button"
    className={`workspace-pill ${workspaceId}${className ? ` ${className}` : ""}`}
    aria-label={`${current} 작업 공간, ${workspaceDestinations[otherId]} 전환`}
    title={`${other} 작업 공간으로 전환`}
    onClick={onSwitch}
  >
    <span className="workspace-pill-dot" aria-hidden="true" />
    <span className="workspace-pill-label">{current}</span>
    {otherRunning > 0 && <span className="workspace-running-badge" aria-label={`${other}에서 진행 중인 작업 ${otherRunning}개`}>{otherRunning}</span>}
  </button>;
}
