import { Radio, Terminal, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { workerLogSummary, type workerLogRows } from "../worker-log";
import { eventLabels } from "./labels";
import type { Session } from "../../server/types";

type Row = ReturnType<typeof workerLogRows>[number];

/** Right column: recent non-message activity of the active session. */
export function ActivityPanel({ active, connected, rows, onClose }: { active: Session | undefined; connected: boolean; rows: Row[]; onClose: () => void }) {
  return <aside className="right-column" id="activity-panel" aria-label="실시간 활동">
    <section className="glass activity-panel">
      <div className="panel-header">
        <div>
          <Radio size={17} />
          <h2>작업 내역</h2>
        </div>
        <span
          className={`live-badge ${!connected ? "offline" : ""}`}
          role="status"
        >
          <i />
          {!connected
            ? "연결 끊김"
            : active?.status === "running"
              ? "진행 중"
              : "대기 중"}
        </span>
        <button className="icon-button" aria-label="작업 내역 접기" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="activity-content">
        {!active ? (
          <div className="activity-empty">
            <span className="radar">
              <Radio size={27} />
            </span>
            <h3>작업 과정을 한눈에.</h3>
            <p>
              명령 실행, 도구 사용, 파일 변경 내역이
              <br />
              여기에 실시간으로 표시됩니다.
            </p>
            <span>첫 세션을 기다리고 있습니다</span>
          </div>
        ) : (
          <div
            className="event-list"
            role="log"
            aria-label="최근 에이전트 활동"
            aria-live="off"
          >
            {rows.length === 0 && <p className="thread-empty">아직 작업 내역이 없습니다.</p>}
            {rows.map((row) => <div className={`activity-summary event-${row.type}`} key={row.event.id}>
              <AgentMark agent={row.event.agent} size="small" /><span title={workerLogSummary(row)}>{row.event.workerLabel ? `${row.event.workerLabel} · ` : ""}{eventLabels[row.type]} · {workerLogSummary(row)}</span>
              <time>{new Date(row.event.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>)}
          </div>
        )}
      </div>
      <div className="activity-footer">
        <Terminal size={13} />
        <span>실시간 CLI 활동 내역</span>
        <span className="tiny-dot" />
      </div>
    </section>
  </aside>;
}
