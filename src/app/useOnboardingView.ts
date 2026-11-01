import { useEffect, useState } from "react";
import { loadProgress, ONBOARDING_OPEN_EVENT, readyAgents, shouldAutoOpen, type AuthStatus } from "../onboarding-state";
import type { SetupTool } from "../../server/setup";

const DISMISSED_KEY = "orchestra.onboarding.dismissed";

/** 설정 도우미: first launch, or when no agent CLI is ready; reopen from Help. */
export function useOnboardingView() {
  const [onboarding, setOnboarding] = useState(loadProgress);
  const [onboardingView, setOnboardingView] = useState<"open" | "min" | "closed">("closed");
  useEffect(() => {
    let cancelled = false;
    const dismissed = sessionStorage.getItem(DISMISSED_KEY) === "1";
    if (shouldAutoOpen(loadProgress(), undefined, dismissed)) { setOnboardingView("open"); return; }
    void Promise.all([
      fetch("/api/setup").then((r) => r.json() as Promise<{ tools: SetupTool[] }>),
      fetch("/api/settings").then((r) => r.json() as Promise<{ modelOptions?: Record<string, { authStatus?: AuthStatus }> }>).catch(() => ({ modelOptions: {} })),
    ]).then(([setup, settings]) => {
      const auth = Object.fromEntries(Object.entries(settings.modelOptions ?? {}).map(([id, o]) => [id, (o as { authStatus?: AuthStatus } | undefined)?.authStatus]));
      if (!cancelled && shouldAutoOpen(loadProgress(), readyAgents(setup.tools, auth), dismissed)) setOnboardingView("open");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const open = () => setOnboardingView("open");
    window.addEventListener(ONBOARDING_OPEN_EVENT, open);
    (window as unknown as { __orchestraOpenOnboarding?: () => void }).__orchestraOpenOnboarding = open;
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, open);
  }, []);
  const dismiss = () => { sessionStorage.setItem(DISMISSED_KEY, "1"); setOnboardingView("closed"); };
  return { onboarding, setOnboarding, onboardingView, setOnboardingView, dismiss };
}
