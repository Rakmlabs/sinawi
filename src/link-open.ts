/**
 * Opening links from the chat. The app is a WKWebView: `target="_blank"` and plain navigation do
 * nothing (or replace the app), so every link goes through here — the in-app browser or the
 * system's default browser.
 */
export const OPEN_URL_EVENT = "orchestra:open-url";
/** A user action failed somewhere without its own error UI: the workspace shows it as a notification. */
export const APP_ERROR_EVENT = "orchestra:app-error";

export type LinkTarget = "web" | "system" | "none";

/** http(s) opens in either browser; mailto/tel and friends go to the system; anything else stays put. */
export function linkTarget(href: string): LinkTarget {
  if (/^https?:\/\/[^\s]/iu.test(href)) return "web";
  if (/^(?:mailto|tel|sms|facetime):/iu.test(href)) return "system";
  return "none";
}

let held: string | undefined;
/** A URL waiting for the browser window that is about to open. */
export function holdUrl(url: string) { held = url; }
export function takeHeldUrl(): string | undefined { const url = held; held = undefined; return url; }

export function openInApp(url: string) {
  window.dispatchEvent(new CustomEvent(OPEN_URL_EVENT, { detail: { url } }));
}

export async function openExternal(url: string): Promise<void> {
  const res = await fetch("/api/open-external", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
}
