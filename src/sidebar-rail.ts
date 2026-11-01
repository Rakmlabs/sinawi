import { t } from "./i18n";

/** Below this width the sidebar overlays the chat instead of taking a column. */
export const SIDEBAR_OVERLAY_QUERY = "(max-width: 899px)";

/**
 * Where the sidebar lives and whether it is showing.
 * Docked (wide window, no browser focus): a column that follows the persisted `collapsed` preference.
 * Overlay (narrow window or a browser window snapped/maximised): floats over the content and starts
 * closed, so neither a narrow window nor the browser loses space to it; `overlayOpen` is transient.
 */
export function sidebarLayout(state: { collapsed: boolean; narrow: boolean; focusMode: boolean; overlayOpen: boolean }): { overlay: boolean; open: boolean } {
  const overlay = state.narrow || state.focusMode;
  return { overlay, open: overlay ? state.overlayOpen : !state.collapsed };
}

/** ⌘B / ⌘\ on macOS, Ctrl+B / Ctrl+\ elsewhere. */
export function sidebarShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && (event.key.toLowerCase() === "b" || event.key === "\\");
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function railToggleLabel(collapsed: boolean): string {
  return collapsed ? t("sidebar.expand") : t("sidebar.collapse");
}
