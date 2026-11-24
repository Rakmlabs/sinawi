import { WebSocket } from "ws";

/** A browser window the user moved out of the app window: its own OS window, for one workspace. */
export type BrowserWindowInfo = { id: string; workspaceId: string };

const TOKEN = /^[\w-]{1,64}$/u;

/** `/ws/browser?workspace=<id>&id=<window id>`: the socket of a browser window outside the app window. */
export function parseBrowserWindowUrl(raw: string | undefined): BrowserWindowInfo | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw, "http://127.0.0.1"); } catch { return undefined; }
  if (url.pathname !== "/ws/browser") return undefined;
  const workspaceId = url.searchParams.get("workspace") ?? "";
  const id = url.searchParams.get("id") ?? "";
  return TOKEN.test(workspaceId) && TOKEN.test(id) ? { id, workspaceId } : undefined;
}

/** What such a window may tell the app window: it got the user's attention, it goes back into the app, or picked elements for the chat. */
export type BrowserWindowMessage = { type: "focus" } | { type: "dock" } | { type: "attach"; items: unknown[] };

export function parseBrowserWindowMessage(data: unknown): BrowserWindowMessage | undefined {
  let value: unknown;
  try { value = JSON.parse(typeof data === "string" ? data : String(data)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as { type?: unknown; items?: unknown };
  if (message.type === "focus" || message.type === "dock") return { type: message.type };
  // Picked elements for the composer: only items shaped like one (an id, a kind and a label), so a broken frame cannot break the chat.
  if (message.type === "attach" && Array.isArray(message.items) && message.items.length <= 50) {
    const items = message.items.filter((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
      && ["id", "kind", "label"].every((key) => typeof (item as Record<string, unknown>)[key] === "string"));
    return items.length ? { type: "attach", items } : undefined;
  }
  return undefined;
}

/** How long a workspace's commands wait for its window that just dropped (a reload, a reconnect) before the app window gets them. */
export const WINDOW_GRACE_MS = 4_000;

/**
 * The browser windows outside the app window. A workspace that has one gets its agents' browser
 * commands there, and only there: the app window is not asked, so it never opens a second browser
 * for the same command. With several, the one the user used last answers (one command, one page).
 */
export class BrowserWindows {
  private windows = new Map<WebSocket, BrowserWindowInfo & { seen: number }>();
  /** Workspaces whose last window just dropped: their commands (by id) wait here for it to come back. */
  private gone = new Map<string, { timer: ReturnType<typeof setTimeout>; held: Map<string, string> }>();
  private tick = 0;
  /** `fallback`: gets a held command when the window did not come back in `graceMs` (the app window runs it). */
  constructor(private onChange: (list: BrowserWindowInfo[]) => void = () => undefined, private fallback: (message: string) => void = () => undefined, private graceMs = WINDOW_GRACE_MS) {}

  add(client: WebSocket, info: BrowserWindowInfo): void {
    this.windows.set(client, { ...info, seen: ++this.tick });
    const waiting = this.gone.get(info.workspaceId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.gone.delete(info.workspaceId);
      for (const message of waiting.held.values()) if (client.readyState === WebSocket.OPEN) client.send(message);
    }
    this.onChange(this.list());
  }

  remove(client: WebSocket): void {
    const entry = this.windows.get(client);
    if (!entry) return;
    this.windows.delete(client);
    // The workspace's only window: it may be back in a moment (a reload, a reconnect), so its commands
    // wait instead of making the app window open a second browser for the same work.
    if (!this.target(entry.workspaceId)) {
      const workspaceId = entry.workspaceId;
      const held = this.gone.get(workspaceId)?.held ?? new Map<string, string>();
      clearTimeout(this.gone.get(workspaceId)?.timer);
      const timer = setTimeout(() => {
        this.gone.delete(workspaceId);
        for (const message of held.values()) this.fallback(message);
      }, this.graceMs);
      timer.unref?.();
      this.gone.set(workspaceId, { timer, held });
    }
    this.onChange(this.list());
  }

  /** Keeps a command for a workspace whose window just dropped. False when nothing is waited for: the app window runs it. */
  hold(workspaceId: string | undefined, id: string, message: string): boolean {
    const waiting = workspaceId ? this.gone.get(workspaceId) : undefined;
    if (!waiting) return false;
    if (waiting.held.has(id) || waiting.held.size < 50) waiting.held.set(id, message);
    return true;
  }

  /** Server shutdown: nothing waits any more. */
  dispose(): void {
    for (const waiting of this.gone.values()) clearTimeout(waiting.timer);
    this.gone.clear();
  }

  /** The user clicked into this window: it is the one its workspace's agents use. */
  touch(client: WebSocket): void {
    const entry = this.windows.get(client);
    if (entry) entry.seen = ++this.tick;
  }

  info(client: WebSocket): BrowserWindowInfo | undefined {
    const entry = this.windows.get(client);
    return entry ? { id: entry.id, workspaceId: entry.workspaceId } : undefined;
  }

  list(): BrowserWindowInfo[] {
    return [...this.windows].filter(([client]) => client.readyState === WebSocket.OPEN).map(([, entry]) => ({ id: entry.id, workspaceId: entry.workspaceId }));
  }

  /** The window that runs a command of `workspaceId`'s agents, if that workspace has one outside the app. */
  target(workspaceId: string | undefined): WebSocket | undefined {
    if (!workspaceId) return undefined;
    let best: { client: WebSocket; seen: number } | undefined;
    for (const [client, entry] of this.windows) {
      if (entry.workspaceId !== workspaceId || client.readyState !== WebSocket.OPEN) continue;
      if (!best || entry.seen > best.seen) best = { client, seen: entry.seen };
    }
    return best?.client;
  }
}
