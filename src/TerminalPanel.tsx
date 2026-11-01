import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, ExternalLink, Plus, SquareTerminal, X } from "lucide-react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  installTerminalShortcuts,
  consumeTerminalShortcut,
  notifyTerminal,
  openTerminal,
  requestAuthRefresh,
  TERMINAL_OPEN_EVENT,
  TERMINAL_TOGGLE_EVENT,
  type OpenTerminalOptions,
  type TerminalNotice,
} from "./terminal-events";
import { t } from "./i18n";
const HEIGHT_KEY = "orchestra.terminal.height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 180;

type TerminalTab = {
  id: string;
  cwd: string;
  exited?: boolean;
};

type TerminalRuntime = {
  terminal: XtermTerminal;
  fit: FitAddon;
  socket?: WebSocket;
  dispose: () => void;
};

export type TerminalPanelProps = {
  cwd?: string;
  homeCwd?: string;
  storageKey?: string;
  onNotice?: (notice: TerminalNotice) => void;
  onHeightChange?: (height: number) => void;
  onVisibilityChange?: (visible: boolean) => void;
};

function createTabId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type RestoredTerminalState = { tabs: TerminalTab[]; activeId?: string };


/** xterm colours from the --terminal-* tokens (tokens.css), so the terminal follows the app theme. */
function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = token("--terminal-bg", "#0f1012");
  const cursor = token("--terminal-cursor", "#5bd6a0");
  return { background, foreground: token("--terminal-fg", "#d7dade"), cursor, cursorAccent: background, selectionBackground: token("--terminal-selection", "rgba(91, 214, 160, 0.28)") };
}

/** Calls `onChange` when the theme may have changed: html[data-theme] or the OS colour scheme. */
function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", onChange);
  return () => { observer.disconnect(); media.removeEventListener("change", onChange); };
}

export function restoreTerminalState(raw: string | null, makeId: () => string = createTabId): RestoredTerminalState {
  if (!raw) return { tabs: [], activeId: undefined };
  try {
    const saved = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(saved.tabs)) return { tabs: [], activeId: undefined };
    const replacements = new Map<string, string>();
    const tabs = saved.tabs.flatMap((value): TerminalTab[] => {
      if (!value || typeof value !== "object") return [];
      const tab = value as { id?: unknown; cwd?: unknown; exited?: unknown };
      if (typeof tab.id !== "string" || !tab.id || typeof tab.cwd !== "string") return [];
      if (tab.exited === true) {
        const id = makeId();
        replacements.set(tab.id, id);
        return [{ id, cwd: tab.cwd, exited: false }];
      }
      return [{ id: tab.id, cwd: tab.cwd, exited: false }];
    });
    const requestedActive = typeof saved.activeId === "string" ? saved.activeId : undefined;
    const activeId = replacements.get(requestedActive ?? "")
      ?? tabs.find((tab) => tab.id === requestedActive)?.id
      ?? tabs[0]?.id;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: undefined };
  }
}

function terminalStateKey(key: string): string {
  return `orchestra.terminal.tabs.${key}`;
}

function readTerminalState(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(terminalStateKey(key));
  } catch {
    return null;
  }
}

export function resolveModuleConstructor<T>(module: unknown, name: string): T {
  const exports = module as { [key: string]: unknown; default?: unknown };
  const fallback = exports.default;
  const value = exports[name]
    ?? (fallback && typeof fallback === "object" ? (fallback as Record<string, unknown>)[name] : fallback);
  if (typeof value !== "function") throw new Error(t("term.moduleFailed", { name }));
  return value as T;
}

function basename(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  return cleaned.split("/").pop() || t("term.default");
}

function initialHeight(): number {
  if (typeof localStorage === "undefined") return DEFAULT_HEIGHT;
  const parsed = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(parsed) && parsed >= MIN_HEIGHT ? parsed : DEFAULT_HEIGHT;
}

function websocketUrl(tab: TerminalTab, cols: number, rows: number): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ id: tab.id, cwd: tab.cwd, cols: String(cols), rows: String(rows) });
  return `${protocol}//${location.host}/api/terminal/ws?${query}`;
}

function isLoginCommand(command: string): boolean {
  command = command.trim().replace(/^printf\s+'[^']*'\s+'(?:[^']|'\\'')*'\s*&&\s*/, "");
  return /^(?:grok\b|claude\s*$|codex\s+(?:login|mcp\s+login)\b|claude\s+auth\s+login\b)/i.test(command.trim());
}

async function runInTerminal(id: string, command: string): Promise<void> {
  const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || t("term.runFailed"));
  }
}

function TerminalSurface({ tab, visible, runtimeRef, onNotice, onExit, onShortcut }: {
  tab: TerminalTab;
  visible: boolean;
  runtimeRef: (id: string, runtime?: TerminalRuntime) => void;
  onNotice: (notice: TerminalNotice) => void;
  onExit: (id: string) => void;
  onShortcut: (action: "toggle" | "new-tab") => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const runtime = useRef<TerminalRuntime | undefined>(undefined);
  const shortcutCallback = useRef(onShortcut);
  shortcutCallback.current = onShortcut;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let resizeObserver: ResizeObserver | undefined;
    let socket: WebSocket | undefined;
    let exited = false;
    let destroyed = false;
    let connectedOnce = false;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/addon-clipboard"),
    ]).then(([xtermModule, fitModule, linksModule, clipboardModule]) => {
      if (disposed || !elementRef.current) return;
      const Terminal = resolveModuleConstructor<typeof import("@xterm/xterm").Terminal>(xtermModule, "Terminal");
      const FitAddon = resolveModuleConstructor<typeof import("@xterm/addon-fit").FitAddon>(fitModule, "FitAddon");
      const WebLinksAddon = resolveModuleConstructor<typeof import("@xterm/addon-web-links").WebLinksAddon>(linksModule, "WebLinksAddon");
      const ClipboardAddon = resolveModuleConstructor<typeof import("@xterm/addon-clipboard").ClipboardAddon>(clipboardModule, "ClipboardAddon");
      const terminal = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontFamily: '"SF Mono", Menlo, "D2Coding", monospace',
        fontSize: 14,
        lineHeight: 1.25,
        theme: terminalTheme(),
      });
      const stopThemeWatch = watchTheme(() => { terminal.options.theme = terminalTheme(); });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon());
      terminal.loadAddon(new ClipboardAddon());
      terminal.open(elementRef.current);

      terminal.attachCustomKeyEventHandler((event) => {
        if (consumeTerminalShortcut(event, {
          toggle: () => shortcutCallback.current("toggle"),
          newTab: () => shortcutCallback.current("new-tab"),
        })) return false;
        event.stopPropagation();
        if (event.type !== "keydown" || !event.metaKey) return true;
        const key = event.key.toLowerCase();
        if (key === "c" && terminal.hasSelection()) {
          event.preventDefault();
          void navigator.clipboard.writeText(terminal.getSelection());
          return false;
        }
        if (key === "v") {
          event.preventDefault();
          void navigator.clipboard.readText().then((text) => terminal.paste(text));
          return false;
        }
        return true;
      });

      const connect = () => {
        if (disposed) return;
        socket = new WebSocket(websocketUrl(tab, terminal.cols, terminal.rows));
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          reconnectAttempt = 0;
          if (connectedOnce) terminal.reset();
          connectedOnce = true;
        });
        socket.addEventListener("message", (event) => {
          const data = typeof event.data === "string" ? event.data : "";
          if (data.startsWith("{")) {
            try {
              const message = JSON.parse(data) as { type?: string; code?: number; error?: string; message?: string };
              if (message.type === "exit") {
                exited = true;
                onExit(tab.id);
                terminal.writeln(`\r\n${t("term.exited", { code: message.code === undefined ? "" : `: ${message.code}` })}`);
                requestAuthRefresh();
                return;
              }
              if (message.type === "ready") {
                if (runtime.current) runtimeRef(tab.id, runtime.current);
                return;
              }
              if (message.type === "error") {
                exited = true;
                onExit(tab.id);
                const body = message.error || message.message || t("term.startFailed");
                terminal.writeln(`\r\n${t("term.errorLine", { body })}`);
                onNotice({ type: "error", key: "terminal:load", title: t("term.cantOpen"), body });
                socket?.close();
                return;
              }
            } catch { /* PTY output can validly begin with JSON-like text. */ }
          }
          terminal.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
        });
        socket.addEventListener("close", (event) => {
          if (disposed || exited) return;
          if (event.code === 1011) {
            exited = true;
            onExit(tab.id);
            onNotice({
              type: "error",
              key: "terminal:load",
              title: t("term.cantOpen"),
              body: event.reason || t("term.processFailed"),
            });
            return;
          }
          const delay = Math.min(5_000, 300 * 2 ** reconnectAttempt++);
          reconnectTimer = window.setTimeout(connect, delay);
        });
        socket.addEventListener("error", () => {
          if (reconnectAttempt === 0) onNotice({
            type: "error",
            key: "terminal:connection",
            title: t("term.connectFailed"),
            body: t("term.connectFailedBody"),
          });
        });
      };

      terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
      });
      terminal.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      resizeObserver = new ResizeObserver(() => {
        if (!disposed && elementRef.current?.offsetParent) fit.fit();
      });
      resizeObserver.observe(elementRef.current);
      fit.fit();
      runtime.current = {
        terminal,
        fit,
        get socket() { return socket; },
        dispose: () => {
          if (destroyed) return;
          destroyed = true;
          disposed = true;
          if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
          resizeObserver?.disconnect();
          stopThemeWatch();
          socket?.close();
          terminal.dispose();
        },
      };
      connect();
      if (elementRef.current.offsetParent) terminal.focus();
    }).catch((error: unknown) => {
      if (disposed) return;
      const body = error instanceof Error ? error.message : String(error);
      onNotice({ type: "error", key: "terminal:load", title: t("term.cantOpen"), body });
    });

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      resizeObserver?.disconnect();
      socket?.close();
      runtime.current?.dispose();
      runtime.current = undefined;
      runtimeRef(tab.id, undefined);
    };
  }, [tab.id, tab.cwd, onExit, onNotice, runtimeRef]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      runtime.current?.fit.fit();
      runtime.current?.terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return <div ref={elementRef} className="terminal-surface" aria-label={t("term.surface", { name: basename(tab.cwd) })} />;
}

export function TerminalPanel({
  cwd = "",
  homeCwd = "",
  storageKey = "default",
  onNotice,
  onHeightChange,
  onVisibilityChange,
}: TerminalPanelProps) {
  const [restored] = useState(() => restoreTerminalState(readTerminalState(storageKey)));
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  const [tabs, setTabs] = useState<TerminalTab[]>(restored.tabs);
  const [activeId, setActiveId] = useState<string | undefined>(restored.activeId);
  const runtimes = useRef(new Map<string, TerminalRuntime>());
  const pendingCommands = useRef(new Map<string, string[]>());
  const tabsRef = useRef(tabs);
  const visibleRef = useRef(visible);
  const heightCallback = useRef(onHeightChange);
  const noticeCallback = useRef(onNotice);
  tabsRef.current = tabs;
  visibleRef.current = visible;
  heightCallback.current = onHeightChange;
  noticeCallback.current = onNotice;

  useEffect(() => {
    onHeightChange?.(visible ? height : 0);
    document.documentElement.style.setProperty("--terminal-offset", `${visible ? height : 0}px`);
  }, [height, onHeightChange, visible]);

  useEffect(() => () => heightCallback.current?.(0), []);

  useEffect(() => {
    try {
      localStorage.setItem(terminalStateKey(storageKey), JSON.stringify({ tabs, activeId }));
    } catch { /* Storage can be unavailable in hardened webviews. */ }
  }, [activeId, storageKey, tabs]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/terminal").then(async (response) => {
      if (!response.ok) return [];
      const data = await response.json() as { id: string; cwd: string; alive: boolean }[] | { sessions?: { id: string; cwd: string; alive: boolean }[] };
      return Array.isArray(data) ? data : data.sessions ?? [];
    }).then((sessions) => {
      if (cancelled) return;
      setTabs((current) => {
        const ids = new Set(current.map((tab) => tab.id));
        const recovered = sessions.filter((session) => session.alive && !ids.has(session.id))
          .map((session): TerminalTab => ({ id: session.id, cwd: session.cwd, exited: false }));
        if (recovered.length && !activeId) setActiveId(recovered[0].id);
        return recovered.length ? [...current, ...recovered] : current;
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const emitNotice = useCallback((notice: TerminalNotice) => {
    noticeCallback.current?.(notice);
    notifyTerminal(notice);
  }, []);

  const setPanelVisible = useCallback((next: boolean) => {
    setVisible(next);
    onVisibilityChange?.(next);
  }, [onVisibilityChange]);

  const addTab = useCallback((requestedCwd?: string) => {
    const tab = { id: createTabId(), cwd: requestedCwd || cwd || homeCwd };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setPanelVisible(true);
    return tab;
  }, [cwd, homeCwd, setPanelVisible]);

  const assignRuntime = useCallback((id: string, runtime?: TerminalRuntime) => {
    if (!runtime) {
      runtimes.current.delete(id);
      return;
    }
    runtimes.current.set(id, runtime);
    const commands = pendingCommands.current.get(id) ?? [];
    pendingCommands.current.delete(id);
    for (const command of commands) {
      void runInTerminal(id, command).catch((error: unknown) => emitNotice({
        type: "error", title: t("term.commandFailed"), body: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [emitNotice]);

  const handleOpen = useCallback((options: OpenTerminalOptions = {}) => {
    const existing = tabsRef.current.find((tab) => !tab.exited && options.cwd && tab.cwd === options.cwd)
      ?? (options.cwd ? undefined : tabsRef.current.find((tab) => !tab.exited && tab.id === activeId));
    const tab = existing ?? addTab(options.cwd);
    setActiveId(tab.id);
    setPanelVisible(true);
    if (options.command) {
      if (runtimes.current.has(tab.id)) {
        void runInTerminal(tab.id, options.command).catch((error: unknown) => emitNotice({
          type: "error", title: t("term.commandFailed"), body: error instanceof Error ? error.message : String(error),
        }));
      } else {
        pendingCommands.current.set(tab.id, [...(pendingCommands.current.get(tab.id) ?? []), options.command]);
      }
      if (isLoginCommand(options.command)) requestAuthRefresh();
    }
  }, [activeId, addTab, emitNotice, setPanelVisible]);

  useEffect(() => installTerminalShortcuts(window, {
    toggle: () => {
      if (!visible && tabsRef.current.length === 0) addTab();
      else setPanelVisible(!visible);
    },
    newTab: () => addTab(),
  }), [addTab, setPanelVisible, visible]);

  useEffect(() => {
    const open = (event: Event) => handleOpen((event as CustomEvent<OpenTerminalOptions>).detail ?? {});
    const toggle = () => {
      if (!visible && tabsRef.current.length === 0) addTab();
      else setPanelVisible(!visible);
    };
    window.addEventListener(TERMINAL_OPEN_EVENT, open);
    window.addEventListener(TERMINAL_TOGGLE_EVENT, toggle);
    return () => {
      window.removeEventListener(TERMINAL_OPEN_EVENT, open);
      window.removeEventListener(TERMINAL_TOGGLE_EVENT, toggle);
    };
  }, [addTab, handleOpen, setPanelVisible, visible]);

  useEffect(() => () => {
    for (const runtime of runtimes.current.values()) runtime.dispose();
    runtimes.current.clear();
  }, []);

  const closeTab = (id: string) => {
    runtimes.current.get(id)?.dispose();
    runtimes.current.delete(id);
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" });
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id);
      if (next.length === 0) setPanelVisible(false);
      return next;
    });
  };

  const markExited = useCallback((id: string) => {
    runtimes.current.delete(id);
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, exited: true } : tab));
  }, []);

  const handleOwnedShortcut = useCallback((action: "toggle" | "new-tab") => {
    if (action === "new-tab") {
      addTab();
      return;
    }
    setPanelVisible(!visibleRef.current);
  }, [addTab, setPanelVisible]);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const initialY = event.clientY;
    const initial = height;
    const move = (pointer: PointerEvent) => {
      const maximum = Math.max(MIN_HEIGHT, window.innerHeight - 120);
      setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, initial + initialY - pointer.clientY)));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      setHeight((current) => {
        localStorage.setItem(HEIGHT_KEY, String(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const active = tabs.find((tab) => tab.id === activeId);
  return (
    <section className={`terminal-panel${visible ? " terminal-panel-visible" : ""}`} style={{ height }} aria-hidden={!visible}>
      <div className="terminal-resize-handle" onPointerDown={startResize} aria-hidden="true" />
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label={t("term.tabs")}>
          <SquareTerminal size={15} className="terminal-mark" aria-hidden="true" />
          {tabs.map((tab, index) => <div className={`terminal-tab${tab.id === activeId ? " active" : ""}`} key={tab.id}>
            <button type="button" role="tab" aria-selected={tab.id === activeId} onClick={() => setActiveId(tab.id)}>
              {basename(tab.cwd)} {index + 1}
            </button>
            <button type="button" className="terminal-tab-close" aria-label={t("term.closeTab", { name: basename(tab.cwd) })} onClick={() => closeTab(tab.id)}><X size={12} /></button>
          </div>)}
          <button type="button" className="terminal-add" aria-label={t("term.new")} title={t("term.newTitle")} onClick={() => addTab()}><Plus size={15} /></button>
        </div>
        <div className="terminal-actions">
          <button type="button" disabled={!active} onClick={() => {
            if (!active) return;
            void fetch("/api/terminal/external", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: active.cwd }) })
              .then(async (response) => { if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || t("term.externalFailed")); })
              .catch((error: unknown) => emitNotice({ type: "error", title: t("term.externalFailedTitle"), body: error instanceof Error ? error.message : String(error) }));
          }}><ExternalLink size={13} />{t("term.openExternal")}</button>
          <button type="button" disabled={!active} aria-label={t("term.clear")} title={t("term.clear")} onClick={() => active && runtimes.current.get(active.id)?.terminal.clear()}><Eraser size={14} /></button>
          <button type="button" aria-label={t("term.closePanel")} title={t("term.closePanelTitle")} onClick={() => setPanelVisible(false)}><X size={15} /></button>
        </div>
      </header>
      <div className="terminal-body">
        {tabs.map((tab) => <div key={tab.id} className={`terminal-pane${tab.id === activeId ? " active" : ""}`}>
          <TerminalSurface tab={tab} visible={visible && tab.id === activeId} runtimeRef={assignRuntime} onNotice={emitNotice} onExit={markExited} onShortcut={handleOwnedShortcut} />
        </div>)}
      </div>
    </section>
  );
}

export { openTerminal };
