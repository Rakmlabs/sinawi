/** The installed app must always run from its local server; tauri://localhost is only the boot splash. */
export const APP_SERVER_URL = "http://127.0.0.1:3001/";

/** True when the app shell is showing without its server (e.g. the WebView was walked back to tauri://localhost). */
export function isStrandedShell(href: string): boolean {
  try { const { protocol } = new URL(href); return protocol !== "http:" && protocol !== "https:"; } catch { return true; }
}

/** Return to the app server as soon as it answers (no history entry, so "back" can't strand us again). */
export function returnToAppServer(win: Pick<Window, "location" | "setTimeout"> = window, attempt = 0) {
  void fetch(APP_SERVER_URL + "api/workspaces", { mode: "no-cors", cache: "no-store" })
    .then(() => win.location.replace(APP_SERVER_URL))
    .catch(() => { if (attempt < 200) win.setTimeout(() => returnToAppServer(win, attempt + 1), 300); });
}

/** Mouse back/forward buttons must never walk the app window's history. */
export function blockHistoryButtons(target: Pick<Window, "addEventListener"> = window) {
  const block = (event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type === "mouseup") window.dispatchEvent(new CustomEvent("orchestra:browser-nav", { detail: event.button === 3 ? -1 : 1 }));
  };
  for (const type of ["mousedown", "mouseup", "auxclick"] as const) target.addEventListener(type, block as EventListener, true);
}
