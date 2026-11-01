import { AgentMark } from "./AgentMark";
import { Markdown } from "./Markdown";
import type { DelegationTask, DelegationWorker } from "./conversation";
import { workerLogRows, type ItemStatus } from "./worker-log";
import type { EventType, SessionStatus } from "../server/types";

const labels: Record<EventType, string> = { message: "메시지", tool: "도구 사용", command: "명령 실행", edit: "파일 수정", status: "상태", error: "오류", warning: "경고", delegation: "작업 요청", handoff: "총괄 변경" };
const statuses: Record<SessionStatus, string> = { running: "진행 중", done: "완료", error: "오류", stopped: "중지됨" };
const itemStatuses: Record<ItemStatus, string> = { in_progress: "진행중", completed: "성공", failed: "실패" };
const changeLabels = { add: "추가", modify: "수정", delete: "삭제" };

function TaskLog({ task, index }: { task: DelegationTask; index: number }) {
  const rows = workerLogRows(task.thread);
  return <section className="worker-task-log" aria-labelledby={`worker-task-${task.event.id}`}>
    <div className="worker-task-divider"><span>작업 {index + 1}</span><strong id={`worker-task-${task.event.id}`}>{task.event.text}</strong><span className={`status-label ${task.status}`}>{statuses[task.status]}</span><time>{task.elapsed}</time></div>
    {rows.map((row) => <article className={`event event-${row.type}`} key={row.event.id}>
      <div className="event-top"><span>{labels[row.type]}</span>
        {row.status && <span className={`worker-item-status ${row.status}`}>{itemStatuses[row.status]}{row.exitCode !== undefined && ` · 종료 코드 ${row.exitCode}`}</span>}
        <time>{new Date(row.event.time).toLocaleTimeString("ko-KR", { hour12: false })}</time>
      </div>
      {row.type === "command" ? <pre className="worker-command"><code>{row.text || "명령을 확인할 수 없습니다."}</code></pre>
        : row.changes ? row.changes.length ? <ul className="worker-file-changes">{row.changes.map((change, changeIndex) => <li key={`${change.path}-${changeIndex}`}><span className={`worker-change-kind ${change.kind}`}>{changeLabels[change.kind]}</span><code>{change.path}</code></li>)}</ul> : <p className="worker-log-text">{row.text}</p>
        : row.type === "message" || row.type === "delegation" ? <Markdown text={row.text} />
        : <p className="worker-log-text">{row.text}</p>}
      {row.output !== undefined && <details className="worker-output"><summary>출력 보기</summary><pre><code>{row.output || "출력이 없습니다."}</code></pre></details>}
    </article>)}
    {!task.thread.length && <p className="thread-empty">{task.status === "running" ? "작업을 준비하고 있습니다…" : "기록된 작업 내역이 없습니다."}</p>}
  </section>;
}

export function WorkerThread({ worker }: { worker: DelegationWorker }) {
  return <div className="worker-thread" role="log" aria-label="작업 세션 로그" aria-live="off">
    <div className="worker-thread-heading"><AgentMark agent={worker.agent} /><strong>{worker.label} · {worker.tasks.length}개 작업</strong><span className={`status-label ${worker.status}`}>{statuses[worker.status]}</span></div>
    {worker.tasks.map((task, index) => <TaskLog key={task.event.id} task={task} index={index} />)}
  </div>;
}
