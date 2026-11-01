/** 설정 도우미: pure state helpers (tested). */
import type { SetupTool } from "../server/setup";

export const ONBOARDING_STORE = "orchestra.onboarding";
export const ONBOARDING_OPEN_EVENT = "orchestra:open-onboarding";
export const STEPS = [
  { id: "tools", title: "필수 도구", short: "도구" },
  { id: "login", title: "로그인", short: "로그인" },
  { id: "permissions", title: "macOS 권한", short: "권한" },
  { id: "workspaces", title: "작업 공간", short: "공간" },
  { id: "connections", title: "연결 (선택)", short: "연결" },
  { id: "done", title: "완료", short: "완료" },
] as const;
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

export const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ["⌘B", "사이드바 숨기기/보이기 (접으면 왼쪽 가장자리 버튼으로 펼쳐요)"],
  ["F1 / F2", "개인 / 회사 공간 전환"],
  ["⌘⇧T · F3", "도구 관리"],
  ["⌃`", "내장 터미널"],
  ["⌘⇧B", "내장 브라우저"],
  ["⌃⌥← / → / ↑", "브라우저 창 왼쪽 반 / 오른쪽 반 / 최대화"],
  ["⌘T · ⌘W · ⌘⇧T", "브라우저 새 탭 · 탭 닫기 · 닫은 탭 다시 열기"],
  ["⌘[ · ⌘]", "브라우저 뒤로 · 앞으로"],
  ["⌘⇧J", "채팅 접기/펼치기"],
  ["Enter · ⇧Enter", "보내기 · 줄바꿈"],
  ["/usage", "에이전트·모델별 사용량"],
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
