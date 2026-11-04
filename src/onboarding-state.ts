/** 설정 도우미: pure state helpers (tested). */
import type { SetupTool } from "../server/setup";
import { accountLoginCommand } from "../server/workspace-policy";
import type { AgentId, WorkspaceId } from "../server/types";
import { t, type MessageKey } from "./i18n";

export function environmentSettingsPath(workspaceId: WorkspaceId | undefined): string {
  return workspaceId ? `/api/settings?workspace=${encodeURIComponent(workspaceId)}` : "/api/settings";
}

export function environmentLoginCommand(tool: SetupTool, accounts: Partial<Record<AgentId, string>>): string | undefined {
  if (!tool.agent || !(["claude", "codex", "grok"] as string[]).includes(tool.id)) return tool.login;
  return accountLoginCommand(tool.id as AgentId, accounts[tool.id as AgentId]);
}

export const ONBOARDING_STORE = "orchestra.onboarding";
export const ONBOARDING_OPEN_EVENT = "orchestra:open-onboarding";
const step = <I extends string>(id: I) => ({
  id,
  get title() { return t(`onboarding.step.${id}` as MessageKey); },
  get short() { return t(`onboarding.short.${id}` as MessageKey); },
});
export const STEPS = [step("tools"), step("login"), step("permissions"), step("workspaces"), step("connections"), step("done")] as const;
export type StepId = typeof STEPS[number]["id"];

export type OnboardingProgress = { step: number; completed: boolean; skipped: boolean; acknowledged: string[] };
export const initialProgress = (): OnboardingProgress => ({ step: 0, completed: false, skipped: false, acknowledged: [] });

type StorageLike = Pick<Storage, "getItem" | "setItem">;
export function loadProgress(storage: StorageLike | undefined = globalThis.localStorage): OnboardingProgress {
  try {
    const raw = JSON.parse(storage?.getItem(ONBOARDING_STORE) ?? "null");
    if (!raw || typeof raw !== "object") return initialProgress();
    return { step: Math.min(STEPS.length - 1, Math.max(0, Number(raw.step) || 0)), completed: raw.completed === true, skipped: raw.skipped === true, acknowledged: Array.isArray(raw.acknowledged) ? raw.acknowledged.filter((v: unknown) => typeof v === "string") : [] };
  } catch { return initialProgress(); }
}
export function saveProgress(progress: OnboardingProgress, storage: StorageLike | undefined = globalThis.localStorage) {
  try { storage?.setItem(ONBOARDING_STORE, JSON.stringify(progress)); } catch { /* private mode */ }
}

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown" | undefined;
/** An agent is ready when its CLI is installed and not known to be logged out. */
export function readyAgents(tools: SetupTool[] | undefined, auth: Partial<Record<string, AuthStatus>>): string[] {
  return (tools ?? []).filter((tool) => tool.agent && tool.installed && auth[tool.id] !== "unauthenticated").map((tool) => tool.id);
}

/** First launch, or no agent CLI usable (unless dismissed in this session). */
export function shouldAutoOpen(progress: OnboardingProgress, ready: string[] | undefined, dismissedThisSession: boolean): boolean {
  if (dismissedThisSession) return false;
  if (!progress.completed && !progress.skipped) return true;
  return ready !== undefined && ready.length === 0;
}

export type StepStatus = "ok" | "warn";
export function toolsStatus(tools: SetupTool[] | undefined): StepStatus {
  if (!tools) return "warn";
  const base = tools.filter((t) => !t.agent).every((t) => t.installed);
  return base && tools.some((t) => t.agent && t.installed) ? "ok" : "warn";
}
export function loginStatus(tools: SetupTool[] | undefined, auth: Partial<Record<string, AuthStatus>>): StepStatus {
  return (tools ?? []).some((t) => t.agent && t.installed && auth[t.id] === "authenticated") ? "ok" : "warn";
}

export const SHORTCUTS: ReadonlyArray<[string, MessageKey]> = [
  ["⌘,", "shortcut.settings"],
  ["⌘B", "shortcut.sidebar"],
  ["F1 / F2", "shortcut.workspace"],
  ["⌘⇧T · F3", "shortcut.tools"],
  ["⌃`", "shortcut.terminal"],
  ["⌘⇧B", "shortcut.browser"],
  ["⌃⌥← / → / ↑", "shortcut.snap"],
  ["⌘T · ⌘W · ⌘⇧T", "shortcut.tabs"],
  ["⌘[ · ⌘]", "shortcut.history"],
  ["⌘⇧J", "shortcut.chat"],
  ["Enter · ⇧Enter", "shortcut.send"],
  ["/usage", "shortcut.usage"],
];

export type PermState = "granted" | "denied" | "unknown";
/** Native (Tauri) status wins, then the server/web check; only undetectable ones fall back to "켰어요". */
export function permissionView(native: PermState | undefined, detected: PermState | undefined, acknowledged: boolean): "ok" | "warn" | "manual" {
  const state = native && native !== "unknown" ? native : detected;
  if (state === "granted") return "ok";
  if (state === "denied") return acknowledged && !native ? "ok" : "warn";
  return acknowledged ? "ok" : "manual";
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export const tauriInvoke = (): Invoke | undefined => (globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
