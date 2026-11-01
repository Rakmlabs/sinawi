import { AgentMark } from "./AgentMark";
import { Elapsed } from "./app/Elapsed";
import { Markdown } from "./Markdown";
import type { DelegationTask, DelegationWorker } from "./conversation";
import { workerLogRows, type ItemStatus } from "./worker-log";
import type { EventType, SessionStatus } from "../server/types";
import { t, translatedMap } from "./i18n";
import { Beat } from "./Beat";

const labels = translatedMap<EventType>({ message: "event.message", tool: "event.tool", command: "event.command", edit: "event.edit", status: "event.status", error: "event.error", warning: "event.warning", delegation: "event.request", handoff: "event.leadChange" });
const statuses = translatedMap<SessionStatus>({ running: "status.running", done: "status.done", error: "status.error", stopped: "status.stopped" });
const itemStatuses = translatedMap<ItemStatus>({ in_progress: "worker.inProgress", completed: "worker.succeeded", failed: "worker.failed" });
const changeLabels = translatedMap({ add: "worker.add", modify: "worker.modify", delete: "worker.delete" });

function TaskLog({ task, index }: { task: DelegationTask; index: number }) {
  const rows = workerLogRows(task.thread);
  return <section className="worker-task-log" aria-labelledby={`worker-task-${task.event.id}`}>
    <div className="worker-task-divider"><span>{t("worker.taskN", { n: index + 1 })}</span><strong id={`worker-task-${task.event.id}`}>{task.event.text}</strong><span className={`status-label ${task.status}`}>{task.status === "running" && <Beat />}{statuses[task.status]}</span><Elapsed start={task.startedAt} end={task.endedAt} /></div>
    {rows.map((row) => <article className={`event event-${row.type}`} key={row.event.id}>
      <div className="event-top"><span>{labels[row.type]}</span>
        {row.status && <span className={`worker-item-status ${row.status}`}>{itemStatuses[row.status]}{row.exitCode !== undefined && t("worker.exitCode", { code: row.exitCode })}</span>}
        <time>{new Date(row.event.time).toLocaleTimeString("ko-KR", { hour12: false })}</time>
      </div>
      {row.type === "command" ? <pre className="worker-command"><code>{row.text || t("workerLog.unknownCommand")}</code></pre>
        : row.changes ? row.changes.length ? <ul className="worker-file-changes">{row.changes.map((change, changeIndex) => <li key={`${change.path}-${changeIndex}`}><span className={`worker-change-kind ${change.kind}`}>{changeLabels[change.kind]}</span><code>{change.path}</code></li>)}</ul> : <p className="worker-log-text">{row.text}</p>
        : row.type === "message" || row.type === "delegation" ? <Markdown text={row.text} />
        : <p className="worker-log-text">{row.text}</p>}
      {row.output !== undefined && <details className="worker-output"><summary>{t("worker.showOutput")}</summary><pre><code>{row.output || t("worker.noOutput")}</code></pre></details>}
    </article>)}
    {!task.thread.length && <p className="thread-empty">{task.status === "running" ? t("worker.preparing") : t("worker.noHistory")}</p>}
  </section>;
}

export function WorkerThread({ worker }: { worker: DelegationWorker }) {
  return <div className="worker-thread" role="log" aria-label={t("worker.logLabel")} aria-live="off">
    <div className="worker-thread-heading"><AgentMark agent={worker.agent} /><strong>{worker.label} · {t("worker.taskCount", { n: worker.tasks.length })}</strong><span className={`status-label ${worker.status}`}>{worker.status === "running" && <Beat />}{statuses[worker.status]}</span></div>
    {worker.tasks.map((task, index) => <TaskLog key={task.event.id} task={task} index={index} />)}
  </div>;
}
