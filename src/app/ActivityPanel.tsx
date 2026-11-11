import { useState } from "react";
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

/** Right column: recent non-message activity of the active session, filterable by kind. */
export function ActivityPanel({ active, connected, rows, onClose }: { active: Session | undefined; connected: boolean; rows: Row[]; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = filter === "all" ? rows : rows.filter((row) => filterTypes[filter].includes(row.type));
  return <aside className="activity-panel" id="activity-panel" aria-label={t("activity.label")}>
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
