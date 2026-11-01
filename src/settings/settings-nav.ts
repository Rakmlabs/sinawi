// Settings window navigation: categories, the open event, the last-category memory, ⌘, and the
// search index. Pure helpers (tested in settings.test.ts); the UI lives in SettingsWindow.tsx.
import { t, type MessageKey } from "../i18n";

export const SETTINGS_OPEN_EVENT = "orchestra:open-settings";
export const SETTINGS_LAST_KEY = "sinawi:settings:last";

export const APP_CATEGORIES = ["general", "appearance", "notifications", "shortcuts", "environment", "updates"] as const;
export const WORKSPACE_CATEGORIES = ["workspaces", "agents", "routing", "projects"] as const;
export const CATEGORIES = [...APP_CATEGORIES, ...WORKSPACE_CATEGORIES] as const;
export type SettingsCategory = typeof CATEGORIES[number];

export const categoryLabel = (id: SettingsCategory) => t(`set.cat.${id}` as MessageKey);

export function isCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const storage = (): StorageLike | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The category shown last, or "general". */
export function lastCategory(store: StorageLike | undefined = storage()): SettingsCategory {
  try { const value = store?.getItem(SETTINGS_LAST_KEY); return isCategory(value) ? value : "general"; } catch { return "general"; }
}
export function rememberCategory(id: SettingsCategory, store: StorageLike | undefined = storage()) {
  try { store?.setItem(SETTINGS_LAST_KEY, id); } catch { /* private mode */ }
}

/** Opens the settings window from anywhere (sidebar, composer hints, notifications, onboarding). */
export function openSettings(section?: SettingsCategory, focus?: string) {
  window.dispatchEvent(new CustomEvent(SETTINGS_OPEN_EVENT, { detail: { section, focus } }));
}

type Keyish = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { isComposing?: boolean; keyCode?: number };
/** ⌘, on macOS, Ctrl+, elsewhere. Ignored while an IME is composing. */
export function settingsShortcut(event: Keyish, mac: boolean): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && event.key === ",";
}

/** ↑/↓ (wrapping) through the category list. */
export function stepCategory(current: SettingsCategory, delta: number): SettingsCategory {
  const index = CATEGORIES.indexOf(current);
  return CATEGORIES[(index + delta + CATEGORIES.length) % CATEGORIES.length];
}

/** One searchable setting: where it lives and the words it answers to (label, description, synonyms). */
export type SettingEntry = { id: string; category: SettingsCategory; section: MessageKey; label: MessageKey; description?: MessageKey; keywords?: string };

export const SETTINGS_INDEX: SettingEntry[] = [
  { id: "language", category: "general", section: "set.general.basics", label: "set.general.language", description: "set.general.languageDesc", keywords: "language lang 언어 한국어 english" },
  { id: "reset", category: "general", section: "set.danger", label: "set.general.reset", description: "set.general.resetDesc", keywords: "reset default 초기화 기본값" },
  { id: "theme", category: "appearance", section: "set.appearance.look", label: "appearance.theme", description: "set.appearance.themeDesc", keywords: "theme dark light 테마 다크 라이트 모드" },
  { id: "uiFont", category: "appearance", section: "set.appearance.type", label: "appearance.uiFont.legend", description: "set.appearance.uiFontDesc", keywords: "font 글꼴 폰트 pretendard" },
  { id: "monoFont", category: "appearance", section: "set.appearance.type", label: "appearance.monoFont.legend", description: "set.appearance.monoFontDesc", keywords: "font code mono 코드 글꼴 폰트" },
  { id: "fontSize", category: "appearance", section: "set.appearance.type", label: "appearance.fontSize", description: "set.appearance.fontSizeDesc", keywords: "size scale 글자 크기 확대" },
  { id: "toast-auth", category: "notifications", section: "set.noti.toasts", label: "noti.auth", keywords: "notification toast 알림 로그인 auth" },
  { id: "toast-quota", category: "notifications", section: "set.noti.toasts", label: "noti.quota", keywords: "notification toast 알림 한도 quota" },
  { id: "toast-permission", category: "notifications", section: "set.noti.toasts", label: "noti.permission", keywords: "notification toast 알림 권한" },
  { id: "toast-run-finished", category: "notifications", section: "set.noti.toasts", label: "noti.runFinished", keywords: "notification toast 알림 완료 done" },
  { id: "toast-error", category: "notifications", section: "set.noti.toasts", label: "noti.error", keywords: "notification toast 알림 오류 error" },
  { id: "toast-info", category: "notifications", section: "set.noti.toasts", label: "noti.info", keywords: "notification toast 알림 안내 info" },
  { id: "noti-permission", category: "notifications", section: "set.noti.system", label: "ob.perm.notifications", description: "set.noti.systemDesc", keywords: "macos notification permission 알림 권한" },
  { id: "shortcuts", category: "shortcuts", section: "set.cat.shortcuts", label: "set.shortcuts.list", keywords: "keyboard shortcut hotkey 단축키 키보드" },
  { id: "env-tools", category: "environment", section: "set.env.tools", label: "set.env.tools", description: "set.env.toolsDesc", keywords: "node git cli install 설치 codex claude grok" },
  { id: "env-login", category: "environment", section: "set.env.login", label: "set.env.login", description: "set.env.loginDesc", keywords: "login auth 로그인 인증" },
  { id: "env-permissions", category: "environment", section: "set.env.permissions", label: "set.env.permissions", description: "set.env.permissionsDesc", keywords: "macos permission screen accessibility 권한 화면 기록 손쉬운 사용 디스크" },
  { id: "env-computer", category: "environment", section: "set.env.computer", label: "set.env.computer", description: "set.env.computerDesc", keywords: "computer use 컴퓨터 조작 mouse keyboard screen" },
  { id: "env-onboarding", category: "environment", section: "set.env.onboarding", label: "modal.reopenOnboarding", keywords: "onboarding setup 설정 도우미 온보딩 help 도움말" },
  { id: "update-auto", category: "updates", section: "set.cat.updates", label: "set.updates.auto", keywords: "update 업데이트 version 버전" },
  { id: "workspaces", category: "workspaces", section: "wsset.title", label: "wsset.title", description: "set.ws.desc", keywords: "workspace 작업 공간 F1 F2" },
  { id: "ws-media", category: "workspaces", section: "wsset.rules", label: "wsset.media", description: "wsset.mediaHint", keywords: "image video media 이미지 영상" },
  { id: "ws-computer", category: "workspaces", section: "wsset.rules", label: "wsset.computerUse", description: "wsset.computerUseHint", keywords: "computer use 컴퓨터 조작" },
  { id: "ws-grok-mcp", category: "workspaces", section: "wsset.rules", label: "wsset.grokMcp", description: "wsset.grokMcpHint", keywords: "grok mcp" },
  { id: "ws-blocked", category: "workspaces", section: "wsset.rules", label: "wsset.blockedTools", description: "wsset.blockedToolsHint", keywords: "block tool mcp 차단 도구" },
  { id: "ws-alerts", category: "workspaces", section: "wsset.rules", label: "wsset.alertTools", description: "wsset.alertToolsHint", keywords: "auth alert 인증 알림" },
  { id: "ws-media-prompt", category: "workspaces", section: "wsset.rules", label: "wsset.mediaPrompt", description: "wsset.mediaPromptHint", keywords: "media prompt 미디어 안내" },
  { id: "allowed", category: "agents", section: "set.agents.allowed", label: "set.agents.allowed", description: "set.agents.allowedDesc", keywords: "agent allow codex claude grok 에이전트 허용" },
  { id: "quotaFallback", category: "agents", section: "set.agents.switching", label: "allowed.autoSwitch", description: "set.agents.quotaDesc", keywords: "quota fallback switch 한도 자동 전환" },
  { id: "quotaThreshold", category: "agents", section: "set.agents.switching", label: "set.agents.threshold", description: "set.agents.thresholdDesc", keywords: "threshold percent 임계값 기준" },
  { id: "fallbackOrder", category: "agents", section: "set.agents.switching", label: "set.agents.order", description: "allowed.order", keywords: "priority order 우선순위 순서" },
  { id: "autoSwitch", category: "agents", section: "set.agents.switching", label: "modal.autoSwitch", description: "modal.autoSwitchHint", keywords: "auto switch route 자동 전환 라우팅 대화 중" },
  { id: "planner", category: "routing", section: "set.routing.planner", label: "rt.analyzer", description: "set.routing.plannerDesc", keywords: "planner analyzer model 분석 계획 모델" },
  { id: "models", category: "routing", section: "set.routing.models", label: "set.routing.models", description: "set.routing.modelsDesc", keywords: "model list refresh 모델 목록 새로고침" },
  { id: "rules", category: "routing", section: "set.routing.rules", label: "set.routing.rules", description: "set.routing.rulesDesc", keywords: "rule keyword route 규칙 키워드 배정" },
  { id: "advanced", category: "routing", section: "set.routing.advanced", label: "set.routing.advanced", description: "set.routing.advancedDesc", keywords: "json advanced 고급" },
  { id: "folder", category: "projects", section: "set.projects.folder", label: "wsset.folder", description: "set.projects.folderDesc", keywords: "folder cwd directory 폴더 경로" },
  { id: "projects", category: "projects", section: "set.projects.list", label: "set.projects.list", description: "set.projects.listDesc", keywords: "project group 프로젝트 그룹" },
];

/** Case-insensitive match over label, description, section and synonyms in the current language. */
export function searchSettings(query: string, index: SettingEntry[] = SETTINGS_INDEX): SettingEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index.filter((entry) => {
    const haystack = [t(entry.label), entry.description ? t(entry.description) : "", t(entry.section), categoryLabel(entry.category), entry.keywords ?? ""].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
