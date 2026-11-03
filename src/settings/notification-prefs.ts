// Which notification types pop up as in-app toasts. Every notification still lands in the
// notification center; this only decides the toast. Defaults match the previous behaviour
// (auth, error and permission problems pop up; quota, run-finished and info stay quiet).
import { readPreference, writePreference } from "../preferences";
import type { NotificationType } from "../../server/notification-types";

export const NOTIFICATION_TYPES: NotificationType[] = ["auth", "quota", "permission", "run-finished", "lead", "error", "info"];
export const DEFAULT_TOAST_TYPES: NotificationType[] = ["auth", "error", "permission", "lead"];
const KEY = "toastTypes";
// Choices saved before a type existed leave it at its default (on for "lead": a lead's report or answer).
const KNOWN_KEY = "toastTypesKnown";
export const TOAST_PREFS_EVENT = "orchestra:toast-prefs";

export function parseToastTypes(raw: string | null, knownRaw: string | null = null): Set<NotificationType> {
  if (raw === null) return new Set(DEFAULT_TOAST_TYPES);
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) {
      const chosen = new Set(value.filter((item): item is NotificationType => NOTIFICATION_TYPES.includes(item)));
      const known = knownRaw === null ? ["auth", "quota", "permission", "run-finished", "error", "info"] : JSON.parse(knownRaw) as string[];
      for (const type of DEFAULT_TOAST_TYPES) if (!known.includes(type)) chosen.add(type);
      return chosen;
    }
  } catch { /* fall through */ }
  return new Set(DEFAULT_TOAST_TYPES);
}

export const toastTypes = () => parseToastTypes(readPreference(KEY), readPreference(KNOWN_KEY));
export const toastEnabled = (type: NotificationType) => toastTypes().has(type);

export function setToastType(type: NotificationType, enabled: boolean) {
  const next = toastTypes();
  if (enabled) next.add(type); else next.delete(type);
  writePreference(KEY, JSON.stringify(NOTIFICATION_TYPES.filter((item) => next.has(item))));
  writePreference(KNOWN_KEY, JSON.stringify(NOTIFICATION_TYPES));
  window.dispatchEvent(new Event(TOAST_PREFS_EVENT));
}

export function resetToastTypes() {
  writePreference(KEY, JSON.stringify(DEFAULT_TOAST_TYPES));
  window.dispatchEvent(new Event(TOAST_PREFS_EVENT));
}
