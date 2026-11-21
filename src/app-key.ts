// The app window's key (server/app-key.ts): every request to the app's own /api carries it, and the
// WebSockets send it as a subprotocol. In the app (installed or `npm run app:dev`) it comes from the
// Sinawi binary (`app_key` command), which gets it from the server's checked key socket. In a browser
// on `npm run dev` it comes from the link dev.mjs prints (`#sinawi-app-key=…`): the fragment never
// reaches a server, the page keeps it for this tab only and takes it out of the address bar. A page
// opened any other way has none, so the user's own decisions (approvals, full access, the MCP token)
// stay in the app.

const HEADER = "x-sinawi-app";
const PROTOCOL = "sinawi-app.";
/** Set by the server on a 403 it gave for a missing or stale key. */
const REQUIRED_HEADER = "x-sinawi-app-key";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type KeyWindow = {
  __TAURI_INTERNALS__?: { invoke: Invoke };
  location?: Pick<Location, "hash" | "pathname" | "search">;
  history?: Pick<History, "replaceState">;
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
};
const LINK = /(?:^#|&)sinawi-app-key=([\w-]{32,200})/u;
const STORED = "sinawi-app-key";

let key: string | undefined;
let loading: Promise<string | undefined> | undefined;
let missing = false;
const listeners = new Set<() => void>();

/**
 * Whether the last attempt left this window without a key: the server then refuses its live feed and
 * the user's decisions, and the sidebar says so instead of just "reconnecting".
 */
export const appKeyStatus = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  missing: (): boolean => missing,
};

function settle(value: string | undefined): string | undefined {
  key = value;
  if (missing !== !value) { missing = !value; for (const listener of listeners) listener(); }
  return value;
}

/** The dev link's key: kept for this tab (a reload has no fragment any more) and taken out of the URL. */
function fromLink(win: KeyWindow): string | undefined {
  const found = win.location && LINK.exec(win.location.hash)?.[1];
  if (found) {
    try { win.sessionStorage?.setItem(STORED, found); } catch { /* storage blocked: this load only */ }
    try { win.history?.replaceState(null, "", `${win.location!.pathname}${win.location!.search}`); } catch { /* keep going */ }
    return found;
  }
  try { return win.sessionStorage?.getItem(STORED) || undefined; } catch { return undefined; }
}

/** The key, asking the app binary again when `refresh` (the server restarted with a new one). */
export function loadAppKey(refresh = false, win: KeyWindow = typeof window === "undefined" ? {} : window): Promise<string | undefined> {
  if (loading && !refresh) return loading;
  loading = (async () => {
    const invoke = win.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return settle(fromLink(win));
    try {
      const value = await invoke("app_key");
      return settle(typeof value === "string" && value ? value : undefined);
    } catch { return settle(undefined); }
  })();
  return loading;
}

/** Subprotocols for a WebSocket to the app server. */
export function appKeyProtocols(): string[] {
  return key ? [`${PROTOCOL}${key}`] : [];
}

function sameOriginApi(input: RequestInfo | URL, origin: string): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    return url.origin === origin && url.pathname.startsWith("/api/");
  } catch { return false; }
}

/** Wraps `fetch` so requests to this app's /api carry the key; retries once after a stale-key 403. */
export function installAppKeyFetch(win: Window & KeyWindow = window): void {
  const original = win.fetch.bind(win);
  const send = async (input: RequestInfo | URL, init: RequestInit | undefined, value: string | undefined) => {
    if (!value) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(HEADER, value);
    return original(input instanceof Request ? new Request(input, { headers }) : input, { ...init, headers });
  };
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!sameOriginApi(input, win.location.origin)) return original(input, init);
    const first = await send(input, init, await loadAppKey(false, win));
    if (first.status !== 403 || !first.headers.get(REQUIRED_HEADER) || !win.__TAURI_INTERNALS__) return first;
    const fresh = await loadAppKey(true, win);
    return fresh ? send(input, init, fresh) : first;
  };
}
