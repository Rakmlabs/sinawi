import { terminalOwnsKeyboardEvent } from "./terminal-events";
import { browserOwnsFocus } from "./browser-shortcuts";

export function reloadApp(target: Window = window) {
  target.location.reload();
}

export function installAppReload(target: Window) {
  if (!("__TAURI_INTERNALS__" in target)) return () => {};
  const handle = (event: KeyboardEvent) => {
    if (terminalOwnsKeyboardEvent(event)) return;
    // The in-app browser reloads its own tab instead (BrowserPanel).
    if (typeof document !== "undefined" && browserOwnsFocus(target.document)) return;
    if (!event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing || event.key.toLowerCase() !== "r") return;
    event.preventDefault();
    reloadApp(target);
  };
  // Capture also catches the shortcut while a composer or popover has focus.
  target.addEventListener("keydown", handle, { capture: true });
  return () => target.removeEventListener("keydown", handle, { capture: true });
}
