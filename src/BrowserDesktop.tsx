import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe, Maximize2, Minimize2, Minus, PanelLeft, PanelRight, Plus, X } from "lucide-react";
import { BrowserPanel } from "./BrowserPanel";
import { browserRegistry } from "./browser-registry";
import { windowShortcut } from "./browser-shortcuts";
import { applySnap, clampPosition, clampSnapWidth, desktopMode, desktopStoreKey, frameOf, loadWorkspaceWindows, newWindow, resizeWindow, SPLIT_DEFAULT, SPLIT_MIN_BROWSER, SPLIT_MIN_CHAT, topZ, type DeskLayout, type DesktopMode, type DesktopWindow, type Edge, type Snap } from "./desktop-windows";
import { setDeskSplit, useDeskSplit } from "./desktop-split";
import { DOCK_EVENT, forgetOutside, lostOutside, openBrowserWindow, OUTSIDE_GRACE_MS, rememberedOutside, rememberOutside, stillOpening, useOutsideReport, useOutsideWindows, type BrowserWindowTarget } from "./browser-window";
import type { ComposerAttachment } from "./preview-attachments";
import { t } from "./i18n";

const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const newId = () => Math.random().toString(36).slice(2, 10);

export type DesktopRequest = { n: number; toggle?: boolean };
type Props = {
  workspaceId: string; firstWorkspace: boolean; onAttach: (items: ComposerAttachment[]) => void; request: DesktopRequest; onModeChange: (mode: DesktopMode, browserWidth: number) => void;
  /** The user is in another workspace: the windows stay alive, out of sight, for this workspace's agents. */
  background?: boolean;
  /** Room the workspace on screen keeps for its docked sidebar, terminal and folded chat. */
  room?: { left: number; bottom: number; chatCollapsed: boolean; chatBeside: boolean };
};
const NO_ROOM = { left: 0, bottom: 0, chatCollapsed: false, chatBeside: false };

/** Browser windows floating over the workspace (the only browser layout). */
export function BrowserDesktop({ workspaceId, firstWorkspace, onAttach, request, onModeChange, background = false, room = NO_ROOM }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const split = useDeskSplit();
  const layout = useMemo<DeskLayout>(() => ({ left: room.left, bottom: room.bottom, chatCollapsed: room.chatCollapsed, chatBeside: room.chatBeside, split }), [room.left, room.bottom, room.chatCollapsed, room.chatBeside, split]);
  const [windows, setWindows] = useState<DesktopWindow[]>(() => loadWorkspaceWindows((key) => localStorage.getItem(key), workspaceId, firstWorkspace));
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const sizeRef = useRef(size); sizeRef.current = size;
  const [, force] = useState(0);
  useEffect(() => browserRegistry.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => { localStorage.setItem(desktopStoreKey(workspaceId), JSON.stringify(windows)); }, [windows, workspaceId]);
  const mode = desktopMode(windows);
  // The window the chat sits beside, and on which side of the chat it is: the snapped one on top (the
  // same one desktopMode picked), or the maximized one while the chat is open beside it.
  const side: "left" | "right" | undefined = mode === "max" ? (layout.chatBeside ? "left" : undefined) : mode === "none" ? undefined : mode;
  const splitWindow = side ? windows.filter((w) => !w.minimized && (mode === "max" ? w.maximized : !w.maximized && w.snap === mode)).sort((a, b) => b.z - a.z)[0] : undefined;
  const splitFrame = splitWindow ? frameOf(splitWindow, size, layout) : undefined;
  const browserWidth = splitFrame?.w ?? 0;
  // Layout, not a passive effect: the chat's margin must follow the window's width in the same frame.
  useLayoutEffect(() => { if (!background) onModeChange(mode, browserWidth); }, [mode, browserWidth, onModeChange, background]);
  // Requests come from whichever source drives this desktop now (the workspace on screen, or an
  // agent while it is off screen): each request object is acted on once, so switching sources
  // never replays an old one.
  const handled = useRef(new WeakSet<DesktopRequest>());
  useEffect(() => {
    const measure = () => { if (area.current) setSize({ width: area.current.clientWidth, height: area.current.clientHeight }); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (area.current) observer?.observe(area.current);
    return () => observer?.disconnect();
  }, []);
  // Remember whether the last click was on a browser window, so ⌘W targets it (never the app).
  useEffect(() => {
    const down = (event: PointerEvent) => browserRegistry.setDesktopFocused(Boolean((event.target as Element | null)?.closest?.(".desktop-window")));
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);
  const update = useCallback((id: string, next: (w: DesktopWindow) => DesktopWindow) => setWindows((old) => old.map((w) => w.id === id ? next(w) : w)), []);
  const focus = useCallback((id: string) => { if (!id.startsWith("sim")) browserRegistry.activate(id); browserRegistry.setDesktopFocused(true); setWindows((old) => { const top = topZ(old); return old.map((w) => w.id === id && w.z !== top ? { ...w, z: top + 1 } : w); }); }, []);
  const open = useCallback(() => {
    const id = `w${newId()}`;
    setWindows((old) => [...old, newWindow(old, size, id)]);
    browserRegistry.activate(id); browserRegistry.setDesktopFocused(true);
  }, [size]);
  const close = useCallback((id: string) => {
    setWindows((old) => old.filter((w) => w.id !== id));
    localStorage.removeItem(`orchestra.browser.tabs.${id}`);
    browserRegistry.setDesktopFocused(false);
  }, []);
  const snap = useCallback((id: string, to: Snap) => { update(id, (w) => applySnap(w, to)); focus(id); }, [update, focus]);
  // Out of the app into its own OS window: the window keeps its id, so its saved tabs open there
  // (BrowserPanel's store is keyed by it) and come back with it. The agents follow (server/browser-windows.ts).
  const everyOutside = useOutsideWindows();
  const outside = everyOutside.filter((item) => item.workspaceId === workspaceId);
  const outsideRef = useRef(everyOutside); outsideRef.current = everyOutside;
  const [popOutError, setPopOutError] = useState(false);
  useEffect(() => { if (!popOutError) return; const timer = setTimeout(() => setPopOutError(false), 5000); return () => clearTimeout(timer); }, [popOutError]);
  const popOut = useCallback((id: string) => {
    void openBrowserWindow({ id, workspaceId }, t("bw.title")).then((opened) => {
      if (!opened) { setPopOutError(true); return; }
      rememberOutside(workspaceId, id);
      setWindows((old) => old.filter((w) => w.id !== id));
      browserRegistry.setDesktopFocused(false);
    });
  }, [workspaceId]);
  useEffect(() => {
    const dock = (event: Event) => {
      const target = (event as CustomEvent<BrowserWindowTarget>).detail;
      if (target?.workspaceId !== workspaceId || !target.id) return;
      forgetOutside(workspaceId, target.id);
      setWindows((old) => old.some((w) => w.id === target.id) ? old.map((w) => w.id === target.id ? { ...w, minimized: false, z: topZ(old) + 1 } : w) : [...old, newWindow(old, sizeRef.current, target.id)]);
      browserRegistry.activate(target.id);
    };
    window.addEventListener(DOCK_EVENT, dock);
    return () => window.removeEventListener(DOCK_EVENT, dock);
  }, [workspaceId]);
  // A window that was moved out and is no longer open out there (closed by its own close button, or
  // the app restarted) comes back minimized, tabs and all. Checked a while after each report from the
  // server, so a window whose socket is only reconnecting is left alone; with no report (the app
  // itself is offline) nothing is known, and nothing is brought back.
  const outsideReport = useOutsideReport();
  const [lookAgain, setLookAgain] = useState(0);
  useEffect(() => {
    if (!outsideReport) return;
    const timer = setTimeout(() => {
      // A window moved out moments ago may still be opening (its report has not come yet): look again later.
      const remembered = rememberedOutside(workspaceId);
      const opening = remembered.filter((id) => stillOpening(id));
      if (opening.length) setLookAgain((n) => n + 1);
      const lost = lostOutside(remembered.filter((id) => !opening.includes(id)), outsideRef.current, workspaceId);
      if (!lost.length) return;
      for (const id of lost) forgetOutside(workspaceId, id);
      setWindows((old) => lost.filter((id) => !old.some((w) => w.id === id)).reduce((list, id) => [...list, { ...newWindow(list, sizeRef.current, id), minimized: true }], old));
    }, OUTSIDE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [outsideReport, lookAgain, workspaceId]);
  // ⌘⇧B / toolbar / agent commands: show the focused window (or make one); toggle minimizes it again.
  // Layout, not a timer: a background WKWebView does not run requestAnimationFrame.
  useLayoutEffect(() => {
    if (!request.n) return;
    if (handled.current.has(request)) return;
    handled.current.add(request);
    setWindows((old) => {
      const browsers = old;
      if (!browsers.length) { const id = `w${newId()}`; browserRegistry.activate(id); return [...old, newWindow(old, size, id)]; }
      const target = browsers.find((w) => w.id === browserRegistry.active()) ?? browsers.reduce((a, b) => (a.z > b.z ? a : b));
      browserRegistry.activate(target.id);
      const onTop = !target.minimized && target.z === topZ(old);
      if (request.toggle && onTop) return old.map((w) => w.id === target.id ? { ...w, minimized: true } : w);
      return old.map((w) => w.id === target.id ? { ...w, minimized: false, z: topZ(old) + 1 } : w);
    });
  }, [request]);
  // ⌃⌥←/→/↑ anywhere in the app snaps the focused browser window.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const action = windowShortcut(event);
      if (action?.type !== "snap" || event.repeat) return;
      const id = browserRegistry.active();
      if (!id || !windows.some((w) => w.id === id && !w.minimized)) return;
      event.preventDefault(); event.stopPropagation();
      snap(id, action.snap);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [windows, snap]);

  const drag = (event: React.PointerEvent, win: DesktopWindow, edge?: Edge) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault(); focus(win.id);
    if (win.maximized && !edge) return;
    const startX = event.clientX, startY = event.clientY;
    // Dragging a snapped window un-snaps it under the cursor, like macOS.
    const start = frameOf(win, size, layout);
    const base: DesktopWindow = win.snap ? { ...win, snap: undefined, x: event.clientX - Math.min(win.w / 2, start.w / 2), y: start.y } : win;
    // The cover (keeps the iframe from eating pointer events) appears only once the pointer moves,
    // so a plain double-click on the header still reaches it.
    let cover: HTMLDivElement | undefined;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!cover) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        cover = document.createElement("div"); cover.className = "browser-resize-cover"; cover.style.cursor = edge ? `${edge}-resize` : "grabbing";
        document.body.appendChild(cover);
      }
      if (edge) update(win.id, () => resizeWindow({ ...win, ...start, snap: undefined, maximized: false }, edge, dx, dy));
      else update(win.id, () => clampPosition({ ...base, x: base.x + dx, y: base.y + dy }, size));
    };
    const up = () => { cover?.remove(); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // The edge between a snapped window and the chat: drag (or arrow keys) to change how they share the width.
  const usable = Math.max(0, size.width - layout.left);
  const resizeSplit = (width: number) => { if (usable > 0) setDeskSplit(clampSnapWidth(width, usable) / usable); };
  const dragSplit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !splitFrame) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // Capture keeps the drag alive over the page (an iframe, or the native view) and the chat.
    try { handle.setPointerCapture(event.pointerId); } catch { /* no active pointer (synthetic event): the handle still gets its own moves */ }
    const from = event.clientX, base = splitFrame.w, sign = side === "left" ? 1 : -1;
    document.body.classList.add("desk-splitting");
    const move = (next: PointerEvent) => resizeSplit(base + sign * (next.clientX - from));
    const end = () => {
      document.body.classList.remove("desk-splitting");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const keySplit = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!splitFrame) return;
    const step = (event.shiftKey ? 48 : 16) * (side === "left" ? 1 : -1);
    if (event.key === "ArrowRight") resizeSplit(splitFrame.w + step);
    else if (event.key === "ArrowLeft") resizeSplit(splitFrame.w - step);
    else if (event.key === "Home") setDeskSplit(SPLIT_DEFAULT);
    else return;
    event.preventDefault();
  };
  const activeId = browserRegistry.active();
  const minimized = windows.filter((w) => w.minimized);
  const browsers = windows;
  const label = (win: DesktopWindow) => t("desk.windowN", { n: browsers.indexOf(win) + 1 });

  return (
    <div ref={area} className={`browser-desktop desk-${mode}${background ? " background" : ""}`} aria-label={t("desk.label")} aria-hidden={background || undefined}>
      {windows.map((win) => {
        const frame = frameOf(win, size, layout);
        const fixed = Boolean(win.maximized || win.snap);
        return (
          <section key={win.id} className={`desktop-window${win.id === activeId ? " focused" : ""}${fixed ? " snapped" : ""}`} hidden={win.minimized}
            style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, zIndex: win.z }}
            onPointerDownCapture={() => focus(win.id)} aria-label={t("desk.window")}>
            <header className="desktop-titlebar" onPointerDown={(e) => drag(e, win)} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) snap(win.id, "max"); }}>
              <div className="desktop-lights">
                <button type="button" className="light close" aria-label={t("desk.closeWindow")} title={t("desk.close")} onClick={() => close(win.id)}><X size={9} /></button>
                <button type="button" className="light min" aria-label={t("desk.minimize")} title={t("desk.minimize")} onClick={() => update(win.id, (w) => ({ ...w, minimized: true }))}><Minus size={9} /></button>
                <button type="button" className="light max" aria-label={win.maximized ? t("desk.restoreSize") : t("desk.maximize")} title={win.maximized ? t("desk.restoreSizeTitle") : t("desk.maximizeTitle")} onClick={() => snap(win.id, "max")}>{win.maximized ? <Minimize2 size={8} /> : <Maximize2 size={8} />}</button>
              </div>
              <span className="desktop-title"><Globe size={13} />{label(win)}{win.id === activeId && browsers.length > 1 && <em>{t("desk.aiTarget")}</em>}</span>
              <div className="desktop-snaps" role="group" aria-label={t("desk.layout")}>
                <button type="button" aria-label={t("desk.newWindow")} title={t("desk.newWindow")} onClick={open}><Plus size={14} /></button>
                <button type="button" aria-label={t("desk.popOut")} title={t("desk.popOutTitle")} onClick={() => popOut(win.id)}><ExternalLink size={14} /></button>
                <button type="button" className={win.snap === "left" ? "on" : ""} aria-label={t("desk.leftHalf")} title={t("desk.leftHalfTitle")} onClick={() => snap(win.id, "left")}><PanelLeft size={14} /></button>
                <button type="button" className={win.snap === "right" ? "on" : ""} aria-label={t("desk.rightHalf")} title={t("desk.rightHalfTitle")} onClick={() => snap(win.id, "right")}><PanelRight size={14} /></button>
                <button type="button" className={win.maximized ? "on" : ""} aria-label={win.maximized ? t("desk.restoreTo") : t("desk.fill")} title={win.maximized ? t("desk.restoreToTitle") : t("desk.fillTitle")} onClick={() => snap(win.id, "max")}>{win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
              </div>
            </header>
            <div className="desktop-body">
              <BrowserPanel instanceId={win.id} workspaceId={workspaceId} background={background} open={!win.minimized} onOpenChange={(next) => { update(win.id, (w) => ({ ...w, minimized: !next })); if (next) focus(win.id); }}
                onLastTabClosed={() => close(win.id)} onSnap={(to) => snap(win.id, to)} onAttach={onAttach} />
            </div>
            {!fixed && EDGES.map((edge) => <div key={edge} className={`desktop-edge edge-${edge}`} onPointerDown={(e) => drag(e, win, edge)} />)}
          </section>
        );
      })}
      {splitWindow && splitFrame && side && (mode === "max" || !layout.chatCollapsed) && !background && <div className={`desktop-split split-${side}`} role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label={t("desk.split")} title={t("desk.splitHint")} aria-valuemin={SPLIT_MIN_BROWSER} aria-valuemax={Math.max(SPLIT_MIN_BROWSER, usable - SPLIT_MIN_CHAT)} aria-valuenow={splitFrame.w}
        style={{ left: side === "left" ? splitFrame.x + splitFrame.w : splitFrame.x, height: splitFrame.h, zIndex: splitWindow.z }}
        onPointerDown={dragSplit} onKeyDown={keySplit} onDoubleClick={() => setDeskSplit(SPLIT_DEFAULT)} />}
      {(minimized.length > 0 || outside.length > 0 || popOutError) && !background && <nav className="desktop-dock" aria-label={t("desk.dock")}>
        {minimized.map((win) => <button type="button" key={win.id} onClick={() => { update(win.id, (w) => ({ ...w, minimized: false })); focus(win.id); }} title={t("desk.restoreWindow")}><Globe size={14} />{t("desk.dockItem", { n: browsers.indexOf(win) + 1 })}</button>)}
        {outside.map((item, index) => <button type="button" key={item.id} className="outside" onClick={() => { void openBrowserWindow(item, t("bw.title")); }} title={t("desk.outsideTitle")}><ExternalLink size={14} />{t("desk.outside", { n: index + 1 })}</button>)}
        {popOutError && <span role="alert">{t("desk.popOutFailed")}</span>}
      </nav>}
    </div>
  );
}
