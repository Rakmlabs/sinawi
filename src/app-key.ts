// The app window's key (server/app-key.ts): every request to the app's own /api carries it, and the
// WebSockets send it as a subprotocol. It comes from the page Vite served (`npm run dev`) or, in the
// installed app, from the Sinawi binary (`app_key` command). A page opened in an ordinary browser
// has none, so the user's own decisions (approvals, full access, the MCP token) stay in the app.

const HEADER = "x-sinawi-app";
const PROTOCOL = "sinawi-app.";
/** Set by the server on a 403 it gave for a missing or stale key. */
const REQUIRED_HEADER = "x-sinawi-app-key";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type KeyWindow = { __TAURI_INTERNALS__?: { invoke: Invoke } };

let key: string | undefined;
let loading: Promise<string | undefined> | undefined;

function fromPage(doc: Pick<Document, "querySelector"> | undefined): string | undefined {
  const value = doc?.querySelector<HTMLMetaElement>('meta[name="sinawi-app-key"]')?.content;
  return value || undefined;
}

/** The key, asking the app binary again when `refresh` (the server restarted with a new one). */
export function loadAppKey(refresh = false, win: KeyWindow & { document?: Document } = typeof window === "undefined" ? {} : window): Promise<string | undefined> {
  if (loading && !refresh) return loading;
  loading = (async () => {
    const page = fromPage(win.document);
    if (page) return (key = page);
    const invoke = win.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return (key = undefined);
    try {
      const value = await invoke("app_key");
      key = typeof value === "string" && value ? value : undefined;
    } catch { key = undefined; }
    return key;
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
