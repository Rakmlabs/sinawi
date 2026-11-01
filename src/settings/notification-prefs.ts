// Which notification types pop up as in-app toasts. Every notification still lands in the
// notification center; this only decides the toast. Defaults match the previous behaviour
// (auth, error and permission problems pop up; quota, run-finished and info stay quiet).
import { readPreference, writePreference } from "../preferences";
import type { NotificationType } from "../../server/notification-types";

export const NOTIFICATION_TYPES: NotificationType[] = ["auth", "quota", "permission", "run-finished", "error", "info"];
export const DEFAULT_TOAST_TYPES: NotificationType[] = ["auth", "error", "permission"];
const KEY = "toastTypes";
export const TOAST_PREFS_EVENT = "orchestra:toast-prefs";

export function parseToastTypes(raw: string | null): Set<NotificationType> {
  if (raw === null) return new Set(DEFAULT_TOAST_TYPES);
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return new Set(value.filter((item): item is NotificationType => NOTIFICATION_TYPES.includes(item)));
  } catch { /* fall through */ }
  return new Set(DEFAULT_TOAST_TYPES);
}

export const toastTypes = () => parseToastTypes(readPreference(KEY));
export const toastEnabled = (type: NotificationType) => toastTypes().has(type);

export function setToastType(type: NotificationType, enabled: boolean) {
  const next = toastTypes();
  if (enabled) next.add(type); else next.delete(type);
  writePreference(KEY, JSON.stringify(NOTIFICATION_TYPES.filter((item) => next.has(item))));
  window.dispatchEvent(new Event(TOAST_PREFS_EVENT));
}

export function resetToastTypes() {
  writePreference(KEY, JSON.stringify(DEFAULT_TOAST_TYPES));
  window.dispatchEvent(new Event(TOAST_PREFS_EVENT));
}
