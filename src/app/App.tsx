import { Onboarding } from "../Onboarding";
import { isStrandedShell, returnToAppServer } from "../app-origin";
import { useWorkspaceState } from "./useWorkspaceState";
import { useOnboardingView } from "./useOnboardingView";
import { WorkspaceApp } from "./WorkspaceApp";
import { t } from "../i18n";

/** Workspace switcher shell: loads workspace state and mounts one WorkspaceApp per workspace. */
export function App() {
  const { workspaces, workspaceError, updateDefaults, switchWorkspace, retry } = useWorkspaceState();
  const { onboarding, setOnboarding, onboardingView, setOnboardingView, dismiss } = useOnboardingView();
  return <>
    {onboardingView === "open" && workspaces && <Onboarding progress={onboarding} onProgress={setOnboarding} workspaceId={workspaces.currentWorkspaceId} onSwitchWorkspace={switchWorkspace}
      onMinimize={() => setOnboardingView("min")} onClose={dismiss} />}
    {onboardingView === "min" && <button className="ob-resume" onClick={() => setOnboardingView("open")}>{t("app.resumeOnboarding")}</button>}
    {workspaceError && <div className="error-banner workspace-error" role="alert">{workspaceError}<button onClick={() => {
      if (isStrandedShell(location.href)) returnToAppServer();
      else retry();
    }}>{t("common.retry")}</button></div>}
    {workspaces ? <WorkspaceApp key={workspaces.currentWorkspaceId} workspaceId={workspaces.currentWorkspaceId} defaults={workspaces.defaults[workspaces.currentWorkspaceId]} onDefaultsChange={updateDefaults} onSwitchWorkspace={() => switchWorkspace(workspaces.currentWorkspaceId === "personal" ? "company" : "personal")} /> : !workspaceError && <div role="status">{t("app.loadingWorkspace")}</div>}
  </>;
}
