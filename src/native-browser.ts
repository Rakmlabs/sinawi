/**
 * Native browser tabs (Tauri app on macOS): each tab is a real WKWebView that the Rust side places over
 * the panel's page slot. Pages load directly (any http/https site, no proxy) and never get Tauri IPC;
 * the app drives them through the `native_browser_*` commands and reads results from their return values.
 * Plain-browser dev mode (no Tauri) keeps the iframe + proxy path.
 */

export type NativeRect = { x: number; y: number; width: number; height: number };
/** A page dialog (alert/confirm/prompt) from WKUIDelegate. `accepted`/`by` are set once answered. */
export type DialogInfo = { kind: "alert" | "confirm" | "prompt" | string; message: string; defaultText?: string; origin: string; accepted?: boolean; text?: string; by?: string };
export type ArmedDialog = { accept: boolean; text: string };
export type NativeState = {
  exists: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; events?: string | null;
  /** The page is blocked on this dialog until it is answered. */
  dialog?: DialogInfo | null; lastDialog?: DialogInfo | null; armed?: ArmedDialog | null;
};
export type DownloadInfo = { id: string; tab?: string | null; url: string; filename?: string | null; path?: string | null; state: "starting" | "downloading" | "done" | "failed" | "canceled" | string; received: number; total: number; error?: string | null; startedAt: number; needsReview?: boolean };
/** Host events from Rust: a popup view became a tab, a popup closed itself, a download started, a dialog opened. */
export type HostEvent = { type: "popup"; tab: string; opener: string; url: string } | { type: "closed"; tab: string } | { type: "download"; tab?: string | null; id: string; url: string } | { type: "dialog"; tab: string };
export type NativeResult = { ok: boolean; result?: unknown; error?: string };
export type PageEvent = Record<string, unknown> & { type: string };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriWindow = { __TAURI_INTERNALS__?: { invoke: Invoke }; __orchestraNativeFocus?: string | null };

export const ENGINE_STORE = "orchestra.browser.engine";

function tauri(win: unknown = typeof window === "undefined" ? undefined : window): Invoke | undefined {
  return (win as TauriWindow | undefined)?.__TAURI_INTERNALS__?.invoke;
}

/** Native tabs need the desktop app on macOS. `orchestra.browser.engine = "iframe"` forces the old path. */
export function nativeBrowserAvailable(win: unknown = typeof window === "undefined" ? undefined : window, platform = typeof navigator === "undefined" ? "" : navigator.platform, engine?: string | null): boolean {
  if (!tauri(win)) return false;
  if (!/mac/i.test(platform)) return false;
  let choice = engine;
  if (choice === undefined) { try { choice = localStorage.getItem(ENGINE_STORE); } catch { choice = null; } }
  return choice !== "iframe";
}

/** On-screen slot → native view rect (CSS px of the app window), or undefined when too small to show. */
export function slotBounds(rect: { left: number; top: number; width: number; height: number }, viewportWidth: number, viewportHeight: number): NativeRect | undefined {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  const width = Math.round(right - left);
  const height = Math.round(bottom - top);
  if (!(width >= 2 && height >= 2)) return undefined;
  return { x: Math.round(left), y: Math.round(top), width, height };
}

/** Points that must be hit by the slot itself; anything else on top (menu, dialog, popover) covers the view.
 *  The inset clears the 12px resize corners of a floating browser window, which overlap the slot's corners. */
export function samplePoints(rect: NativeRect, inset = 16): [number, number][] {
  const xs = [rect.x + inset, rect.x + rect.width / 2, rect.x + rect.width - inset];
  const ys = [rect.y + inset, rect.y + rect.height / 2, rect.y + rect.height - inset];
  const points: [number, number][] = [];
  for (const y of ys) for (const x of xs) points.push([Math.round(x), Math.round(y)]);
  return points;
}

type HitNode = { contains?: (other: never) => boolean } | null;
/** True when some app element sits above the slot. Native views draw over the whole page, so they must hide. */
export function isCovered(rect: NativeRect, hit: (x: number, y: number) => unknown, slot: unknown): boolean {
  for (const [x, y] of samplePoints(rect)) {
    const node = hit(x, y) as HitNode;
    if (!node) continue;
    if (node === slot) continue;
    const container = slot as { contains?: (other: unknown) => boolean } | null;
    if (container?.contains?.(node)) continue;
    return true;
  }
  return false;
}

export function layoutKey(tab: string | undefined, rect: NativeRect | undefined, visible: boolean, zoom: number): string {
  return visible && tab && rect ? `${tab}:${rect.x},${rect.y},${rect.width},${rect.height}@${zoom.toFixed(3)}` : `hidden:${tab ?? ""}`;
}

/** JS body for callAsyncJavaScript: runs one automation action in the page and returns JSON text. */
export function agentCallBody(action: string, args: Record<string, unknown>): string {
  return `if (!window.__aoNative) return JSON.stringify({ ok: false, error: ${JSON.stringify(NO_SCRIPT)} });\n`
    + `return JSON.stringify(await window.__aoNative.run(${JSON.stringify(action)}, ${JSON.stringify(args ?? {})}));`;
}

/** JS body that hands a control message (pick, attach, emulate, agent-hide, ping) to the page script. */
export function sendBody(message: Record<string, unknown>): string {
  return `return window.__aoNative ? (window.__aoNative.send(${JSON.stringify({ source: "orchestra-parent", ...message })}), "ok") : null;`;
}

/** Longest full-page capture (CSS px); must match FULL_PAGE_MAX_HEIGHT in native_browser.rs. */
export const FULL_PAGE_MAX_HEIGHT = 16_000;

export function dialogOpenResult(dialog: DialogInfo): NativeResult {
  return { ok: true, result: { dialog, note: `페이지에 ${dialog.kind} 대화상자가 열려 있습니다 (${dialog.origin}): ${JSON.stringify(dialog.message)}. ao-browser dialog accept [문구] 또는 ao-browser dialog dismiss 로 답하세요.` } };
}

/** Snapshot header lines about dialogs (the page script cannot see WKUIDelegate dialogs). */
export function dialogLines(state: Pick<NativeState, "dialog" | "lastDialog" | "armed"> | undefined): string[] {
  if (!state) return [];
  const lines: string[] = [];
  if (state.dialog) lines.push(`[dialog 열림] ${state.dialog.kind} ${JSON.stringify(state.dialog.message)} (${state.dialog.origin}) — ao-browser dialog accept|dismiss 로 답하세요`);
  if (state.armed) lines.push(`(다음 대화상자: ${state.armed.accept ? "accept" : "dismiss"}${state.armed.text ? " " + JSON.stringify(state.armed.text) : ""})`);
  const last = state.lastDialog;
  if (last && !state.dialog) lines.push(`[dialog] ${last.kind} ${JSON.stringify(last.message)} ${last.accepted ? "accept" : "dismiss"}${last.text != null ? " " + JSON.stringify(last.text) : ""} (${last.by === "user" ? "사용자" : last.by === "agent" ? "AI" : "닫힘"})`);
  return lines;
}

/** Puts dialog lines right under the snapshot's title line. */
export function withDialogLines(snapshot: string, lines: string[]): string {
  if (!lines.length) return snapshot;
  const cut = snapshot.indexOf("\n");
  return cut < 0 ? `${snapshot}\n${lines.join("\n")}` : `${snapshot.slice(0, cut)}\n${lines.join("\n")}${snapshot.slice(cut)}`;
}

export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Progress 0–1, or undefined when the size is unknown. */
export function downloadProgress(item: Pick<DownloadInfo, "state" | "received" | "total">): number | undefined {
  if (item.state === "done") return 1;
  return item.total > 0 ? Math.min(1, Math.max(0, item.received / item.total)) : undefined;
}

export function downloadsText(list: DownloadInfo[]): string {
  if (!list.length) return "다운로드 없음";
  return list.map((item, index) => {
    const progress = downloadProgress(item);
    const size = item.total > 0 ? `${formatBytes(item.received)} / ${formatBytes(item.total)}` : formatBytes(item.received);
    const pct = progress != null && item.state !== "done" ? ` ${Math.round(progress * 100)}%` : "";
    return `${index + 1}. [${item.state}${pct}] ${item.filename ?? "(이름 정하는 중)"} — ${size}${item.path ? ` → ${item.path}` : ""}${item.error ? ` (${item.error})` : ""}\n   ${item.url}`;
  }).join("\n");
}

export function parseHostEvents(raw: string | null | undefined): HostEvent[] {
  return parseEvents(raw).filter((event) => typeof (event as { tab?: unknown }).tab === "string" || event.type === "download") as unknown as HostEvent[];
}

export const NO_SCRIPT = "페이지 자동화 스크립트가 없습니다 (로딩 중이거나 http/https 페이지가 아님). 잠시 뒤 다시 시도하세요.";
export const NAVIGATED_NOTE = "페이지가 이동했습니다. snapshot 을 다시 찍으세요.";

/** Shapes what native_browser_call returned (JSON text, null, or a thrown error string). */
export function parseNativeResult(raw: unknown): NativeResult {
  if (raw == null) return { ok: false, error: NO_SCRIPT };
  if (typeof raw !== "string") return { ok: false, error: "알 수 없는 응답 형식입니다." };
  try {
    const value = JSON.parse(raw) as NativeResult;
    if (!value || typeof value !== "object") return { ok: false, error: "알 수 없는 응답 형식입니다." };
    return { ok: Boolean(value.ok), result: value.result, error: value.ok ? undefined : String(value.error ?? "실패") };
  } catch { return { ok: false, error: "응답을 해석하지 못했습니다." }; }
}

/** A call that failed because the document went away (link click, form submit) is a navigation, not an error. */
export function navigationOutcome(error: string, before: { url?: string }, after: { url?: string; loading?: boolean }): NativeResult | undefined {
  if (after.loading || (before.url && after.url && before.url !== after.url)) return { ok: true, result: { navigated: true, from: before.url, url: after.url, note: NAVIGATED_NOTE } };
  if (/WKError (3|12)\b/.test(error)) return { ok: true, result: { navigated: true, from: before.url, note: NAVIGATED_NOTE } };
  return undefined;
}

export function parseEvents(raw: string | null | undefined): PageEvent[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((item): item is PageEvent => Boolean(item) && typeof item === "object" && typeof item.type === "string") : [];
  } catch { return []; }
}

/** Element capture rect (page coordinates) → viewport rect for a native snapshot crop. */
export function captureRect(rect: { x: number; y: number; width: number; height: number }, viewport?: { scrollX: number; scrollY: number }): NativeRect {
  return { x: rect.x - (viewport?.scrollX ?? 0), y: rect.y - (viewport?.scrollY ?? 0), width: rect.width, height: rect.height };
}

/** Which tab (if any) the Rust menu handler reported as keyboard-focused. */
export function nativeFocusedTab(win: unknown = typeof window === "undefined" ? undefined : window): string | undefined {
  const value = (win as TauriWindow | undefined)?.__orchestraNativeFocus;
  return typeof value === "string" && value ? value : undefined;
}

let scriptCache: Promise<{ script: string; pageScript: string }> | undefined;
/** Automation script (isolated "sinawi" world) and its page-world bridge. */
function pageScripts(): Promise<{ script: string; pageScript: string }> {
  const text = (path: string) => fetch(path).then((res) => { if (!res.ok) throw new Error(`native script ${res.status}`); return res.text(); });
  scriptCache ??= Promise.all([text("/api/preview/native-script"), text("/api/preview/native-page-script")]).then(([script, pageScript]) => ({ script, pageScript }));
  scriptCache.catch(() => { scriptCache = undefined; });
  return scriptCache;
}

function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const invoke = tauri();
  if (!invoke) return Promise.reject(new Error("앱(데스크톱)에서만 쓸 수 있습니다."));
  return invoke(cmd, args) as Promise<T>;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const nativeBrowser = {
  async open(tab: string, url: string, userAgent?: string) { const scripts = await pageScripts(); await call("native_browser_open", { tab, url, script: scripts.script, pageScript: scripts.pageScript, userAgent: userAgent || null }); },
  /** `behind`: laid out under the app's own webview (off screen, but painting and scriptable). */
  layout: (tab: string, rect: NativeRect | undefined, visible: boolean, zoom = 1, behind = false) => call<boolean>("native_browser_layout", { tab, rect: rect ?? null, visible, zoom, behind }),
  close: (tab: string) => call<void>("native_browser_close", { tab }),
  history: (tab: string, op: "back" | "forward" | "reload" | "stop" | "focus") => call<boolean>("native_browser_history", { tab, op }),
  emulate: (tab: string, userAgent: string) => call<boolean>("native_browser_emulate", { tab, userAgent: userAgent || null }),
  devtools: (tab: string) => call<void>("native_browser_devtools", { tab }),
  poll: (tab: string, drain = false) => call<NativeState>("native_browser_poll", { tab, drain }),
  screenshot: (tab: string, rect?: NativeRect, full = false) => call<string>("native_browser_screenshot", { tab, rect: rect ?? null, full }),
  /** status | arm (answer the next one) | answer (the open one) | clear */
  dialog: (tab: string, op: "status" | "arm" | "answer" | "clear", accept = true, text?: string, by: "user" | "agent" = "agent") => call<NativeState>("native_browser_dialog", { tab, op, accept, text: text ?? null, by }),
  events: (tabs: string[]) => call<string>("native_browser_events", { tabs }).then(parseHostEvents),
  downloads: (cancel?: string) => call<DownloadInfo[]>("native_browser_downloads", { cancel: cancel ?? null }),
  /** Real (isTrusted) input: click at a top-level CSS-px point, insert text, or a named key. */
  input: (tab: string, kind: "click" | "text" | "key", point: { x?: number; y?: number; text?: string }) => call<boolean>("native_browser_input", { tab, kind, x: point.x ?? null, y: point.y ?? null, text: point.text ?? null }),
  send: (tab: string, message: Record<string, unknown>) => call<string | null>("native_browser_call", { tab, body: sendBody(message), timeoutMs: 3000 }).catch(() => null),
  /** One automation action; navigation mid-call resolves as `navigated`. */
  async run(tab: string, action: string, args: Record<string, unknown>, timeoutMs: number): Promise<NativeResult> {
    let before: NativeState | undefined;
    try { before = await nativeBrowser.poll(tab); } catch { /* checked below */ }
    if (before && !before.exists) return { ok: false, error: "이 탭의 브라우저 화면이 없습니다. ao-browser goto 로 다시 여세요." };
    // A page blocked on alert/confirm/prompt runs no JS: report the dialog instead of timing out.
    if (before?.dialog) return dialogOpenResult(before.dialog);
    let settled = false;
    const work = (async (): Promise<NativeResult> => {
      try {
        const value = parseNativeResult(await call<string | null>("native_browser_call", { tab, body: agentCallBody(action, args), timeoutMs }));
        const snapshot = (value.result as { snapshot?: unknown } | undefined)?.snapshot;
        if (value.ok && typeof snapshot === "string") {
          const state = await nativeBrowser.poll(tab).catch(() => undefined);
          (value.result as { snapshot: string }).snapshot = withDialogLines(snapshot, dialogLines(state));
        }
        return value;
      } catch (error) {
        const message = errorText(error);
        const after = await nativeBrowser.poll(tab).catch(() => undefined);
        if (after?.dialog) return dialogOpenResult(after.dialog);
        return (after && navigationOutcome(message, before ?? {}, after)) ?? { ok: false, error: message };
      } finally { settled = true; }
    })();
    const watch = new Promise<NativeResult>((resolve) => {
      const tick = async () => {
        if (settled) return;
        const state = await nativeBrowser.poll(tab).catch(() => undefined);
        if (settled) return;
        if (state?.dialog) { resolve(dialogOpenResult(state.dialog)); return; }
        setTimeout(() => void tick(), 300);
      };
      setTimeout(() => void tick(), 300);
    });
    return Promise.race([work, watch]);
  },
};
