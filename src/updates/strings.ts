// Update UI strings. Kept out of src/i18n.ts so this feature stays self-contained; the language
// itself still follows the app setting (getLang/useLang). `en` must carry exactly the `ko` keys.
import { getLang, useLang } from "../i18n";

const ko = {
  "update.available": "업데이트 있음 v{version}",
  "update.restartNow": "지금 재시작",
  "update.later": "나중에",
  "update.notes": "릴리스 노트",
  "update.hideNotes": "노트 닫기",
  "update.close": "닫기",
  "update.downloading": "v{version} 받는 중… {percent}",
  "update.downloadFailed": "v{version} 다운로드 실패",
  "update.retry": "다시 시도",
  "update.installing": "업데이트 설치 중…",
  "update.installFailed": "업데이트 설치 실패: {error}",
  "update.sessionsRunning": "작업 {count}개 진행 중 — 끝나면 업데이트",
  "update.sessionsHint": "지금 재시작해도 작업은 백그라운드 서버에서 계속되지만, 서버 업데이트는 작업이 끝난 뒤 적용됩니다.",
  "update.whenDone": "끝나면 재시작",
  "update.restartAnyway": "그래도 지금 재시작",
  "update.cancel": "취소",
  "update.waiting": "작업 {count}개가 끝나면 자동으로 재시작합니다",
  "update.serverPending": "서버가 아직 이전 버전입니다 — 진행 중인 작업 {count}개가 끝나면 자동 적용됩니다",
  "update.serverPendingIdle": "서버가 아직 이전 버전입니다 — 곧 자동 적용됩니다",
  "update.serverStale": "서버가 앱과 다른 버전으로 실행 중입니다. 앱을 다시 시작하거나 ~/Library/Logs/Sinawi/agent.log 를 확인하세요.",
  "update.settingsTitle": "업데이트",
  "update.autoCheck": "자동으로 업데이트 확인",
  "update.autoCheckHint": "시작할 때와 6시간마다 확인하고 백그라운드에서 받아 둡니다. 설치는 직접 재시작할 때만 합니다.",
  "update.checkNow": "업데이트 확인",
  "update.checking": "확인 중…",
  "update.upToDate": "최신 버전입니다",
  "update.currentVersion": "현재 버전 v{version}",
  "update.lastChecked": "마지막 확인 {time}",
  "update.checkFailed": "업데이트 확인 실패: {error}",
  "update.ready": "v{version} 준비됨",
  "update.unsupported": "데스크톱 앱에서만 업데이트할 수 있습니다",
};

export type UpdateMessageKey = keyof typeof ko;

const en: Record<UpdateMessageKey, string> = {
  "update.available": "Update available v{version}",
  "update.restartNow": "Restart now",
  "update.later": "Later",
  "update.notes": "Release notes",
  "update.hideNotes": "Hide notes",
  "update.close": "Close",
  "update.downloading": "Downloading v{version}… {percent}",
  "update.downloadFailed": "Couldn't download v{version}",
  "update.retry": "Retry",
  "update.installing": "Installing update…",
  "update.installFailed": "Update failed to install: {error}",
  "update.sessionsRunning": "{count} task(s) running — update when done",
  "update.sessionsHint": "Restarting now keeps tasks running in the background server, but the server update waits until they finish.",
  "update.whenDone": "Restart when done",
  "update.restartAnyway": "Restart now anyway",
  "update.cancel": "Cancel",
  "update.waiting": "Will restart automatically when {count} task(s) finish",
  "update.serverPending": "The server is still on the previous version — it updates when {count} running task(s) finish",
  "update.serverPendingIdle": "The server is still on the previous version — it updates shortly",
  "update.serverStale": "The server is running a different version than the app. Restart the app or check ~/Library/Logs/Sinawi/agent.log.",
  "update.settingsTitle": "Updates",
  "update.autoCheck": "Check for updates automatically",
  "update.autoCheckHint": "Checks at launch and every 6 hours and downloads in the background. Installs only when you restart.",
  "update.checkNow": "Check for updates",
  "update.checking": "Checking…",
  "update.upToDate": "You're up to date",
  "update.currentVersion": "Current version v{version}",
  "update.lastChecked": "Last checked {time}",
  "update.checkFailed": "Couldn't check for updates: {error}",
  "update.ready": "v{version} ready",
  "update.unsupported": "Updates are available in the desktop app only",
};

export const updateDictionaries = { ko, en } as const;

export function ut(key: UpdateMessageKey, params?: Record<string, string | number>): string {
  const text = updateDictionaries[getLang()][key] ?? ko[key];
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : text;
}

/** Re-renders the caller on a language switch and returns `ut`. */
export function useUpdateT(): typeof ut {
  useLang();
  return ut;
}
