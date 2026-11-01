import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Globe, Maximize2, Minimize2, Minus, PanelLeft, PanelRight, Plus, X } from "lucide-react";
import { BrowserPanel } from "./BrowserPanel";
import { browserRegistry } from "./browser-registry";
import { windowShortcut } from "./browser-shortcuts";
import { applySnap, clampPosition, desktopMode, DESKTOP_STORE, frameOf, loadWindows, newWindow, resizeWindow, topZ, type DesktopMode, type DesktopWindow, type Edge, type Snap } from "./desktop-windows";
import type { ComposerAttachment } from "./preview-attachments";
import { t } from "./i18n";

const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const newId = () => Math.random().toString(36).slice(2, 10);

export type DesktopRequest = { n: number; toggle?: boolean };
type Props = { onAttach: (items: ComposerAttachment[]) => void; request: DesktopRequest; onModeChange: (mode: DesktopMode) => void };

/** Browser windows floating over the workspace (the only browser layout). */
export function BrowserDesktop({ onAttach, request, onModeChange }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<DesktopWindow[]>(() => loadWindows(localStorage.getItem(DESKTOP_STORE)));
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [, force] = useState(0);
  useEffect(() => browserRegistry.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => { localStorage.setItem(DESKTOP_STORE, JSON.stringify(windows)); }, [windows]);
  const mode = desktopMode(windows);
  useEffect(() => { onModeChange(mode); }, [mode, onModeChange]);
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
  const focus = useCallback((id: string) => { browserRegistry.activate(id); browserRegistry.setDesktopFocused(true); setWindows((old) => { const top = topZ(old); return old.map((w) => w.id === id && w.z !== top ? { ...w, z: top + 1 } : w); }); }, []);
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
  // ⌘⇧B / toolbar / agent commands: show the focused window (or make one); toggle minimizes it again.
  // Layout, not a timer: a background WKWebView does not run requestAnimationFrame.
  useLayoutEffect(() => {
    if (!request.n) return;
    setWindows((old) => {
      if (!old.length) { const id = `w${newId()}`; browserRegistry.activate(id); return [newWindow(old, size, id)]; }
      const target = old.find((w) => w.id === browserRegistry.active()) ?? old.reduce((a, b) => (a.z > b.z ? a : b));
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
    const start = frameOf(win, size);
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
  const activeId = browserRegistry.active();
  const minimized = windows.filter((w) => w.minimized);

  return (
    <div ref={area} className={`browser-desktop desk-${mode}`} aria-label={t("desk.label")}>
      {windows.map((win) => {
        const frame = frameOf(win, size);
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
              <span className="desktop-title"><Globe size={13} />{t("desk.windowN", { n: windows.indexOf(win) + 1 })}{win.id === activeId && windows.length > 1 && <em>{t("desk.aiTarget")}</em>}</span>
              <div className="desktop-snaps" role="group" aria-label={t("desk.layout")}>
                <button type="button" aria-label={t("desk.newWindow")} title={t("desk.newWindow")} onClick={open}><Plus size={14} /></button>
                <button type="button" className={win.snap === "left" ? "on" : ""} aria-label={t("desk.leftHalf")} title={t("desk.leftHalfTitle")} onClick={() => snap(win.id, "left")}><PanelLeft size={14} /></button>
                <button type="button" className={win.snap === "right" ? "on" : ""} aria-label={t("desk.rightHalf")} title={t("desk.rightHalfTitle")} onClick={() => snap(win.id, "right")}><PanelRight size={14} /></button>
                <button type="button" className={win.maximized ? "on" : ""} aria-label={win.maximized ? t("desk.restoreTo") : t("desk.fill")} title={win.maximized ? t("desk.restoreToTitle") : t("desk.fillTitle")} onClick={() => snap(win.id, "max")}>{win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
              </div>
            </header>
            <div className="desktop-body">
              <BrowserPanel instanceId={win.id} open={!win.minimized} onOpenChange={(next) => { update(win.id, (w) => ({ ...w, minimized: !next })); if (next) focus(win.id); }}
                onLastTabClosed={() => close(win.id)} onSnap={(to) => snap(win.id, to)} onAttach={onAttach} />
            </div>
            {!fixed && EDGES.map((edge) => <div key={edge} className={`desktop-edge edge-${edge}`} onPointerDown={(e) => drag(e, win, edge)} />)}
          </section>
        );
      })}
      {minimized.length > 0 && <nav className="desktop-dock" aria-label={t("desk.dock")}>
        {minimized.map((win) => <button type="button" key={win.id} onClick={() => { update(win.id, (w) => ({ ...w, minimized: false })); focus(win.id); }} title={t("desk.restoreWindow")}><Globe size={14} />{t("desk.dockItem", { n: windows.indexOf(win) + 1 })}</button>)}
      </nav>}
    </div>
  );
}
