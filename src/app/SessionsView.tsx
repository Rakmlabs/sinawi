import { Layers, Plus, Square } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { Elapsed } from "./Elapsed";
import { names, statusLabels } from "./labels";
import type { Session } from "../../server/types";

/** "세션 기록" tab: every session of the workspace with a live elapsed clock. */
export function SessionsView({ sessions, onNew, onSelect, onStop }: { sessions: Session[]; onNew: () => void; onSelect: (id: string) => void; onStop: (id: string) => void }) {
  const running = sessions.filter((s) => s.status === "running").length;
  return <section className="glass full-panel">
    <div className="panel-header">
      <h2>세션 기록</h2>
      <span>
        전체 {sessions.length}개 · 진행 중 {running}개
      </span>
    </div>
    {sessions.length === 0 ? (
      <div className="page-empty">
        <Layers size={32} />
        <h2>다음 아이디어를 여기서 시작하세요.</h2>
        <p>세션을 시작하고 에이전트의 작업을 확인하세요.</p>
        <button className="button primary" onClick={onNew}>
          <Plus size={16} />
          새 세션
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
            {statusLabels[s.status]}
          </span>
          <Elapsed start={s.createdAt} end={s.endedAt} />
          {s.status === "running" && (
            <button
              className="icon-button"
              title="세션 중지"
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
