import { Layers, Plus, Square } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session } from "../../server/types";
import { t } from "../i18n";
import { Beat } from "../Beat";

/** "세션 기록" tab: every session of the workspace with a live elapsed clock. */
export function SessionsView({ sessions, onNew, onSelect, onStop }: { sessions: Session[]; onNew: () => void; onSelect: (id: string) => void; onStop: (id: string) => void }) {
  const running = sessions.filter((s) => s.status === "running").length;
  return <section className="panel full-panel">
    <div className="panel-header">
      <h2>{t("sessions.title")}</h2>
      <span>
        {t("sessions.summary", { total: sessions.length, running })}
      </span>
    </div>
    {sessions.length === 0 ? (
      <div className="page-empty">
        <Layers size={32} />
        <h2>{t("sessions.emptyTitle")}</h2>
        <p>{t("sessions.emptyBody")}</p>
        <button className="button primary" onClick={onNew}>
          <Plus size={16} />
          {t("sessions.new")}
        </button>
      </div>
    ) : (
      sessions.map((s) => (
        <div className="history-row" key={s.id}>
          <AgentMark agent={s.agent} />
          <button
            onClick={() => {
              onSelect(s.id);
            }}
          >
            <strong>{s.title}</strong>
            <small>{names[s.agent]} · {s.cwd}</small>
          </button>
          <span className={`status-label ${s.status}`}>
            {s.status === "running" && <Beat />}
            {statusLabels[s.status]}
          </span>
          <Elapsed start={s.createdAt} end={s.endedAt} />
          {s.status === "running" && (
            <button
              className="icon-button"
              title={t("sessions.stop")}
              onClick={() => onStop(s.id)}
            >
              <Square size={14} />
            </button>
          )}
        </div>
      ))
    )}
  </section>;
}
