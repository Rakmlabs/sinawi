import { Radio, Terminal, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { workerLogSummary, type workerLogRows } from "../worker-log";
import { eventLabels } from "./labels";
import type { Session } from "../../server/types";
import { t } from "../i18n";

type Row = ReturnType<typeof workerLogRows>[number];

/** Right column: recent non-message activity of the active session. */
export function ActivityPanel({ active, connected, rows, onClose }: { active: Session | undefined; connected: boolean; rows: Row[]; onClose: () => void }) {
  return <aside className="right-column" id="activity-panel" aria-label={t("activity.label")}>
    <section className="glass activity-panel">
      <div className="panel-header">
        <div>
          <Radio size={17} />
          <h2>{t("activity.title")}</h2>
        </div>
        <span
          className={`live-badge ${!connected ? "offline" : ""}`}
          role="status"
        >
          <i />
          {!connected
            ? t("activity.disconnected")
            : active?.status === "running"
              ? t("activity.running")
              : t("activity.idle")}
        </span>
        <button className="icon-button" aria-label={t("activity.close")} onClick={onClose}><X size={16} /></button>
      </div>
      <div className="activity-content">
        {!active ? (
          <div className="activity-empty">
            <span className="radar">
              <Radio size={27} />
            </span>
            <h3>{t("activity.emptyTitle")}</h3>
            <p>
              {t("activity.emptyBody1")}
              <br />
              {t("activity.emptyBody2")}
            </p>
            <span>{t("activity.waiting")}</span>
          </div>
        ) : (
          <div
            className="event-list"
            role="log"
            aria-label={t("activity.recent")}
            aria-live="off"
          >
            {rows.length === 0 && <p className="thread-empty">{t("activity.none")}</p>}
            {rows.map((row) => <div className={`activity-summary event-${row.type}`} key={row.event.id}>
              <AgentMark agent={row.event.agent} size="small" /><span title={workerLogSummary(row)}>{row.event.workerLabel ? `${row.event.workerLabel} · ` : ""}{eventLabels[row.type]} · {workerLogSummary(row)}</span>
              <time>{new Date(row.event.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>)}
          </div>
        )}
      </div>
      <div className="activity-footer">
        <Terminal size={13} />
        <span>{t("activity.footer")}</span>
        <span className="tiny-dot" />
      </div>
    </section>
  </aside>;
}
