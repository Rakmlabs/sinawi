import type { WorkspaceId } from "../server/types";
import { t, translatedMap } from "./i18n";

const workspaceLabels = translatedMap<WorkspaceId>({
  personal: "workspace.personal",
  company: "workspace.company",
});
const workspaceDestinations = translatedMap<WorkspaceId>({
  personal: "workspace.toPersonal",
  company: "workspace.toCompany",
});

export function workspaceTargetLabel(workspaceId: WorkspaceId) {
  return t("workspace.moveTo", { dest: workspaceDestinations[workspaceId === "personal" ? "company" : "personal"] });
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
    aria-label={t("workspace.pillLabel", { current, dest: workspaceDestinations[otherId] })}
    title={t("workspace.pillTitle", { other })}
    onClick={onSwitch}
  >
    <span className="workspace-pill-dot" aria-hidden="true" />
    <span className="workspace-pill-label">{current}</span>
    <span className="workspace-pill-other" aria-hidden="true">⇄ {other}</span>
    {otherRunning > 0 && <span className="workspace-running-badge" aria-label={t("workspace.otherRunning", { other, count: otherRunning })}>{otherRunning}</span>}
  </button>;
}
