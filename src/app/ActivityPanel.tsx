import { useCallback, useState } from "react";
import { Radio, SquareTerminal, X } from "lucide-react";
import { workerLogSummary, type workerLogRows } from "../worker-log";
import { toggleTerminal } from "../terminal-events";
import { eventLabels, names } from "./labels";
import type { EventType, Session } from "../../server/types";
import { dateLocale, t } from "../i18n";

type Row = ReturnType<typeof workerLogRows>[number];
type Filter = "all" | "commands" | "files" | "errors";

const filterTypes: Record<Exclude<Filter, "all">, EventType[]> = {
  commands: ["command", "tool"],
  files: ["edit"],
  errors: ["error", "warning"],
};
const filters: Filter[] = ["all", "commands", "files", "errors"];

// The panel's width, set by dragging its left edge (long commands and paths were cut at a fixed 360px).
// Remembered per browser, like the sidebar's.
export const ACTIVITY_DEFAULT = 340, ACTIVITY_MIN = 280, ACTIVITY_MAX = 720;
const WIDTH_KEY = "sinawi.activityWidth";
export const clampActivity = (value: number) => Math.round(Math.min(ACTIVITY_MAX, Math.max(ACTIVITY_MIN, Number.isFinite(value) ? value : ACTIVITY_DEFAULT)));

function useActivityWidth(): [number | undefined, (width: number) => void, () => void] {
  // Undefined until the user sets one: the stylesheet's own width (it follows the window) applies.
  const [width, setWidth] = useState<number | undefined>(() => { try { const value = Number(localStorage.getItem(WIDTH_KEY)); return value ? clampActivity(value) : undefined; } catch { return undefined; } });
  const set = useCallback((next: number) => {
    const value = clampActivity(next);
    setWidth(value);
    try { localStorage.setItem(WIDTH_KEY, String(value)); } catch { /* private window: this session only */ }
  }, []);
  // Back to the stylesheet's width, which follows the window.
  const reset = useCallback(() => { setWidth(undefined); try { localStorage.removeItem(WIDTH_KEY); } catch { /* nothing saved */ } }, []);
  return [width, set, reset];
}

function ActivityResizer({ onChange, onReset }: { onChange: (width: number) => void; onReset: () => void }) {
  const current = (handle: HTMLElement) => handle.parentElement?.getBoundingClientRect().width ?? ACTIVITY_DEFAULT;
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    try { handle.setPointerCapture(event.pointerId); } catch { /* no active pointer */ }
    const from = event.clientX, base = current(handle);
    document.body.classList.add("sidebar-resizing");
    // The panel is on the right: dragging its left edge leftwards makes it wider.
    const move = (next: PointerEvent) => onChange(base - (next.clientX - from));
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
    if (event.key === "ArrowLeft") onChange(current(event.currentTarget) + step);
    else if (event.key === "ArrowRight") onChange(current(event.currentTarget) - step);
    else if (event.key === "Home") onReset();
    else return;
    event.preventDefault();
  };
  return <div className="activity-resizer" role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t("activity.resize")} title={t("activity.resizeHint")}
    aria-valuemin={ACTIVITY_MIN} aria-valuemax={ACTIVITY_MAX} onPointerDown={start} onKeyDown={key} onDoubleClick={onReset} />;
}

/** Right column: recent non-message activity of the active session, filterable by kind. */
export function ActivityPanel({ active, connected, rows, onClose }: { active: Session | undefined; connected: boolean; rows: Row[]; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = filter === "all" ? rows : rows.filter((row) => filterTypes[filter].includes(row.type));
  const [width, setWidth, resetWidth] = useActivityWidth();
  return <aside className="activity-panel" id="activity-panel" aria-label={t("activity.label")} style={width ? { "--activity-width": `${width}px` } as React.CSSProperties : undefined}>
    <ActivityResizer onChange={setWidth} onReset={resetWidth} />
    <div className="activity-heading">
      <h2>{t("activity.label")}</h2>
      <span className={`live-badge ${!connected ? "offline" : ""}`} role="status">
        <i />
        {!connected ? t("activity.disconnected") : active?.status === "running" ? t("activity.running") : t("activity.idle")}
      </span>
      {active && <span className="activity-count">{rows.length}</span>}
      <button type="button" className="chat-action-icon" aria-label={t("activity.close")} title={t("activity.close")} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </div>
    {active && <div className="activity-tabs" role="tablist" aria-label={t("activity.filter")}>
      {filters.map((key) => <button key={key} type="button" role="tab" aria-selected={filter === key} aria-controls="activity-log" onClick={() => setFilter(key)}>{t(`activity.${key}`)}</button>)}
    </div>}
    <div className="activity-content">
      {!active ? (
        <div className="activity-empty">
          <span className="radar"><Radio size={27} /></span>
          <h3>{t("activity.emptyTitle")}</h3>
          <p>{t("activity.emptyBody1")}<br />{t("activity.emptyBody2")}</p>
          <span>{t("activity.waiting")}</span>
        </div>
      ) : (
        <ol className="event-list" id="activity-log" role="log" aria-label={t("activity.recent")} aria-live="off">
          {shown.length === 0 && <li className="thread-empty">{rows.length ? t("activity.filteredNone") : t("activity.none")}</li>}
          {[...shown].reverse().map((row) => <li className={`activity-summary event-${row.type}`} key={row.event.id}>
            <time>{new Date(row.event.time).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
            <div>
              <div className="activity-who"><span className={`agent-dot ${row.event.agent}`} aria-hidden="true" />{row.event.workerLabel ?? names[row.event.agent]} · {eventLabels[row.type]}</div>
              <div className="activity-detail" title={workerLogSummary(row)}>{workerLogSummary(row)}</div>
            </div>
          </li>)}
        </ol>
      )}
    </div>
    <button type="button" className="activity-terminal" onClick={() => toggleTerminal()}>
      <SquareTerminal size={15} aria-hidden="true" />{t("activity.openTerminal")}<kbd aria-hidden="true">⌃`</kbd>
    </button>
  </aside>;
}
