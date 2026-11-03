export function savedBoolean(value: string | null, fallback = false): boolean {
  return value === "true" ? true : value === "false" ? false : fallback;
}
export function savedAutoSwitch(value: string | null): boolean {
  return savedBoolean(value, true);
}
export function savedMode(value: string | null): "auto" | "manual" {
  return value === "manual" ? "manual" : "auto";
}
export function readPreference(key: string): string | null {
  try { return localStorage.getItem(`orchestra.${key}`); } catch { return null; }
}
export function writePreference(key: string, value: string) {
  try { localStorage.setItem(`orchestra.${key}`, value); } catch { /* Preferences are optional. */ }
}

/** Settings › General: run multi-step requests to the end and split big ones into chats (default on). */
export const AUTO_RUN_KEY = "autoRun";
export function autoRunEnabled(): boolean {
  return savedBoolean(readPreference(AUTO_RUN_KEY), true);
}
