import { canGo, emptyHistory, recordLocation, traverse, type TabHistory } from "./tab-history";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, ChevronDown, Globe, Monitor, MousePointerClick, Plus, RefreshCw, RotateCw, Server, Smartphone, Square, SquareCode, X } from "lucide-react";
import { pushRecent, RECENT_STORE, type RecentSite } from "./browser-surface";
import { emulationOf, emulationPayload, fitDevice, isViewportError, parseViewportArg, readViewport, serializeViewport, toggleViewport, VIEWPORT_STORE, viewportLabel, type ViewportChoice } from "./browser-viewport";
import { browserRegistry } from "./browser-registry";
import { OWN_APP_ERROR, agentCommandError, claimCommand, commandTargetsOwnApp, holdCommand, replayCommand, takeHeldCommand, withTargetUrls, type AgentCommand } from "./browser-agent";
import { browserOwnsFocus, browserShortcut, chatShortcut, globalBrowserShortcut, windowShortcut, type BrowserAction } from "./browser-shortcuts";
import { attachmentLabel, displayUrl, type ComposerAttachment, type ElementCapture } from "./preview-attachments";
import { toggleTerminal } from "./terminal-events";
import { IFRAME_SANDBOX, previewTargetOrigin, trustedPreviewSender } from "./browser-messages";

type Tab = {
  id: string; input: string; url: string; title: string; frameUrl?: string; proxied?: boolean;
  proxyOrigin?: string; targetOrigin?: string; loading?: boolean; error?: string; nonce: number;
};
type Port = { port: number; command: string; url: string };
type OpenResult = { url: string; frameUrl: string; proxied: boolean; proxyOrigin?: string; targetOrigin?: string };

const BASE_STORE = "orchestra.browser.tabs";
const newId = () => Math.random().toString(36).slice(2, 10);
const blankTab = (): Tab => ({ id: newId(), input: "", url: "", title: "새 탭", nonce: 0 });

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
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
  const ownsFocus = () => browserOwnsFocus() || browserRegistry.desktopFocused();
  const [recent, setRecent] = useState<RecentSite[]>(() => { try { const list = JSON.parse(localStorage.getItem(RECENT_STORE) ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; } });
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
      if (Array.isArray(saved?.tabs) && saved.tabs.length) return saved.tabs.map((tab: { url?: string; title?: string }) => ({ ...blankTab(), input: tab.url ?? "", url: tab.url ?? "", title: tab.title || "새 탭" }));
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
  }, [patch]);

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
      if (!tab.proxied || !tab.frameUrl) continue;
      send(tab.id, { type: "emulate", ...next, persist: true });
      if (reload) { emuBoot.current.add(`${tab.id}:${tab.frameUrl}`); send(tab.id, { type: "reload" }); patch(tab.id, { loading: true }); }
    }
  }, [patch, send]);
  /** Back/forward only inside the tab: replace the iframe location with the tracked entry. */
  const go = useCallback((id: string, delta: -1 | 1) => {
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
    if (tab.proxied) send(tab.id, { type: "reload" });
    else patch(tab.id, { nonce: tab.nonce + 1 });
    patch(tab.id, { loading: true });
  }, [patch, send]);

  const togglePicker = useCallback((force?: boolean) => {
    onOpenChange(true);
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    if (!tab?.frameUrl) { setStatus("먼저 페이지를 여세요."); return; }
    if (!tab.proxied) { setStatus("요소 선택은 localhost 개발 서버 페이지에서만 됩니다."); return; }
    const on = force ?? !picking.on;
    send(tab.id, { type: "pick", on });
    frames.current.get(tab.id)?.focus();
  }, [onOpenChange, picking.on, send]);

  const openDevtools = useCallback((native: boolean) => {
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (native || !tab?.proxied) {
      if (internals) void internals.invoke("open_devtools").catch(() => undefined);
      else setStatus("앱 검사기는 데스크톱 앱에서만 열립니다 (우클릭 → 요소 검사도 가능).");
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
        if (open && browserOwnsFocus()) perform({ type: "reload" });
        else if (Date.now() - (lastAction.current.reload ?? 0) > 500) window.location.reload();
      },
      closeTab: () => { if (open && ownsFocus()) perform({ type: "close-tab" }); },
    }, w);
  }, [open, perform]);

  const uploadCaptures = useCallback(async (items: ElementCapture[], viewportShot?: string) => {
    const images = [viewportShot ?? "", ...items.map((item) => item.screenshot ?? "")];
    let paths: (string | null)[] = [];
    try { paths = (await post<{ paths: (string | null)[] }>("/preview/assets", { images })).paths; }
    catch (error) { setStatus(`캡처 저장 실패: ${error instanceof Error ? error.message : String(error)}`); }
    const viewportPath = paths[0] ?? undefined;
    const tab = tabsRef.current.find((item) => item.id === activeRef.current);
    const attachments: ComposerAttachment[] = items.map((item, index) => {
      const { screenshot, ...element } = item;
      element.url = displayUrl(element.url, tab?.proxyOrigin, tab?.targetOrigin);
      return { id: newId(), kind: "element", label: attachmentLabel(item), preview: screenshot ?? viewportShot, screenshotPath: paths[index + 1] ?? undefined, viewportPath, element };
    });
    onAttach(attachments);
    setStatus(`요소 ${attachments.length}개를 채팅에 첨부했습니다.`);
    onNotice?.(`요소 ${attachments.length}개 첨부됨`);
  }, [onAttach, onNotice]);

  const stopAgentRef = useRef<() => void>(() => undefined);
  // ---- AI agent control (ao-browser) ----
  const [agentTab, setAgentTab] = useState<string>();
  const agentPending = useRef(new Map<string, (value: { ok: boolean; result?: unknown; error?: string }) => void>());
  const stoppedUntil = useRef(0);
  const agentIdle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const callFrame = useCallback((id: string, action: string, args: Record<string, unknown>, timeout = 9000) => new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
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
      if (tab && !tab.loading && tab.frameUrl) {
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
    setStatus("AI 조작을 중지했습니다. 1분 동안 AI 명령을 막습니다.");
  }, [agentTab, send]);
  const tabSummary = useCallback((activeTabId: string) => tabsRef.current.map((item, index) => ({ index: index + 1, active: item.id === activeTabId, url: item.url, title: item.title, controllable: Boolean(item.proxied) })), []);
  const pagePicture = useCallback(async (id: string) => {
    const ready = await waitReady(id);
    if (!ready.ok) return ready;
    const idle = await callFrame(id, "networkidle", {}, 6000);
    const snap = await callFrame(id, "snapshot", {}, 8000);
    const idleResult = idle.ok ? idle.result as { idle?: boolean; pending?: number } : undefined;
    const shot = snap.ok ? snap.result as { snapshot?: string; title?: string } : undefined;
    return { ok: true as const, result: { url: (ready.result as { url?: string })?.url, title: (ready.result as { title?: string })?.title ?? shot?.title, networkIdle: idleResult ? idleResult.idle !== false : undefined, pending: idleResult?.pending, snapshot: shot?.snapshot } };
  }, [waitReady, callFrame]);
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
        if (!opened?.proxied) return { ok: true, result: { created: true, index: list.length + 1, url: opened?.url, controllable: false, note: "외부 사이트라 표시만 되고 AI 조작은 안 됩니다. localhost 개발 서버만 조작할 수 있습니다." } };
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
      if (picked.proxied && picked.frameUrl) {
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
      setStatus(`AI가 ${url} 여는 중…`);
      let opened: OpenResult | undefined;
      try { opened = await navigate(tab.id, url); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      if (!opened?.proxied) return { ok: true, result: { url: opened?.url, controllable: false, note: "외부 사이트라 표시만 되고 AI 조작은 안 됩니다. localhost 개발 서버만 조작할 수 있습니다." } };
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
    const timeout = Math.min(58_000, (Number(command.args.timeout) || 0) + (command.action === "wait" ? 16_000 : command.action === "screenshot" ? 14_000 : command.action === "upload" ? 20_000 : 9_000));
    const result = await callFrame(tab.id, command.action, command.args, timeout);
    if ((result.result as { navigated?: boolean } | undefined)?.navigated) {
      const picture = await pagePicture(tab.id);
      if (picture.ok) result.result = { ...(result.result as object), ...(picture.result as object) };
    }
    return withTargetUrls(result, tab.proxyOrigin, tab.targetOrigin);
  }, [onOpenChange, navigate, waitReady, callFrame, send, patch, go, applyViewport, pagePicture, tabSummary, closeTab]);
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

  // Messages from the injected page script.
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      // Trust only our own preview iframes, from their proxy origin (see browser-messages.ts).
      const id = trustedPreviewSender(event, frames.current, tabsRef.current);
      if (!id) return;
      const data = event.data;
      if (data.type === "agent-result") { agentPending.current.get(String(data.id))?.({ ok: Boolean(data.ok), result: data.result, error: data.error }); return; }
      if (data.type === "agent-stop") { stopAgentRef.current(); return; }
      const tab = tabsRef.current.find((item) => item.id === id);
      if (data.type === "location" && tab) {
        histories.current.set(id, recordLocation(histories.current.get(id) ?? emptyHistory(), data.href));
        setHistoryVersion((v) => v + 1);
        const url = displayUrl(String(data.href), tab.proxyOrigin, tab.targetOrigin);
        if (!/^about:/.test(url)) setRecent((old) => { const next = pushRecent(old, url, String(data.title || "")); localStorage.setItem(RECENT_STORE, JSON.stringify(next)); return next; });
        patch(id, { url, input: document.activeElement === urlInput.current && id === activeRef.current ? tab.input : url, title: String(data.title || url.replace(/^https?:\/\//, "")), loading: false, error: undefined });
      } else if (data.type === "shortcut") {
        const key = { key: String(data.key), code: String(data.code), metaKey: Boolean(data.metaKey), ctrlKey: Boolean(data.ctrlKey), shiftKey: Boolean(data.shiftKey), altKey: Boolean(data.altKey) };
        if (key.ctrlKey && !key.metaKey && (key.code === "Backquote" || key.key === "`")) { perform({ type: "toggle-terminal" }); return; }
        if (chatShortcut(key)) { window.dispatchEvent(new CustomEvent("orchestra:toggle-chat")); return; }
        const action = globalBrowserShortcut(key) ?? windowShortcut(key) ?? browserShortcut(key);
        if (action) perform(action);
      } else if (data.type === "picking") {
        if (id === activeRef.current) setPicking({ on: Boolean(data.on), count: Number(data.count) || 0 });
      } else if (data.type === "progress") setStatus(String(data.text));
      else if (data.type === "error") setStatus(`오류: ${String(data.text)}`);
      else if (data.type === "attachments" && Array.isArray(data.items)) void uploadCaptures(data.items as ElementCapture[], typeof data.viewportShot === "string" ? data.viewportShot : undefined);
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [patch, perform, uploadCaptures]);

  useEffect(() => { setPicking({ on: false, count: 0 }); }, [activeId]);
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); }, [status]);

  return (
    <aside ref={panel} className="browser-panel glass browser-v-floating" hidden={!open} aria-label="브라우저"
      onPointerDownCapture={() => browserRegistry.activate(instanceId)} onFocusCapture={() => browserRegistry.activate(instanceId)}>
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <div key={tab.id} role="tab" tabIndex={tab.id === active.id ? 0 : -1} aria-selected={tab.id === active.id} className={`browser-tab${tab.id === active.id ? " active" : ""}`} onClick={() => setActiveId(tab.id)} title={`${tab.title}${index < 9 ? ` (⌘${index + 1})` : ""}`}
            onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); setActiveId(tab.id); }}
            onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}>
            {tab.id === agentTab ? <Bot size={13} className="browser-ai-icon" /> : tab.loading ? <RotateCw size={13} className="spin" /> : <Globe size={13} />}
            <span>{tab.title || "새 탭"}</span>
            {tab.id === agentTab && <em className="browser-ai-badge">AI 조작 중</em>}
            <button type="button" aria-label="탭 닫기" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X size={13} /></button>
          </div>
        ))}
        <button type="button" className="browser-icon" aria-label="새 탭 (⌘T)" title="새 탭 (⌘T)" onClick={() => addTab()}><Plus size={16} /></button>
        <span className="browser-tabs-spacer" />
      </div>
      <form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); void navigate(active.id, active.input).catch(() => undefined); frames.current.get(active.id)?.focus(); }}>
        <button type="button" className="browser-icon" aria-label="뒤로 (⌘[)" title="뒤로 (⌘[)" disabled={!active.proxied || !canGo(histories.current.get(active.id), -1)} onClick={() => go(active.id, -1)}><ArrowLeft size={17} /></button>
        <button type="button" className="browser-icon" aria-label="앞으로 (⌘])" title="앞으로 (⌘])" disabled={!active.proxied || !canGo(histories.current.get(active.id), 1)} onClick={() => go(active.id, 1)}><ArrowRight size={17} /></button>
        <button type="button" className="browser-icon" aria-label="새로고침 (⌘R)" title="새로고침 (⌘R)" disabled={!active.frameUrl} onClick={reload}><RotateCw size={16} /></button>
        <input ref={urlInput} className="browser-url" aria-label="주소" value={active.input} spellCheck={false} placeholder="주소 또는 포트 번호 (예: 3000)  ⌘L"
          onChange={(event) => patch(active.id, { input: event.target.value })}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Escape") { patch(active.id, { input: active.url }); event.currentTarget.blur(); event.stopPropagation(); } }} />
        <div className="browser-device-wrap" ref={deviceMenuRef}>
          <button type="button" className={`browser-device-toggle${viewport.mode === "device" ? " on" : ""}`} aria-pressed={viewport.mode === "device"} title={viewport.mode === "device" ? `앱 화면 ${viewport.width}×${viewport.height}` : "데스크톱 웹 화면"} onClick={() => applyViewport(toggleViewport(viewport))}>
            {viewport.mode === "device" ? <Smartphone size={16} /> : <Monitor size={16} />}
            <span>{viewportLabel(viewport)}</span>
          </button>
          <button type="button" className="browser-icon" aria-label="화면 크기" aria-expanded={deviceMenu} title="iPhone, 태블릿, 데스크톱, 사용자 지정" onClick={() => { setCustomSize({ w: String(viewport.width), h: String(viewport.height) }); setDeviceMenu((openMenu) => !openMenu); }}><ChevronDown size={15} /></button>
          {deviceMenu && <div className="browser-device-menu" role="menu">
            {([
              ["iphone", "iPhone 390×844"],
              ["tablet", "태블릿 768×1024"],
              ["desktop", "데스크톱 전체 폭"],
            ] as const).map(([preset, label]) => {
              const choice = parseViewportArg(preset, viewport);
              const checked = !isViewportError(choice) && (preset === "desktop" ? viewport.mode === "desktop" : viewport.mode === "device" && viewport.preset === preset);
              return <button type="button" role="menuitemradio" aria-checked={checked} key={preset} onClick={() => { if (!isViewportError(choice)) applyViewport(choice); setDeviceMenu(false); }}>{label}</button>;
            })}
            <div className="browser-device-custom">
              <span>사용자 지정</span>
              <input aria-label="너비" inputMode="numeric" value={customSize.w} onChange={(event) => setCustomSize((old) => ({ ...old, w: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }} />
              <span>×</span>
              <input aria-label="높이" inputMode="numeric" value={customSize.h} onChange={(event) => setCustomSize((old) => ({ ...old, h: event.target.value }))} onKeyDown={(event) => {
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
              }}>적용</button>
            </div>
          </div>}
        </div>
        <button type="button" className="browser-icon" aria-label="개발자 도구 (⌥⌘I)" title="개발자 도구 (⌥⌘I) · ⇧클릭: 앱 검사기" onClick={(event) => openDevtools(event.shiftKey)}><SquareCode size={16} /></button>
        <button type="button" className={`browser-pick${picking.on ? " on" : ""}`} aria-pressed={picking.on} title="요소 선택 (⌘⇧C)" onClick={() => togglePicker()}>
          <MousePointerClick size={16} />{picking.on ? (picking.count ? `${picking.count}개 선택` : "선택 중") : "요소 선택"}
        </button>
        {picking.on && picking.count > 0 && <button type="button" className="browser-attach" onClick={() => send(active.id, { type: "attach" })}>채팅에 첨부</button>}
      </form>
      {agentTab && <div className="browser-ai-bar" role="status"><Bot size={15} /><span>AI가 이 탭을 조작하고 있어요</span><button type="button" onClick={stopAgent}><Square size={12} />중지 (Esc)</button></div>}
      {status && <div className="browser-status" role="status">{status}</div>}
      <div ref={viewportBox} className={`browser-viewport${viewport.mode === "device" && active.frameUrl ? " framed" : ""}`} style={viewport.mode === "device" ? { "--ao-w": `${viewport.width}px`, "--ao-h": `${viewport.height}px`, "--ao-zoom": String(fitDevice(viewport.width, viewport.height, panelBox.w, panelBox.h).scale) } as CSSProperties : undefined}>
        {tabs.map((tab) => tab.frameUrl ? (
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
        {viewport.mode === "device" && active.frameUrl && <div className="browser-device-caption">{viewport.width}×{viewport.height}{emulationOf(viewport).touch ? " · 터치" : ""}</div>}
        {!active.frameUrl && (
          <div className="browser-start">
            {active.error && <p className="browser-error" role="alert">{active.error}</p>}
            <h3><Server size={18} />실행 중인 개발 서버 <button type="button" className="browser-icon" aria-label="다시 찾기" onClick={refreshPorts}><RefreshCw size={15} /></button></h3>
            {ports.length ? <div className="browser-ports">{ports.map((port) => (
              <button type="button" key={port.port} onClick={() => void navigate(active.id, port.url).catch(() => undefined)}><b>localhost:{port.port}</b><small>{port.command}</small></button>
            ))}</div> : <p className="muted">찾은 개발 서버가 없습니다. 터미널(⌃`)에서 `npm run dev`를 실행하거나 위에 주소를 입력하세요.</p>}
            {recent.length > 0 && <><h3>최근 방문</h3><div className="browser-recent">{recent.map((site) => (
              <button type="button" key={site.url} onClick={() => void navigate(active.id, site.url).catch(() => undefined)} title={site.url}>
                <span className="browser-recent-icon">{/localhost|127\.0\.0\.1/.test(site.url) ? <Server size={18} /> : <Globe size={18} />}</span>
                <b>{site.title}</b><small>{site.url.replace(/^https?:\/\//, "")}</small>
              </button>))}</div></>}
            {closed.length > 0 && <><h3>최근 닫은 탭 (⌘⇧T)</h3><div className="browser-ports">{[...closed].reverse().slice(0, 6).map((url) => <button type="button" key={url} onClick={() => void navigate(active.id, url).catch(() => undefined)}><b>{url.replace(/^https?:\/\//, "")}</b></button>)}</div></>}
            <p className="browser-help">⌘T 새 탭 · ⌘W 탭 닫기 · ⌘⇧T 닫은 탭 다시 열기 · ⌘L 주소창 · ⌘R 새로고침 · ⌃Tab 탭 이동 · ⌘1–9 탭 선택 · ⌘⇧C 요소 선택 · ⌥⌘I 개발자 도구 · ⌘⇧B 브라우저 열기/닫기</p>
          </div>
        )}
        {active.frameUrl && !active.proxied && <div className="browser-external-note">외부 사이트는 요소 선택이 안 되고, 일부 사이트는 앱 안에 표시되지 않을 수 있습니다.</div>}
      </div>
    </aside>
  );
}
