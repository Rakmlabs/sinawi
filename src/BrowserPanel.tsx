import { canGo, emptyHistory, recordLocation, traverse, type TabHistory } from "./tab-history";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, ChevronDown, Download, Globe, Monitor, MousePointerClick, Plus, RefreshCw, RotateCw, Server, Smartphone, Square, SquareCode, X } from "lucide-react";
import { pushRecent, RECENT_STORE, type RecentSite } from "./browser-surface";
import { emulationOf, emulationPayload, fitDevice, isViewportError, parseViewportArg, readViewport, serializeViewport, toggleViewport, VIEWPORT_STORE, viewportLabel, type ViewportChoice } from "./browser-viewport";
import { browserRegistry } from "./browser-registry";
import { OWN_APP_ERROR, agentCommandError, claimCommand, commandTargetsOwnApp, holdCommand, replayCommand, takeHeldCommand, withTargetUrls, type AgentCommand } from "./browser-agent";
import { browserOwnsFocus, browserShortcut, chatShortcut, globalBrowserShortcut, windowShortcut, type BrowserAction } from "./browser-shortcuts";
import { attachmentLabel, displayUrl, type ComposerAttachment, type ElementCapture } from "./preview-attachments";
import { toggleTerminal } from "./terminal-events";
import { IFRAME_SANDBOX, previewTargetOrigin, trustedPreviewSender } from "./browser-messages";
import { t } from "./i18n";
import { captureRect, dialogLines, downloadProgress, downloadsText, formatBytes, FULL_PAGE_MAX_HEIGHT, isCovered, layoutKey, nativeBrowser, nativeBrowserAvailable, nativeFocusedTab, parseEvents, slotBounds, type DialogInfo, type DownloadInfo, type HostEvent, type NativeRect, type NativeResult } from "./native-browser";

type Tab = {
  id: string; input: string; url: string; title: string; frameUrl?: string; proxied?: boolean;
  proxyOrigin?: string; targetOrigin?: string; loading?: boolean; error?: string; nonce: number;
  /** Native WKWebView tab (desktop app): any http/https page, real history and screenshots. */
  native?: boolean; canBack?: boolean; canForward?: boolean;
  /** Native tab blocked on a page alert/confirm/prompt (answered from the dialog bar or by ao-browser dialog). */
  dialog?: DialogInfo;
};
type Port = { port: number; command: string; url: string };
type OpenResult = { url: string; frameUrl: string; proxied: boolean; native?: boolean; proxyOrigin?: string; targetOrigin?: string };

const BASE_STORE = "orchestra.browser.tabs";
const newId = () => Math.random().toString(36).slice(2, 10);
const blankTab = (): Tab => ({ id: newId(), input: "", url: "", title: t("br.newTab"), nonce: 0 });

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? t("br.requestFailed", { status: res.status }));
  return data as T;
}

export type BrowserPanelProps = {
  /** Separate tab storage per browser window (desktop mode). */
  instanceId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the last tab closes (⌘W) so the window itself can close. */
  onLastTabClosed?: () => void;
  /** Window snapping (⌃⌥ arrows) forwarded from inside the page. */
  onSnap?: (snap: "left" | "right" | "max") => void;
  onAttach: (items: ComposerAttachment[]) => void;
  onNotice?: (text: string) => void;
};

export function BrowserPanel({ open, onOpenChange, onLastTabClosed, onSnap, onAttach, onNotice, instanceId = "main" }: BrowserPanelProps) {
  const STORE = instanceId === "main" ? BASE_STORE : `${BASE_STORE}.${instanceId}`;
  useLayoutEffect(() => browserRegistry.mount(instanceId), [instanceId]);
  const isActive = () => browserRegistry.isActive(instanceId);
  // ⌘W etc. apply when focus is in this browser, or its desktop window was the last thing clicked.
  const ownsNativeFocus = () => { const id = nativeFocusedTab(); return Boolean(id && tabsRef.current.some((tab) => tab.id === id)); };
  const ownsFocus = () => browserOwnsFocus() || browserRegistry.desktopFocused() || ownsNativeFocus();
  // Desktop app on macOS: tabs are native WKWebViews laid over `slot`; otherwise iframes through the proxy.
  const [native] = useState(() => nativeBrowserAvailable());
  const slot = useRef<HTMLDivElement | null>(null);
  const shownTab = useRef<string | undefined>(undefined);
  const [frozen, setFrozen] = useState<{ id: string; image: string }>();
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const [downloadsHidden, setDownloadsHidden] = useState<string[]>([]);
  const [dialogText, setDialogText] = useState("");
  const [recent, setRecent] = useState<RecentSite[]>(() => { try { const list = JSON.parse(localStorage.getItem(RECENT_STORE) ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; } });
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
      if (Array.isArray(saved?.tabs) && saved.tabs.length) return saved.tabs.map((tab: { url?: string; title?: string }) => ({ ...blankTab(), input: tab.url ?? "", url: tab.url ?? "", title: tab.title || t("br.newTab") }));
    } catch { /* ignore */ }
    return [blankTab()];
  });
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [closed, setClosed] = useState<string[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [picking, setPicking] = useState<{ on: boolean; count: number }>({ on: false, count: 0 });
  const [status, setStatus] = useState("");
  const [viewport, setViewport] = useState<ViewportChoice>(() => { try { return readViewport(localStorage.getItem(VIEWPORT_STORE)); } catch { return readViewport(null); } });
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [customSize, setCustomSize] = useState({ w: "390", h: "844" });
  const deviceMenuRef = useRef<HTMLDivElement>(null);
  const viewportBox = useRef<HTMLDivElement>(null);
  const emuBoot = useRef(new Set<string>());
  const [panelBox, setPanelBox] = useState({ w: 0, h: 0 });
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const urlInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const lastAction = useRef<Record<string, number>>({});
  const histories = useRef(new Map<string, TabHistory>());
  const [, setHistoryVersion] = useState(0);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify({ tabs: tabs.filter((tab) => tab.url).map((tab) => ({ url: tab.url, title: tab.title })) }));
  }, [tabs]);

  const patch = useCallback((id: string, next: Partial<Tab>) => setTabs((old) => old.map((tab) => tab.id === id ? { ...tab, ...next } : tab)), []);

  const navigate = useCallback(async (id: string, address: string): Promise<OpenResult | undefined> => {
    if (!address.trim()) return;
    patch(id, { loading: true, error: undefined, input: address });
    if (native) {
      try {
        const result = await post<OpenResult>("/preview/open", { url: address, native: true });
        await nativeBrowser.open(id, result.url, emulationOf(viewportRef.current).userAgent);
        patch(id, { url: result.url, input: result.url, frameUrl: result.url, native: true, proxied: false, proxyOrigin: undefined, targetOrigin: undefined, title: result.url.replace(/^https?:\/\//, ""), loading: true });
        return { ...result, native: true };
      } catch (error) {
        patch(id, { loading: false, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    try {
      const result = await post<OpenResult>("/preview/open", { url: address });
      patch(id, { url: result.url, input: result.url, frameUrl: result.frameUrl, proxied: result.proxied, proxyOrigin: result.proxyOrigin, targetOrigin: result.targetOrigin, title: result.url.replace(/^https?:\/\//, ""), loading: true });
      // Same address → React won't touch the iframe, so reload it explicitly.
      const frame = frames.current.get(id);
      if (frame && frame.getAttribute("src") === result.frameUrl) frame.src = result.frameUrl;
      return result;
    } catch (error) {
      patch(id, { loading: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [patch, native]);

  // Restore saved tabs lazily (only the visible one loads immediately).
  useEffect(() => {
    if (!open) return;
    const tab = tabsRef.current.find((item) => item.id === activeId);
    if (tab && tab.url && !tab.frameUrl && !tab.loading && !tab.error) void navigate(tab.id, tab.url).catch(() => undefined);
  }, [open, activeId, navigate]);

  const refreshPorts = useCallback(() => {
    void fetch("/api/preview/ports").then((res) => res.json()).then((data) => setPorts(Array.isArray(data.ports) ? data.ports : [])).catch(() => setPorts([]));
  }, []);
  useEffect(() => { if (open) refreshPorts(); }, [open, refreshPorts]);

  const send = useCallback((id: string, message: Record<string, unknown>) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (tab?.native) {
      if (message.type === "reload") void nativeBrowser.history(id, "reload").catch(() => undefined);
      else if (message.type === "devtools") void nativeBrowser.devtools(id).catch(() => undefined);
      else if (message.type !== "go") void nativeBrowser.send(id, message);
      return;
    }
    // Only the proxied page (same proxy origin) may receive commands; after it navigates elsewhere, drop them.
    const targetOrigin = previewTargetOrigin(tabsRef.current.find((tab) => tab.id === id));
    if (targetOrigin) frames.current.get(id)?.contentWindow?.postMessage({ source: "orchestra-parent", ...message }, targetOrigin);
  }, []);
  const applyViewport = useCallback((choice: ViewportChoice) => {
    const previous = emulationOf(viewportRef.current);
    const next = emulationPayload(choice);
    viewportRef.current = choice;
    setViewport(choice);
    try { localStorage.setItem(VIEWPORT_STORE, serializeViewport(choice)); } catch { /* ignore */ }
    const reload = previous.userAgent !== next.userAgent || previous.touch !== next.touch;
    for (const tab of tabsRef.current) {
      if (tab.native && tab.frameUrl) {
        const id = tab.id;
        void nativeBrowser.emulate(id, next.userAgent).then((changed) => {
          void nativeBrowser.send(id, { type: "emulate", ...next, persist: true });
          if (changed || reload) { void nativeBrowser.history(id, "reload").catch(() => undefined); patch(id, { loading: true }); }
        }).catch(() => undefined);
        continue;
      }
      if (!tab.proxied || !tab.frameUrl) continue;
      send(tab.id, { type: "emulate", ...next, persist: true });
      if (reload) { emuBoot.current.add(`${tab.id}:${tab.frameUrl}`); send(tab.id, { type: "reload" }); patch(tab.id, { loading: true }); }
    }
  }, [patch, send]);
  /** Back/forward only inside the tab: replace the iframe location with the tracked entry. */
  const go = useCallback((id: string, delta: -1 | 1) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (tab?.native) {
      // Real WebKit history of that tab's own view (never the app window's).
      if (!(delta < 0 ? tab.canBack : tab.canForward)) return false;
      patch(id, { loading: true });
      void nativeBrowser.history(id, delta < 0 ? "back" : "forward").catch(() => undefined);
      return true;
    }
    const step = traverse(histories.current.get(id) ?? emptyHistory(), delta);
    if (!step) return false;
    histories.current.set(id, step.history);
    patch(id, { loading: true });
    send(id, { type: "go", href: step.href });
    return true;
  }, [patch, send]);

  const addTab = useCallback((address = "") => {
    const tab = blankTab();
    setTabs((old) => [...old, tab]);
    setActiveId(tab.id);
    if (address) void navigate(tab.id, address).catch(() => undefined);
    else requestAnimationFrame(() => { urlInput.current?.focus(); urlInput.current?.select(); });
    refreshPorts();
  }, [navigate, refreshPorts]);

  const closeTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tab = list[index];
    if (tab.url) setClosed((old) => [...old.slice(-19), tab.url]);
    frames.current.delete(id);
    if (tab.native) void nativeBrowser.close(id).catch(() => undefined);
    if (list.length === 1 && onLastTabClosed) { onLastTabClosed(); return; }
    if (list.length === 1) { const fresh = blankTab(); setTabs([fresh]); setActiveId(fresh.id); return; }
    const next = list.filter((item) => item.id !== id);
    setTabs(next);
    if (activeRef.current === id) setActiveId(next[Math.min(index, next.length - 1)].id);
  }, [onLastTabClosed]);

  const reopenTab = useCallback(() => {
    setClosed((old) => {
      const url = old.at(-1);
      if (url) addTab(url);
      return old.slice(0, -1);
    });
  }, [addTab]);

  const reload = useCallback(() => {
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    if (!tab?.frameUrl) return;
    if (tab.proxied || tab.native) send(tab.id, { type: "reload" });
    else patch(tab.id, { nonce: tab.nonce + 1 });
    patch(tab.id, { loading: true });
  }, [patch, send]);

  const togglePicker = useCallback((force?: boolean) => {
    onOpenChange(true);
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    if (!tab?.frameUrl) { setStatus(t("br.openPageFirst")); return; }
    if (!tab.proxied && !tab.native) { setStatus(t("br.pickLocalOnly")); return; }
    const on = force ?? !picking.on;
    send(tab.id, { type: "pick", on });
    if (tab.native) void nativeBrowser.history(tab.id, "focus").catch(() => undefined);
    else frames.current.get(tab.id)?.focus();
  }, [onOpenChange, picking.on, send]);

  const openDevtools = useCallback((native: boolean) => {
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    // Native tab: WebKit's own Web Inspector for that page (⇧ still opens the app's inspector).
    if (!native && tab?.native) { void nativeBrowser.devtools(tab.id).catch((error: unknown) => setStatus(String(error))); return; }
    if (native || !tab?.proxied) {
      if (internals) void internals.invoke("open_devtools").catch(() => undefined);
      else setStatus(t("br.inspectorDesktopOnly"));
      return;
    }
    send(tab.id, { type: "devtools" });
  }, [send]);
  const perform = useCallback((action: BrowserAction) => {
    const now = Date.now();
    if (now - (lastAction.current[action.type] ?? 0) < 350) return;
    lastAction.current[action.type] = now;
    const list = tabsRef.current;
    const index = Math.max(0, list.findIndex((tab) => tab.id === activeRef.current));
    switch (action.type) {
      case "new-tab": addTab(); break;
      case "close-tab": closeTab(activeRef.current); break;
      case "reopen-tab": reopenTab(); break;
      case "focus-url": urlInput.current?.focus(); urlInput.current?.select(); break;
      case "reload": reload(); break;
      case "next-tab": setActiveId(list[(index + 1) % list.length].id); break;
      case "prev-tab": setActiveId(list[(index - 1 + list.length) % list.length].id); break;
      case "select-tab": { const tab = action.index < 0 ? list.at(-1) : list[action.index]; if (tab) setActiveId(tab.id); break; }
      case "back": go(activeRef.current, -1); break;
      case "forward": go(activeRef.current, 1); break;
      case "toggle-picker": togglePicker(); break;
      case "toggle-panel": onOpenChange(!open); break;
      case "toggle-terminal": toggleTerminal(); break;
      case "devtools": openDevtools(false); break;
      case "snap": onSnap?.(action.snap); break;
    }
  }, [addTab, closeTab, reopenTab, reload, send, go, togglePicker, onOpenChange, open, openDevtools, onSnap]);

  // Keyboard: global (⌘⇧B / ⌘⇧C) and browser-focused shortcuts.
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || !isActive()) return;
      const global = globalBrowserShortcut(event);
      if (global) { event.preventDefault(); event.stopPropagation(); perform(global); return; }
      if (!open || !ownsFocus()) return;
      if (event.metaKey && event.altKey && event.code === "KeyI") { event.preventDefault(); event.stopPropagation(); perform({ type: "devtools" }); return; }
      const action = browserShortcut(event);
      if (!action) return;
      if (action.type === "focus-url" || action.type === "back" || action.type === "forward") {
        const target = event.target as HTMLElement | null;
        if (action.type !== "focus-url" && target?.tagName === "INPUT") return;
      }
      event.preventDefault(); event.stopPropagation();
      perform(action);
    };
    window.addEventListener("keydown", handle, { capture: true });
    return () => window.removeEventListener("keydown", handle, { capture: true });
  }, [open, perform]);

  // Native menu items (⌘R / ⌘W) call into these.
  useEffect(() => {
    const w = window as unknown as { __orchestraMenuReload?: () => void; __orchestraMenuCloseTab?: () => void };
    return browserRegistry.handlers(instanceId, {
      reload: () => {
        if (open && (browserOwnsFocus() || ownsNativeFocus())) perform({ type: "reload" });
        else if (Date.now() - (lastAction.current.reload ?? 0) > 500) window.location.reload();
      },
      closeTab: () => { if (open && ownsFocus()) perform({ type: "close-tab" }); },
    }, w);
  }, [open, perform]);

  const uploadCaptures = useCallback(async (items: ElementCapture[], viewportShot?: string) => {
    const images = [viewportShot ?? "", ...items.map((item) => item.screenshot ?? "")];
    let paths: (string | null)[] = [];
    try { paths = (await post<{ paths: (string | null)[] }>("/preview/assets", { images })).paths; }
    catch (error) { setStatus(t("br.captureFailed", { error: error instanceof Error ? error.message : String(error) })); }
    const viewportPath = paths[0] ?? undefined;
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    const attachments: ComposerAttachment[] = items.map((item, index) => {
      const { screenshot, ...element } = item;
      element.url = displayUrl(element.url, tab?.proxyOrigin, tab?.targetOrigin);
      return { id: newId(), kind: "element", label: attachmentLabel(item), preview: screenshot ?? viewportShot, screenshotPath: paths[index + 1] ?? undefined, viewportPath, element };
    });
    onAttach(attachments);
    setStatus(t("br.attached", { n: attachments.length }));
    onNotice?.(t("br.attachedShort", { n: attachments.length }));
  }, [onAttach, onNotice]);

  /** Native tab picks: real WebKit pixels for the viewport and each picked element. */
  const nativeCaptures = useCallback(async (id: string, items: ElementCapture[]) => {
    const viewportShot = await nativeBrowser.screenshot(id).catch(() => undefined);
    const shots = await Promise.all(items.map((item) => item.rect ? nativeBrowser.screenshot(id, captureRect(item.rect, item.viewport)).catch(() => undefined) : Promise.resolve(undefined)));
    await uploadCaptures(items.map((item, index) => ({ ...item, screenshot: shots[index] ?? item.screenshot })), viewportShot);
  }, [uploadCaptures]);

  const stopAgentRef = useRef<() => void>(() => undefined);
  // ---- AI agent control (ao-browser) ----
  const [agentTab, setAgentTab] = useState<string>();
  const agentPending = useRef(new Map<string, (value: { ok: boolean; result?: unknown; error?: string }) => void>());
  const stoppedUntil = useRef(0);
  const agentIdle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const callFrame = useCallback((id: string, action: string, args: Record<string, unknown>, timeout = 9000) => new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    if (tabsRef.current.find((item) => item.id === id)?.native) {
      // Settles through agentPending too, so the user's Stop (Esc) cancels native calls as well.
      const callId = newId();
      agentPending.current.set(callId, (value) => { agentPending.current.delete(callId); resolve(value); });
      void nativeBrowser.run(id, action, args, timeout).then((value) => agentPending.current.get(callId)?.(value));
      return;
    }
    const callId = newId();
    const timer = setTimeout(() => { agentPending.current.delete(callId); resolve({ ok: false, error: "페이지가 응답하지 않습니다 (로딩 중이거나 picker 스크립트가 없음)." }); }, timeout);
    agentPending.current.set(callId, (value) => { clearTimeout(timer); agentPending.current.delete(callId); resolve(value); });
    send(id, { type: "agent", id: callId, action, args });
  }), [send]);
  const waitReady = useCallback(async (id: string, ms = 15000) => {
    const until = Date.now() + ms;
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() < until) {
      const tab = tabsRef.current.find((item) => item.id === id);
      if (tab?.native) {
        // Ask WebKit directly: the tab state is only refreshed by the poll loop.
        const state = await nativeBrowser.poll(id).catch(() => undefined);
        if (state?.exists && !state.loading && state.url && state.url !== "about:blank") {
          const res = await callFrame(id, "status", {}, 1500);
          if (res.ok && (res.result as { ready?: string })?.ready !== "loading") return res;
        }
      } else if (tab && !tab.loading && tab.frameUrl) {
        const res = await callFrame(id, "status", {}, 1000);
        if (res.ok && (res.result as { ready?: string })?.ready !== "loading") return res;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: "페이지 로딩이 끝나지 않았습니다." };
  }, [callFrame]);
  const stopAgent = useCallback(() => {
    stoppedUntil.current = Date.now() + 60_000;
    for (const resolve of agentPending.current.values()) resolve({ ok: false, error: "사용자가 AI 조작을 중지했습니다." });
    agentPending.current.clear();
    if (agentTab) send(agentTab, { type: "agent-hide" });
    setAgentTab(undefined);
    setStatus(t("br.agentStopped"));
  }, [agentTab, send]);
  const tabSummary = useCallback((activeTabId: string) => tabsRef.current.map((item, index) => ({ index: index + 1, active: item.id === activeTabId, url: item.url, title: item.title, controllable: Boolean(item.proxied || item.native) })), []);
  const pagePicture = useCallback(async (id: string) => {
    const ready = await waitReady(id);
    if (!ready.ok) return ready;
    const idle = await callFrame(id, "networkidle", {}, 6000);
    const snap = await callFrame(id, "snapshot", {}, 8000);
    const idleResult = idle.ok ? idle.result as { idle?: boolean; pending?: number } : undefined;
    const shot = snap.ok ? snap.result as { snapshot?: string; title?: string } : undefined;
    return { ok: true as const, result: { url: (ready.result as { url?: string })?.url, title: (ready.result as { title?: string })?.title ?? shot?.title, networkIdle: idleResult ? idleResult.idle !== false : undefined, pending: idleResult?.pending, snapshot: shot?.snapshot } };
  }, [waitReady, callFrame]);
  /** Real NSEvents (isTrusted) for click/fill/type/press. Undefined means "use the DOM path instead". */
  const trustedInput = useCallback(async (id: string, action: string, args: Record<string, unknown>): Promise<NativeResult | undefined> => {
    const target = { ref: args.ref, selector: args.selector };
    try {
      if (action === "click") {
        const point = await callFrame(id, "point", target, 6000);
        if (!point.ok) return point;
        const at = point.result as { x: number; y: number };
        await nativeBrowser.input(id, "click", { x: at.x, y: at.y });
      } else if (action === "fill" || action === "type") {
        const focus = await callFrame(id, "focus", { ...target, append: action === "type" }, 6000);
        if (!focus.ok) return focus;
        const text = String(args.text ?? "");
        if (text) await nativeBrowser.input(id, "text", { text });
      } else {
        if (args.ref || args.selector) { const focus = await callFrame(id, "focus", { ...target, append: true }, 6000); if (!focus.ok) return focus; }
        await nativeBrowser.input(id, "key", { text: String(args.key ?? "Enter") });
      }
    } catch { return undefined; }
    await new Promise((r) => setTimeout(r, 300));
    const value = action === "fill" || action === "type" ? await callFrame(id, "value", target, 3000) : undefined;
    const snap = await callFrame(id, "snapshot", {}, 8000);
    const picture = snap.result as { snapshot?: string; url?: string; navigated?: boolean } | undefined;
    const key = action === "click" ? "clicked" : action === "press" ? "pressed" : "filled";
    return { ok: true, result: { [key]: action === "press" ? String(args.key ?? "Enter") : String(args.ref ?? args.selector ?? ""), value: (value?.result as { value?: string } | undefined)?.value, trusted: true, snapshot: picture?.snapshot, url: picture?.url, navigated: picture?.navigated } };
  }, [callFrame]);
  const runAgentCommand = useCallback(async (command: AgentCommand) => {
    if (Date.now() < stoppedUntil.current) return { ok: false, error: "사용자가 AI 조작을 중지했습니다. 계속하려면 사용자에게 확인하세요." };
    if (command.action === "viewport") {
      const parsed = parseViewportArg(String(command.args.preset ?? ""), viewportRef.current);
      if (isViewportError(parsed)) return { ok: false, error: parsed.error };
      applyViewport(parsed);
      const emu = emulationOf(parsed);
      return { ok: true, result: { preset: parsed.mode === "desktop" ? "desktop" : parsed.preset, width: parsed.mode === "device" ? parsed.width : null, height: parsed.mode === "device" ? parsed.height : null, mobile: emu.mobile, touch: emu.touch, userAgent: emu.userAgent || undefined } };
    }
    if (commandTargetsOwnApp(command.action, command.args)) return { ok: false, error: OWN_APP_ERROR };
    if (!replayCommand(command.action)) onOpenChange(true);
    const list = tabsRef.current;
    const tab = list.find((item) => item.id === activeRef.current) ?? list[0];
    if (command.action === "tabs") return { ok: true, result: { tabs: tab ? tabSummary(tab.id) : [] } };
    if (command.action === "downloads") {
      if (!native) return { ok: false, error: "다운로드 추적은 데스크톱 앱에서만 됩니다." };
      try {
        const list = await nativeBrowser.downloads(command.args.cancel ? String(command.args.cancel) : undefined);
        setDownloads(list);
        return { ok: true, result: { count: list.length, downloads: list, text: downloadsText(list) } };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (!tab) return { ok: false, error: "열린 페이지가 없습니다. 먼저 `ao-browser goto <포트 또는 localhost 주소>` 로 여세요." };
    if (command.action === "tab") {
      const op = String(command.args.op ?? "list");
      if (op === "new") {
        const created = blankTab();
        setTabs((old) => [...old, created]);
        setActiveId(created.id);
        const url = String(command.args.url ?? "").trim();
        if (!url) return { ok: true, result: { created: true, index: list.length + 1, title: "새 탭" } };
        let opened: OpenResult | undefined;
        try { opened = await navigate(created.id, url); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        if (!opened?.proxied && !opened?.native) return { ok: true, result: { created: true, index: list.length + 1, url: opened?.url, controllable: false, note: "외부 사이트라 표시만 되고 AI 조작은 안 됩니다. localhost 개발 서버만 조작할 수 있습니다." } };
        const picture = await pagePicture(created.id);
        if (!picture.ok) return picture;
        const swapped = withTargetUrls(picture, opened.proxyOrigin, opened.targetOrigin);
        return { ok: true, result: { created: true, index: list.length + 1, controllable: true, ...(swapped.result as object), url: opened.url } };
      }
      const index = Number(command.args.index);
      if (!Number.isInteger(index) || index < 1 || index > list.length) return { ok: false, error: `탭 번호가 없습니다. ao-browser tabs 로 1–${list.length} 사이를 확인하세요.` };
      const picked = list[index - 1];
      if (op === "close") {
        if (list.length === 1) { const fresh = blankTab(); setTabs([fresh]); setActiveId(fresh.id); return { ok: true, result: { closed: index, note: "마지막 탭이라 페이지를 비웠습니다." } }; }
        closeTab(picked.id);
        return { ok: true, result: { closed: index } };
      }
      if (op !== "select") return { ok: false, error: "탭 명령은 new, select, close 입니다. 예: ao-browser tab select 2" };
      setActiveId(picked.id);
      if (picked.url && !picked.frameUrl) { try { await navigate(picked.id, picked.url); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } }
      if ((picked.proxied || picked.native) && picked.frameUrl) {
        const snap = await callFrame(picked.id, "snapshot", {}, 8000);
        const picture = snap.ok ? withTargetUrls(snap, picked.proxyOrigin, picked.targetOrigin) : snap;
        return { ok: true, result: { selected: index, url: picked.url, title: picked.title, snapshot: (picture.result as { snapshot?: string } | undefined)?.snapshot } };
      }
      return { ok: true, result: { selected: index, url: picked.url, title: picked.title } };
    }
    setAgentTab(tab.id);
    clearTimeout(agentIdle.current);
    agentIdle.current = setTimeout(() => setAgentTab(undefined), 6000);
    if (command.action === "goto") {
      const url = String(command.args.url ?? "").trim();
      if (!url) return { ok: false, error: "주소가 필요합니다. 예: ao-browser goto 5173" };
      setStatus(t("br.aiOpening", { url }));
      let opened: OpenResult | undefined;
      try { opened = await navigate(tab.id, url); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      if (!opened?.proxied && !opened?.native) return { ok: true, result: { url: opened?.url, controllable: false, note: "외부 사이트라 표시만 되고 AI 조작은 안 됩니다. localhost 개발 서버만 조작할 수 있습니다." } };
      const picture = await pagePicture(tab.id);
      setStatus("");
      if (!picture.ok) return picture;
      const swapped = withTargetUrls(picture, opened.proxyOrigin, opened.targetOrigin);
      return { ok: true, result: { ...(swapped.result as object), url: opened.url, controllable: true } };
    }
    const problem = agentCommandError(tab);
    if (problem) return { ok: false, error: problem };
    if (command.action === "back" || command.action === "forward") {
      if (!go(tab.id, command.action === "back" ? -1 : 1)) return { ok: false, error: command.action === "back" ? "이 탭에서 더 뒤로 갈 페이지가 없습니다." : "앞으로 갈 페이지가 없습니다." };
      const picture = await pagePicture(tab.id);
      return withTargetUrls(picture, tab.proxyOrigin, tab.targetOrigin);
    }
    if (command.action === "reload") { send(tab.id, { type: "reload" }); patch(tab.id, { loading: true }); return withTargetUrls(await pagePicture(tab.id), tab.proxyOrigin, tab.targetOrigin); }
    if (tab.native && command.action === "dialog") {
      // WKUIDelegate dialogs live in Rust: answer the open one, or arm the next one.
      const args = command.args as { accept?: boolean; promptText?: string; invalid?: string };
      if (args.invalid) return { ok: false, error: "대화상자 명령은 accept 또는 dismiss 입니다. 예: ao-browser dialog accept" };
      try {
        const state = await nativeBrowser.dialog(tab.id, "status");
        if (args.accept === undefined) {
          const info = state.dialog ?? state.lastDialog;
          if (!info) return { ok: true, result: { note: "열린 대화상자 없음", armed: state.armed ?? undefined } };
          return { ok: true, result: { dialog: info.kind, open: Boolean(state.dialog), message: info.message, origin: info.origin, accept: info.accepted, note: dialogLines(state).join("\n") } };
        }
        const text = args.promptText ? String(args.promptText) : undefined;
        if (state.dialog) {
          const after = await nativeBrowser.dialog(tab.id, "answer", args.accept !== false, text, "agent");
          patch(tab.id, { dialog: undefined });
          await new Promise((r) => setTimeout(r, 300));
          const snap = await callFrame(tab.id, "snapshot", {}, 8000);
          return { ok: true, result: { answered: after.lastDialog?.kind, accept: args.accept !== false, note: `${after.lastDialog?.kind ?? "대화상자"}에 ${args.accept !== false ? "accept" : "dismiss"}로 답했습니다`, snapshot: (snap.result as { snapshot?: string } | undefined)?.snapshot, url: tab.url } };
        }
        await nativeBrowser.dialog(tab.id, "arm", args.accept !== false, text);
        return { ok: true, result: { armed: args.accept !== false ? "accept" : "dismiss", promptText: text ?? "", note: `다음 alert/confirm/prompt는 ${args.accept !== false ? "accept" : "dismiss"}` } };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (tab.native && command.args.trusted && (command.action === "click" || command.action === "fill" || command.action === "type" || command.action === "press")) {
      const trusted = await trustedInput(tab.id, command.action, command.args);
      if (trusted) return trusted;
      // Real events failed (view hidden, unsupported key…): fall through to the DOM path.
    }
    if (tab.native && command.action === "screenshot" && command.args.full) {
      const until = Date.now() + 2000;
      while (shownTab.current !== tab.id && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const page = await callFrame(tab.id, "fullpage", {}, 6000);
      if (!page.ok) return page;
      const info = page.result as { width: number; height: number; scrollX: number; scrollY: number; url?: string };
      try {
        const image = await nativeBrowser.screenshot(tab.id, { x: 0, y: 0, width: info.width, height: info.height }, true);
        const height = Math.min(info.height, FULL_PAGE_MAX_HEIGHT);
        return { ok: true, result: { image, url: info.url, width: Math.round(info.width), height: Math.round(height), fullPage: true, truncated: info.height > FULL_PAGE_MAX_HEIGHT || undefined, native: true } };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      finally { void callFrame(tab.id, "fullpage", { restore: true, scrollX: info.scrollX, scrollY: info.scrollY }, 3000); }
    }
    if (tab.native && command.action === "screenshot") {
      // Real pixels from WebKit (canvas, video, WebGL, cross-origin images included).
      const until = Date.now() + 2000;
      while (shownTab.current !== tab.id && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const box = await callFrame(tab.id, "rect", command.args, 9000);
      if (!box.ok) return box;
      const info = box.result as { rect: NativeRect; url?: string; innerWidth?: number; innerHeight?: number };
      const targeted = Boolean(command.args.ref || command.args.selector);
      try {
        const image = await nativeBrowser.screenshot(tab.id, targeted ? info.rect : undefined);
        return { ok: true, result: { image, url: info.url, width: Math.round(targeted ? info.rect.width : info.innerWidth ?? 0), height: Math.round(targeted ? info.rect.height : info.innerHeight ?? 0), native: true } };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    const timeout = Math.min(58_000, (Number(command.args.timeout) || 0) + (command.action === "wait" ? 16_000 : command.action === "screenshot" ? 14_000 : command.action === "upload" ? 20_000 : 9_000));
    const result = await callFrame(tab.id, command.action, command.args, timeout);
    if (tab.native && command.action === "status" && result.ok && result.result && typeof result.result === "object") {
      const state = await nativeBrowser.poll(tab.id).catch(() => undefined);
      const list = await nativeBrowser.downloads().catch(() => [] as DownloadInfo[]);
      result.result = { ...(result.result as object), dialog: state?.dialog ?? undefined, downloads: list.length ? downloadsText(list.slice(-5)) : undefined };
    }
    if ((result.result as { navigated?: boolean } | undefined)?.navigated) {
      const picture = await pagePicture(tab.id);
      if (picture.ok) result.result = { ...(result.result as object), ...(picture.result as object) };
    }
    return withTargetUrls(result, tab.proxyOrigin, tab.targetOrigin);
  }, [onOpenChange, navigate, waitReady, callFrame, send, patch, go, applyViewport, pagePicture, tabSummary, closeTab, trustedInput, native]);
  stopAgentRef.current = stopAgent;
  useEffect(() => {
    const el = viewportBox.current;
    if (!el) return;
    const measure = () => setPanelBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (!deviceMenu) return;
    const close = (event: PointerEvent) => { if (!deviceMenuRef.current?.contains(event.target as Node)) setDeviceMenu(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [deviceMenu]);
  useEffect(() => {
    if (!agentTab) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") stopAgent(); };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [agentTab, stopAgent]);
  useEffect(() => {
    // Mouse back/forward buttons over the app chrome (the page's own are forwarded by the picker).
    const handle = (event: Event) => { const delta = (event as CustomEvent<number>).detail; if (isActive() && (delta === -1 || delta === 1)) go(activeRef.current, delta); };
    window.addEventListener("orchestra:browser-nav", handle);
    return () => window.removeEventListener("orchestra:browser-nav", handle);
  }, [go]);
  const runAgentRef = useRef(runAgentCommand);
  runAgentRef.current = runAgentCommand;
  const instanceRef = useRef(instanceId);
  instanceRef.current = instanceId;
  useLayoutEffect(() => {
    const command = takeHeldCommand();
    if (!command?.id) return;
    if (!browserRegistry.isActive(instanceRef.current)) { holdCommand(command); return; }
    if (!claimCommand(command.id)) return;
    void runAgentRef.current(command).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })).then((result) =>
      fetch("/api/browser/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: command.id, ...result }) }).catch(() => undefined));
  }, [instanceId]);
  useEffect(() => {
    const handle = (event: Event) => {
      const command = (event as CustomEvent<AgentCommand & { surface?: string }>).detail;
      if (!command?.id || !browserRegistry.isActive(instanceRef.current) || !claimCommand(command.id)) return;
      void runAgentRef.current(command).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })).then((result) =>
        fetch("/api/browser/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: command.id, ...result }) }).catch(() => undefined));
    };
    window.addEventListener("orchestra:browser-command", handle);
    return () => window.removeEventListener("orchestra:browser-command", handle);
  }, []);

  // Messages from the injected page script: postMessage from proxied iframes, or drained from native tabs.
  const onPageMessage = useCallback((id: string, data: Record<string, unknown>) => {
      if (data.type === "agent-result") { agentPending.current.get(String(data.id))?.({ ok: Boolean(data.ok), result: data.result, error: data.error as string | undefined }); return; }
      if (data.type === "agent-stop") { stopAgentRef.current(); return; }
      const tab = tabsRef.current.find((item) => item.id === id);
      if (data.type === "location" && tab) {
        if (!tab.native) {
          histories.current.set(id, recordLocation(histories.current.get(id) ?? emptyHistory(), String(data.href)));
          setHistoryVersion((v) => v + 1);
        }
        const url = displayUrl(String(data.href), tab.proxyOrigin, tab.targetOrigin);
        if (!/^https?:/.test(url)) return;
        if (url !== tab.url) setRecent((old) => { const next = pushRecent(old, url, String(data.title || "")); localStorage.setItem(RECENT_STORE, JSON.stringify(next)); return next; });
        // Native tabs: loading comes from WebKit (poll), not from the page script.
        patch(id, { url, input: document.activeElement === urlInput.current && id === activeRef.current ? tab.input : url, title: String(data.title || url.replace(/^https?:\/\//, "")), ...(tab.native ? {} : { loading: false }), error: undefined });
      } else if (data.type === "open-tab" && typeof data.href === "string" && /^https?:\/\//.test(data.href)) {
        addTab(data.href);
      } else if (data.type === "focus") {
        browserRegistry.activate(instanceId);
      } else if (data.type === "shortcut") {
        const key = { key: String(data.key), code: String(data.code), metaKey: Boolean(data.metaKey), ctrlKey: Boolean(data.ctrlKey), shiftKey: Boolean(data.shiftKey), altKey: Boolean(data.altKey) };
        if (key.ctrlKey && !key.metaKey && (key.code === "Backquote" || key.key === "`")) { perform({ type: "toggle-terminal" }); return; }
        if (chatShortcut(key)) { window.dispatchEvent(new CustomEvent("orchestra:toggle-chat")); return; }
        const action = globalBrowserShortcut(key) ?? windowShortcut(key) ?? browserShortcut(key);
        if (action) perform(action);
      } else if (data.type === "picking") {
        if (id === activeRef.current) setPicking({ on: Boolean(data.on), count: Number(data.count) || 0 });
      } else if (data.type === "progress") setStatus(String(data.text));
      else if (data.type === "error") setStatus(t("br.error", { text: String(data.text) }));
      else if (data.type === "attachments" && Array.isArray(data.items)) {
        if (tab?.native) void nativeCaptures(id, data.items as ElementCapture[]);
        else void uploadCaptures(data.items as ElementCapture[], typeof data.viewportShot === "string" ? data.viewportShot : undefined);
      }
  }, [patch, perform, uploadCaptures, nativeCaptures, addTab, instanceId]);
  const pageMessageRef = useRef(onPageMessage);
  pageMessageRef.current = onPageMessage;
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      // Trust only our own preview iframes, from their proxy origin (see browser-messages.ts).
      const id = trustedPreviewSender(event, frames.current, tabsRef.current);
      if (id) pageMessageRef.current(id, event.data);
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  // ---- native tabs: keep each WKWebView exactly over the slot, hidden whenever app UI covers it ----
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => {
    if (!native) return;
    let lastKey = "";
    const shown = new Set<string>();
    const reopening = new Set<string>();
    let freezing = false;
    const apply = (id: string, rect: NativeRect | undefined, show: boolean, zoom: number) => {
      if (show) shown.add(id); else shown.delete(id);
      void nativeBrowser.layout(id, rect, show, zoom).then((exists) => {
        const tab = tabsRef.current.find((item) => item.id === id);
        // The view is gone (app reload, StrictMode remount): load the tab's page again.
        if (!exists && show && tab?.url && !reopening.has(id)) { reopening.add(id); void navigate(id, tab.url).catch(() => undefined).finally(() => reopening.delete(id)); lastKey = ""; }
      }).catch(() => undefined);
    };
    const sync = () => {
      if (freezing) return;
      const list = tabsRef.current;
      const tab = list.find((item) => item.id === activeRef.current);
      const el = slot.current;
      // No document.hidden check: an occluded window reports hidden, and agents still need the view laid out.
      const box = openRef.current && tab?.native && el?.isConnected ? el.getBoundingClientRect() : undefined;
      const rect = box ? slotBounds(box, window.innerWidth, window.innerHeight) : undefined;
      const covered = Boolean(rect && isCovered(rect, (x, y) => document.elementFromPoint(x, y), el));
      const visible = Boolean(rect && !covered);
      const choice = viewportRef.current;
      const zoom = choice.mode === "device" && box ? box.width / choice.width : 1;
      const key = `${layoutKey(tab?.id, rect, visible, zoom)}|${list.filter((item) => item.native).map((item) => item.id).join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      if (covered && tab && shown.has(tab.id)) {
        // Keep a still frame under the menu/dialog instead of a blank hole.
        freezing = true;
        const id = tab.id;
        void nativeBrowser.screenshot(id).then((image) => setFrozen({ id, image })).catch(() => undefined).finally(() => { freezing = false; apply(id, undefined, false, zoom); shownTab.current = undefined; lastKey = ""; });
        return;
      }
      for (const item of list) {
        if (!item.native) continue;
        const show = visible && item.id === tab?.id;
        if (!show && !shown.has(item.id)) continue;
        apply(item.id, show ? rect : undefined, show, zoom);
      }
      shownTab.current = visible ? tab?.id : undefined;
      if (visible) setFrozen((old) => (old ? undefined : old));
    };
    const timer = setInterval(sync, 120);
    const observer = new ResizeObserver(sync);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      clearInterval(timer); observer.disconnect();
      window.removeEventListener("resize", sync);
      document.removeEventListener("visibilitychange", sync);
      for (const id of shown) void nativeBrowser.layout(id, undefined, false).catch(() => undefined);
    };
  }, [native, navigate]);
  // ---- native host events: popups become tabs, popups that close themselves go away, downloads ----
  const downloadsActive = useRef(false);
  const refreshDownloads = useCallback(async () => {
    const list = await nativeBrowser.downloads().catch(() => undefined);
    if (!list) return;
    const wasActive = downloadsActive.current;
    downloadsActive.current = list.some((item) => item.state === "starting" || item.state === "downloading");
    setDownloads((old) => {
      for (const item of list) {
        const previous = old.find((entry) => entry.id === item.id);
        if (item.state === "done" && previous && previous.state !== "done") setStatus(t("br.downloadSaved", { name: item.filename ?? item.url }));
      }
      return list;
    });
    if (wasActive && !downloadsActive.current) setDownloadsHidden([]);
  }, []);
  const onHostEvent = useCallback((event: HostEvent) => {
    if (event.type === "popup") {
      // WebKit already created and is loading this view (window.opener intact); just give it a tab.
      const url = /^https?:/.test(event.url) ? event.url : "";
      const tab: Tab = { ...blankTab(), id: event.tab, input: url, url, title: url.replace(/^https?:\/\//, "") || t("br.newTab"), frameUrl: url || "about:blank", native: true, loading: true };
      setTabs((old) => old.some((item) => item.id === tab.id) ? old : [...old, tab]);
      setActiveId(event.tab);
    } else if (event.type === "closed") {
      if (tabsRef.current.some((item) => item.id === event.tab)) closeTab(event.tab);
    } else if (event.type === "download") {
      downloadsActive.current = true;
      setDownloadsHidden([]);
      void refreshDownloads();
    }
  }, [closeTab, refreshDownloads]);
  const hostEventRef = useRef(onHostEvent);
  hostEventRef.current = onHostEvent;
  const answerDialog = useCallback((id: string, accept: boolean) => {
    const text = dialogText;
    patch(id, { dialog: undefined });
    void nativeBrowser.dialog(id, "answer", accept, accept ? text : undefined, "user").catch((error: unknown) => setStatus(String(error)));
    void nativeBrowser.history(id, "focus").catch(() => undefined);
  }, [dialogText, patch]);
  // Poll the visible native tab: WebKit state (url, title, loading, history) plus queued page events.
  useEffect(() => {
    if (!native || !open) return;
    let busy = false;
    const loadingBefore = new Map<string, boolean>();
    const tick = async () => {
      const tab = tabsRef.current.find((item) => item.id === activeRef.current);
      if (busy || !tab?.native || !tab.frameUrl) return;
      busy = true;
      try {
        const owned = tabsRef.current.filter((item) => item.native).map((item) => item.id);
        if (owned.length) for (const event of await nativeBrowser.events(owned).catch(() => [] as HostEvent[])) hostEventRef.current(event);
        if (downloadsActive.current) void refreshDownloads();
        const state = await nativeBrowser.poll(tab.id, true).catch(() => undefined);
        if (!state?.exists) return;
        const dialog = state.dialog ?? undefined;
        const before = tabsRef.current.find((item) => item.id === tab.id)?.dialog;
        if (JSON.stringify(before ?? null) !== JSON.stringify(dialog ?? null)) { patch(tab.id, { dialog }); setDialogText(dialog?.defaultText ?? ""); }
        for (const event of parseEvents(state.events)) pageMessageRef.current(tab.id, event);
        const current = tabsRef.current.find((item) => item.id === tab.id);
        if (!current) return;
        if (state.url && /^https?:/.test(state.url) && (state.url !== current.url || (state.title && state.title !== current.title))) pageMessageRef.current(tab.id, { type: "location", href: state.url, title: state.title });
        if (current.loading !== state.loading || current.canBack !== state.canGoBack || current.canForward !== state.canGoForward) patch(tab.id, { loading: state.loading, canBack: state.canGoBack, canForward: state.canGoForward });
        // A new document lost the page-side emulation (touch, viewport lock): send it again.
        if (loadingBefore.get(tab.id) && !state.loading && viewportRef.current.mode === "device") void nativeBrowser.send(tab.id, { type: "emulate", ...emulationPayload(viewportRef.current), persist: true });
        loadingBefore.set(tab.id, state.loading);
      } finally { busy = false; }
    };
    const timer = setInterval(() => void tick(), 300);
    void tick();
    return () => clearInterval(timer);
  }, [native, open, patch, refreshDownloads]);
  // Native views live outside React: close them when this panel goes away (desktop window closed).
  useEffect(() => () => { for (const tab of tabsRef.current) if (tab.native) void nativeBrowser.close(tab.id).catch(() => undefined); }, []);

  useEffect(() => { setPicking({ on: false, count: 0 }); }, [activeId]);
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); }, [status]);

  return (
    <aside ref={panel} className="browser-panel glass browser-v-floating" hidden={!open} aria-label={t("br.label")}
      onPointerDownCapture={() => browserRegistry.activate(instanceId)} onFocusCapture={() => browserRegistry.activate(instanceId)}>
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <div key={tab.id} role="tab" tabIndex={tab.id === active.id ? 0 : -1} aria-selected={tab.id === active.id} className={`browser-tab${tab.id === active.id ? " active" : ""}`} onClick={() => setActiveId(tab.id)} title={`${tab.title}${index < 9 ? ` (⌘${index + 1})` : ""}`}
            onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); setActiveId(tab.id); }}
            onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}>
            {tab.id === agentTab ? <Bot size={13} className="browser-ai-icon" /> : tab.loading ? <RotateCw size={13} className="spin" /> : <Globe size={13} />}
            <span>{tab.title || t("br.newTab")}</span>
            {tab.id === agentTab && <em className="browser-ai-badge">{t("br.aiControlling")}</em>}
            <button type="button" aria-label={t("br.closeTab")} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X size={13} /></button>
          </div>
        ))}
        <button type="button" className="browser-icon" aria-label={t("br.newTabShortcut")} title={t("br.newTabShortcut")} onClick={() => addTab()}><Plus size={16} /></button>
        <span className="browser-tabs-spacer" />
      </div>
      <form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); const id = active.id; void navigate(id, active.input).then((opened) => { if (opened?.native) void nativeBrowser.history(id, "focus").catch(() => undefined); }).catch(() => undefined); frames.current.get(id)?.focus(); }}>
        <button type="button" className="browser-icon" aria-label={t("br.back")} title={t("br.back")} disabled={active.native ? !active.canBack : !active.proxied || !canGo(histories.current.get(active.id), -1)} onClick={() => go(active.id, -1)}><ArrowLeft size={17} /></button>
        <button type="button" className="browser-icon" aria-label={t("br.forward")} title={t("br.forward")} disabled={active.native ? !active.canForward : !active.proxied || !canGo(histories.current.get(active.id), 1)} onClick={() => go(active.id, 1)}><ArrowRight size={17} /></button>
        <button type="button" className="browser-icon" aria-label={t("br.reload")} title={t("br.reload")} disabled={!active.frameUrl} onClick={reload}><RotateCw size={16} /></button>
        <input ref={urlInput} className="browser-url" aria-label={t("br.address")} value={active.input} spellCheck={false} placeholder={t("br.addressPlaceholder")}
          onChange={(event) => patch(active.id, { input: event.target.value })}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Escape") { patch(active.id, { input: active.url }); event.currentTarget.blur(); event.stopPropagation(); } }} />
        <div className="browser-device-wrap" ref={deviceMenuRef}>
          <button type="button" className={`browser-device-toggle${viewport.mode === "device" ? " on" : ""}`} aria-pressed={viewport.mode === "device"} title={viewport.mode === "device" ? t("br.appScreen", { w: viewport.width, h: viewport.height }) : t("br.desktopWeb")} onClick={() => applyViewport(toggleViewport(viewport))}>
            {viewport.mode === "device" ? <Smartphone size={16} /> : <Monitor size={16} />}
            <span>{viewportLabel(viewport)}</span>
          </button>
          <button type="button" className="browser-icon" aria-label={t("br.screenSize")} aria-expanded={deviceMenu} title={t("br.screenSizeTitle")} onClick={() => { setCustomSize({ w: String(viewport.width), h: String(viewport.height) }); setDeviceMenu((openMenu) => !openMenu); }}><ChevronDown size={15} /></button>
          {deviceMenu && <div className="browser-device-menu" role="menu">
            {([
              ["iphone", "iPhone 390×844"],
              ["tablet", t("br.tabletSize")],
              ["desktop", t("br.desktopFull")],
            ] as const).map(([preset, label]) => {
              const choice = parseViewportArg(preset, viewport);
              const checked = !isViewportError(choice) && (preset === "desktop" ? viewport.mode === "desktop" : viewport.mode === "device" && viewport.preset === preset);
              return <button type="button" role="menuitemradio" aria-checked={checked} key={preset} onClick={() => { if (!isViewportError(choice)) applyViewport(choice); setDeviceMenu(false); }}>{label}</button>;
            })}
            <div className="browser-device-custom">
              <span>{t("br.custom")}</span>
              <input aria-label={t("br.width")} inputMode="numeric" value={customSize.w} onChange={(event) => setCustomSize((old) => ({ ...old, w: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }} />
              <span>×</span>
              <input aria-label={t("br.height")} inputMode="numeric" value={customSize.h} onChange={(event) => setCustomSize((old) => ({ ...old, h: event.target.value }))} onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                const choice = parseViewportArg(`${customSize.w}x${customSize.h}`);
                if (isViewportError(choice)) { setStatus(choice.error); return; }
                applyViewport(choice);
                setDeviceMenu(false);
              }} />
              <button type="button" onClick={() => {
                const choice = parseViewportArg(`${customSize.w}x${customSize.h}`);
                if (isViewportError(choice)) { setStatus(choice.error); return; }
                applyViewport(choice);
                setDeviceMenu(false);
              }}>{t("br.apply")}</button>
            </div>
          </div>}
        </div>
        <button type="button" className="browser-icon" aria-label={t("br.devtools")} title={t("br.devtoolsTitle")} onClick={(event) => openDevtools(event.shiftKey)}><SquareCode size={16} /></button>
        <button type="button" className={`browser-pick${picking.on ? " on" : ""}`} aria-pressed={picking.on} title={t("br.pickTitle")} onClick={() => togglePicker()}>
          <MousePointerClick size={16} />{picking.on ? (picking.count ? t("br.pickedN", { n: picking.count }) : t("br.picking")) : t("br.pick")}
        </button>
        {picking.on && picking.count > 0 && <button type="button" className="browser-attach" onClick={() => send(active.id, { type: "attach" })}>{t("br.attachToChat")}</button>}
      </form>
      {agentTab && <div className="browser-ai-bar" role="status"><Bot size={15} /><span>{t("br.aiBar")}</span><button type="button" onClick={stopAgent}><Square size={12} />{t("br.stopEsc")}</button></div>}
      {status && <div className="browser-status" role="status">{status}</div>}
      {active.native && active.dialog && (
        <form className="browser-dialog" role="alertdialog" aria-label={t("br.dialogFrom", { origin: active.dialog.origin })}
          onSubmit={(event) => { event.preventDefault(); answerDialog(active.id, true); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); answerDialog(active.id, false); } }}>
          <div className="browser-dialog-text"><small>{t("br.dialogFrom", { origin: active.dialog.origin })}</small><p>{active.dialog.message}</p></div>
          {active.dialog.kind === "prompt" && <input autoFocus aria-label={t("br.dialogInput")} value={dialogText} onChange={(event) => setDialogText(event.target.value)} />}
          <div className="browser-dialog-actions">
            {active.dialog.kind !== "alert" && <button type="button" onClick={() => answerDialog(active.id, false)}>{t("br.dialogCancel")}</button>}
            <button type="submit" className="primary" autoFocus={active.dialog.kind !== "prompt"}>{t("br.dialogOk")}</button>
          </div>
        </form>
      )}
      {native && downloads.some((item) => !downloadsHidden.includes(item.id)) && (
        <div className="browser-downloads" role="status" aria-label={t("br.downloads")}>
          {downloads.filter((item) => !downloadsHidden.includes(item.id)).slice(-3).map((item) => {
            const progress = downloadProgress(item);
            const busy = item.state === "starting" || item.state === "downloading";
            return (
              <div key={item.id} className={`browser-download ${item.state}`} title={item.path ?? item.url}>
                <Download size={14} />
                <span className="browser-download-name">{item.filename ?? item.url}</span>
                <span className="browser-download-meta">{busy ? `${progress != null ? `${Math.round(progress * 100)}% · ` : ""}${formatBytes(item.received)}` : item.state === "done" ? `${item.needsReview ? t("br.downloadReview") : t("br.downloadDone")} · ${formatBytes(item.total || item.received)}` : item.state === "canceled" ? t("br.downloadCanceled") : t("br.downloadFailed")}</span>
                {busy && <progress max={1} value={progress ?? undefined} />}
                {busy && <button type="button" className="browser-icon" aria-label={t("br.downloadCancel")} title={t("br.downloadCancel")} onClick={() => void nativeBrowser.downloads(item.id).then(setDownloads).catch(() => undefined)}><X size={13} /></button>}
              </div>
            );
          })}
          <button type="button" className="browser-icon" aria-label={t("br.downloadsHide")} title={t("br.downloadsHide")} onClick={() => setDownloadsHidden(downloads.map((item) => item.id))}><X size={14} /></button>
        </div>
      )}
      <div ref={viewportBox} className={`browser-viewport${viewport.mode === "device" && active.frameUrl ? " framed" : ""}`} style={viewport.mode === "device" ? { "--ao-w": `${viewport.width}px`, "--ao-h": `${viewport.height}px`, "--ao-zoom": String(fitDevice(viewport.width, viewport.height, panelBox.w, panelBox.h).scale) } as CSSProperties : undefined}>
        {tabs.map((tab) => tab.native && tab.frameUrl ? (tab.id === active.id ? (
          // The native WKWebView is positioned over this slot; it shows a still frame while app UI covers it.
          <div key={`${tab.id}:native`} ref={slot} className="browser-frame browser-native-slot" aria-label={tab.title}
            style={frozen?.id === tab.id ? { backgroundImage: `url(${frozen.image})`, backgroundSize: "100% 100%" } : undefined} />
        ) : null) : tab.frameUrl ? (
          <iframe key={`${tab.id}:${tab.nonce}:${tab.frameUrl}`} ref={(el) => { if (el) frames.current.set(tab.id, el); }} className="browser-frame" hidden={tab.id !== active.id}
            src={tab.frameUrl} title={tab.title} onLoad={() => {
              const payload = emulationPayload(viewportRef.current);
              const bootKey = `${tab.id}:${tab.frameUrl}`;
              if (tab.proxied && payload.mobile && !emuBoot.current.has(bootKey)) {
                emuBoot.current.add(bootKey);
                send(tab.id, { type: "emulate", ...payload, persist: true });
                send(tab.id, { type: "reload" });
                return;
              }
              patch(tab.id, { loading: false });
              if (tab.proxied) {
                send(tab.id, { type: "ping" });
                send(tab.id, { type: "emulate", ...payload, persist: true });
              }
            }}
            sandbox={IFRAME_SANDBOX} allow="clipboard-read; clipboard-write; fullscreen" />
        ) : null)}
        {viewport.mode === "device" && active.frameUrl && <div className="browser-device-caption">{viewport.width}×{viewport.height}{emulationOf(viewport).touch ? t("br.touch") : ""}</div>}
        {!active.frameUrl && (
          <div className="browser-start">
            {active.error && <p className="browser-error" role="alert">{active.error}</p>}
            <h3><Server size={18} />{t("br.devServers")} <button type="button" className="browser-icon" aria-label={t("br.rescan")} onClick={refreshPorts}><RefreshCw size={15} /></button></h3>
            {ports.length ? <div className="browser-ports">{ports.map((port) => (
              <button type="button" key={port.port} onClick={() => void navigate(active.id, port.url).catch(() => undefined)}><b>localhost:{port.port}</b><small>{port.command}</small></button>
            ))}</div> : <p className="muted">{t("br.noServers")}</p>}
            {recent.length > 0 && <><h3>{t("br.recent")}</h3><div className="browser-recent">{recent.map((site) => (
              <button type="button" key={site.url} onClick={() => void navigate(active.id, site.url).catch(() => undefined)} title={site.url}>
                <span className="browser-recent-icon">{/localhost|127\.0\.0\.1/.test(site.url) ? <Server size={18} /> : <Globe size={18} />}</span>
                <b>{site.title}</b><small>{site.url.replace(/^https?:\/\//, "")}</small>
              </button>))}</div></>}
            {closed.length > 0 && <><h3>{t("br.recentlyClosed")}</h3><div className="browser-ports">{[...closed].reverse().slice(0, 6).map((url) => <button type="button" key={url} onClick={() => void navigate(active.id, url).catch(() => undefined)}><b>{url.replace(/^https?:\/\//, "")}</b></button>)}</div></>}
            <p className="browser-help">{t("br.help")}</p>
          </div>
        )}
        {active.frameUrl && !active.proxied && !active.native && <div className="browser-external-note">{t("br.externalNote")}</div>}
      </div>
    </aside>
  );
}
