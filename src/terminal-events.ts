export const TERMINAL_OPEN_EVENT = "orchestra:terminal-open";
export const TERMINAL_TOGGLE_EVENT = "orchestra:terminal-toggle";
export const TERMINAL_NOTICE_EVENT = "orchestra:terminal-notice";
export const TERMINAL_AUTH_REFRESH_EVENT = "orchestra:auth-refresh";

export type OpenTerminalOptions = {
  cwd?: string;
  command?: string;
};

export type TerminalNotice = {
  type: "error" | "info";
  title: string;
  body: string;
  key?: string;
};

type EventDestination = Pick<EventTarget, "dispatchEvent">;

function detailEvent<T>(type: string, detail: T): Event {
  if (typeof CustomEvent !== "undefined") return new CustomEvent(type, { detail });
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

export function openTerminal(options: OpenTerminalOptions = {}, target?: EventDestination): void {
  const destination = target ?? (typeof window !== "undefined" ? window : undefined);
  destination?.dispatchEvent(detailEvent(TERMINAL_OPEN_EVENT, options));
}

export function toggleTerminal(target?: EventDestination): void {
  const destination = target ?? (typeof window !== "undefined" ? window : undefined);
  destination?.dispatchEvent(new Event(TERMINAL_TOGGLE_EVENT));
}

export function notifyTerminal(notice: TerminalNotice, target?: EventDestination): void {
  const destination = target ?? (typeof window !== "undefined" ? window : undefined);
  destination?.dispatchEvent(detailEvent(TERMINAL_NOTICE_EVENT, notice));
}

export function requestAuthRefresh(target?: EventDestination): void {
  const destination = target ?? (typeof window !== "undefined" ? window : undefined);
  destination?.dispatchEvent(new Event(TERMINAL_AUTH_REFRESH_EVENT));
}

export function terminalOwnsKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  const target = event.target;
  return Boolean(target && typeof (target as Element).closest === "function" && (target as Element).closest(".terminal-panel"));
}

export function terminalShortcut(event: Pick<KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing"
> & { type?: string }): "toggle" | "new-tab" | undefined {
  // Only a fresh keydown counts. xterm's custom key handler also receives keyup/keypress,
  // and the keyup of Ctrl+` used to toggle the panel closed again on release.
  if (event.type !== undefined && event.type !== "keydown") return;
  if (event.repeat || event.isComposing || !event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code !== "Backquote" && event.key !== "`") return;
  return event.shiftKey ? "new-tab" : "toggle";
}

export function installTerminalShortcuts(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  actions: { toggle: () => void; newTab: () => void },
): () => void {
  const handle = (raw: Event) => {
    const event = raw as KeyboardEvent;
    consumeTerminalShortcut(event, actions);
  };
  target.addEventListener("keydown", handle);
  return () => target.removeEventListener("keydown", handle);
}

export function consumeTerminalShortcut(
  event: KeyboardEvent,
  actions: { toggle: () => void; newTab: () => void },
): boolean {
  if (event.type !== undefined && event.type !== "keydown" && event.ctrlKey && !event.metaKey && !event.altKey
    && (event.code === "Backquote" || event.key === "`")) {
    // Swallow the matching keyup/keypress so it never reaches the shell or other handlers.
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  const action = terminalShortcut(event);
  if (!action) return false;
  event.preventDefault();
  event.stopPropagation();
  if (action === "new-tab") actions.newTab();
  else actions.toggle();
  return true;
}

export function isLoginCommand(command: string): boolean {
  command = command.trim().replace(/^printf\s+'[^']*'\s+'(?:[^']|'\\'')*'\s*&&\s*/, "");
  // accountLoginCommand shell-quotes both paths, including embedded apostrophes.
  command = command.replace(/^mkdir -p '(?:[^']|'\\'')*' && (?:CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME)='(?:[^']|'\\'')*' /, "");
  return /^(?:grok\b|claude\s*$|codex\s+(?:login|mcp\s+login)\b|claude\s+auth\s+login\b)/i.test(command.trim());
}


/** OAuth's return focus must bypass both client and server focus throttles once. */
export function createAuthRefreshHandlers(refresh: (reason: string) => void, now = Date.now) {
  let lastFocus = 0;
  let awaitingLogin = false;
  return {
    focus: () => {
      if (!awaitingLogin && now() - lastFocus < 60_000) return;
      lastFocus = now();
      const reason = awaitingLogin ? "login" : "focus";
      awaitingLogin = false;
      refresh(reason);
    },
    login: () => { awaitingLogin = true; refresh("login"); },
  };
}
