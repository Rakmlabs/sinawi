export type AgentCommand = { type: "browser-command"; id: string; action: string; args: Record<string, unknown>; workspaceId?: string; owner?: string };

/**
 * The tab an agent command runs in. Each owner (a session's lead or one of its workers) keeps its
 * own tab, so two sessions using the browser at once never drive the same page. A newcomer takes
 * the tab on screen if nobody owns it (the page the user opened for it), else an empty unowned
 * tab, else a new one. Commands without an owner use the tab on screen, as before.
 */
export function agentTabFor<T extends { id: string; url: string; owner?: string }>(tabs: readonly T[], activeId: string, owner: string | undefined, current?: string): { id: string; claim?: boolean } | { create: true } | undefined {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!owner) return active ? { id: active.id } : undefined;
  if (current && tabs.some((tab) => tab.id === current)) return { id: current };
  const mine = tabs.find((tab) => tab.owner === owner);
  if (mine) return { id: mine.id };
  if (active && !active.owner) return { id: active.id, claim: true };
  const free = tabs.find((tab) => !tab.owner && !tab.url);
  return free ? { id: free.id, claim: true } : { create: true };
}

let browserWorkspace: string | undefined;
/** The workspace on screen: its browser windows are the only ones mounted. */
export function setBrowserWorkspace(id: string) { browserWorkspace = id; }
export const browserWorkspaceId = () => browserWorkspace;
/** An agent's command runs only in its own workspace's browser (company pages stay in company). */
export function commandForThisWorkspace(command: { workspaceId?: string }): boolean {
  return !command.workspaceId || !browserWorkspace || command.workspaceId === browserWorkspace;
}

export const OWN_APP_ERROR = "Sinawi 자체 주소는 열 수 없습니다. localhost 개발 서버 페이지를 여세요.";

/** App server (default 3001) opened as a tab nests the shell; picker never answers. */
export function isOwnAppUrl(raw: string | undefined, appPort = 3001): boolean {
  const value = String(raw ?? "").trim();
  if (/^\d{2,5}$/.test(value)) return Number(value) === appPort;
  try { const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`); return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") && Number(url.port || 80) === appPort; } catch { return false; }
}

/** Why the active tab cannot take AI commands, or undefined when it can. */
export function agentCommandError(tab: { frameUrl?: string; proxied?: boolean; native?: boolean; url?: string } | undefined): string | undefined {
  if (!tab?.frameUrl) return "열린 페이지가 없습니다. 먼저 `ao-browser goto <주소 또는 포트>` 로 여세요.";
  if (isOwnAppUrl(tab.url) || isOwnAppUrl(tab.frameUrl)) return OWN_APP_ERROR;
  // Native (desktop app) tabs control any http/https page; the iframe fallback only proxied localhost.
  if (tab.native) return undefined;
  if (!tab.proxied) return `외부 사이트(${tab.url ?? "https"})는 AI가 조작할 수 없습니다. localhost 개발 서버 페이지만 조작할 수 있어요.`;
  return undefined;
}

/** `status` before anything is open is a normal answer, not a failure (failures count toward stall detection). */
export function idleStatus(action: string, tab: { frameUrl?: string } | undefined) {
  if (action !== "status" || tab?.frameUrl) return undefined;
  return { ok: true as const, result: { open: false, text: "열린 페이지가 없습니다. `ao-browser goto <주소 또는 포트>` 로 여세요." } };
}

/** goto, or a new tab, aimed at the app server itself. */
export function commandTargetsOwnApp(action: string, args: Record<string, unknown>, appPort = 3001): boolean {
  if (action === "goto") return isOwnAppUrl(String(args.url ?? ""), appPort);
  if (action === "tab" && String(args.op ?? "list") === "new") return isOwnAppUrl(String(args.url ?? ""), appPort);
  return false;
}

/** Safe to broadcast again. click and goto must run once. */
export function replayCommand(action: string): boolean {
  return action === "viewport" || action === "status" || action === "tabs";
}

const claimed = new Set<string>();
const claimedOrder: string[] = [];

/** One parked command per workspace ("" for a command that names none: the workspace on screen). */
const held = new Map<string, AgentCommand>();

/** Park a command until a browser panel mounts.
 *  WKWebView's default inactive policy suspends the view when the window is not frontmost,
 *  so setTimeout and requestAnimationFrame do not run and must not carry the handoff. */
export function holdCommand(command: AgentCommand): void {
  if (command.id) held.set(command.workspaceId ?? "", command);
}

/**
 * The panel that just mounted takes the parked command of its workspace (and, on screen, one that
 * names no workspace). A panel that is not the target puts it back.
 */
export function takeHeldCommand(workspaceId?: string, onScreen = true): AgentCommand | undefined {
  for (const key of [workspaceId ?? "", ...(onScreen && workspaceId ? [""] : [])]) {
    const command = held.get(key);
    if (command) { held.delete(key); return command; }
  }
  return undefined;
}

/** First delivery of an id wins. A 400ms resend must not start the command again. */
export function claimCommand(id: string): boolean {
  if (!id || claimed.has(id)) return false;
  claimed.add(id);
  claimedOrder.push(id);
  if (claimedOrder.length > 300) {
    const oldest = claimedOrder.shift();
    if (oldest) claimed.delete(oldest);
  }
  return true;
}

/** Agents should see the real dev-server URL, not the internal proxy port. */
export function withTargetUrls<T extends { result?: unknown }>(value: T, proxyOrigin?: string, targetOrigin?: string): T {
  if (!proxyOrigin || !targetOrigin || !value.result || typeof value.result !== "object") return value;
  const swap = (text: string) => text.split(proxyOrigin).join(targetOrigin);
  const out: Record<string, unknown> = { ...(value.result as Record<string, unknown>) };
  for (const key of ["url", "from", "snapshot", "text", "href"]) if (typeof out[key] === "string") out[key] = swap(out[key] as string);
  return { ...value, result: out };
}
