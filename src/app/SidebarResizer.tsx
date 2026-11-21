// The sidebar's width, set by dragging its edge (third review U1: chat titles shrank to 1–3 letters
// in a fixed 260px column). Keyboard: arrows change it, Home resets; a double-click resets too.
// Remembered per browser (a viewer convenience, so localStorage is enough).
import { useCallback, useState } from "react";
import { t } from "../i18n";

export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 440;
const KEY = "sinawi.sidebarWidth";

export const clampSidebar = (value: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number.isFinite(value) ? value : SIDEBAR_DEFAULT)));

function stored(): number {
  try { const value = Number(localStorage.getItem(KEY)); return value ? clampSidebar(value) : SIDEBAR_DEFAULT; } catch { return SIDEBAR_DEFAULT; }
}

export function useSidebarWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(stored);
  const set = useCallback((next: number) => {
    const value = clampSidebar(next);
    setWidth(value);
    try { localStorage.setItem(KEY, String(value)); } catch { /* private window: this session only */ }
  }, []);
  return [width, set];
}

export function SidebarResizer({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const from = event.clientX;
    const base = width;
    document.body.classList.add("sidebar-resizing");
    const move = (next: PointerEvent) => onChange(base + next.clientX - from);
    const end = () => {
      document.body.classList.remove("sidebar-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") onChange(width - step);
    else if (event.key === "ArrowRight") onChange(width + step);
    else if (event.key === "Home") onChange(SIDEBAR_DEFAULT);
    else return;
    event.preventDefault();
  };
  return <div className="sidebar-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={t("side.resize")} title={t("side.resizeHint")}
    aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width}
    onPointerDown={start} onKeyDown={key} onDoubleClick={() => onChange(SIDEBAR_DEFAULT)} />;
}
