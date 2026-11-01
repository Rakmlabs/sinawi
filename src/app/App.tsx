import { useMemo } from "react";
import { Onboarding } from "../Onboarding";
import { isStrandedShell, returnToAppServer } from "../app-origin";
import { useWorkspaceState } from "./useWorkspaceState";
import { useOnboardingView } from "./useOnboardingView";
import { WorkspaceApp } from "./WorkspaceApp";
import { WorkspacesContext, type WorkspacesApi } from "../workspace-context";
import { t } from "../i18n";

/** Workspace shell: loads the user-defined workspaces and mounts one WorkspaceApp for the current one. */
export function App() {
  const { workspaces, workspaceError, updateDefaults, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, saveDefaults, retry } = useWorkspaceState();
  const { onboarding, setOnboarding, onboardingView, setOnboardingView, dismiss } = useOnboardingView();
  const api = useMemo<WorkspacesApi>(() => ({
    workspaces: workspaces?.workspaces ?? [],
    currentId: workspaces?.currentWorkspaceId,
    defaults: workspaces?.defaults ?? {},
    running: workspaces?.runningByWorkspace ?? {},
    switchTo: switchWorkspace,
    create: createWorkspace,
    rename: renameWorkspace,
    remove: deleteWorkspace,
    saveDefaults,
  }), [workspaces, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, saveDefaults]);
  return <WorkspacesContext.Provider value={api}>
    {onboardingView === "open" && workspaces && <Onboarding progress={onboarding} onProgress={setOnboarding} workspaceId={workspaces.currentWorkspaceId} onSwitchWorkspace={switchWorkspace}
      onMinimize={() => setOnboardingView("min")} onClose={dismiss} />}
    {onboardingView === "min" && <button className="ob-resume" onClick={() => setOnboardingView("open")}>{t("app.resumeOnboarding")}</button>}
    {workspaceError && <div className="error-banner workspace-error" role="alert">{workspaceError}<button onClick={() => {
      if (isStrandedShell(location.href)) returnToAppServer();
      else retry();
    }}>{t("common.retry")}</button></div>}
    {workspaces ? <WorkspaceApp key={workspaces.currentWorkspaceId} workspaceId={workspaces.currentWorkspaceId} defaults={workspaces.defaults[workspaces.currentWorkspaceId] ?? {}} onDefaultsChange={updateDefaults} /> : !workspaceError && <div role="status">{t("app.loadingWorkspace")}</div>}
  </WorkspacesContext.Provider>;
}
