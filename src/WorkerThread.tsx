import { useState } from "react";
import { AgentMark } from "./AgentMark";
import { Elapsed } from "./app/Elapsed";
import { Markdown } from "./Markdown";
import { useSmoothText } from "./smooth-text";
import type { DelegationTask, DelegationWorker } from "./conversation";
import { cleanBriefTitle, groupWorkerLog, summarizeOutput, workerLogRows, type ItemStatus, type WorkerLogItem } from "./worker-log";
import type { SessionStatus } from "../server/types";
import { dateLocale, t, translatedMap } from "./i18n";
import { Beat } from "./Beat";
import { useDraft } from "./app/draft-store";

const statuses = translatedMap<SessionStatus>({ running: "status.running", done: "status.done", error: "status.error", stopped: "status.stopped" });
const itemStatuses = translatedMap<ItemStatus>({ in_progress: "worker.inProgress", completed: "worker.succeeded", failed: "worker.failed" });
const changeLabels = translatedMap({ add: "worker.add", modify: "worker.modify", delete: "worker.delete" });
const clockTime = (time: string) => new Date(time).toLocaleTimeString(dateLocale(), { hour12: false });
const LONG_TEXT = 160;

function Chevron({ open }: { open: boolean }) {
  return <svg className={`wt-chevron${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** `● name  detail` with an optional `⎿ summary` under it; the full output opens below. */
function CallLine({ item, state }: { item: WorkerLogItem; state: ItemStatus }) {
  const [open, setOpen] = useState(false);
  const { row } = item;
  const output = item.output?.trim() ?? "";
  const summary = output ? summarizeOutput(output) : undefined;
  const failedExit = row.exitCode !== undefined && row.exitCode !== 0 ? t("worker.exitCode", { code: row.exitCode }) : "";
  const showResult = summary || failedExit || row.output !== undefined;
  const expandable = !!summary && (summary.extraLines > 0 || output.length > summary.line.length);
  const body = <>
    <span className="wt-call-head">
      <span className={`wt-dot ${state}`} role="img" aria-label={itemStatuses[state]} />
      <strong className="wt-name">{item.name || t("worker.result")}</strong>
      {item.detail && <code className="wt-arg">{item.detail}</code>}
      {expandable && <Chevron open={open} />}
    </span>
    {showResult && <span className="wt-result">
      <span className="wt-elbow" aria-hidden="true">⎿</span>
      <span className="wt-result-line">{summary?.line || (row.output !== undefined ? t("worker.noOutput") : "")}{failedExit}</span>
      {summary && summary.extraLines > 0 && <span className="wt-more">{t("worker.moreLines", { n: summary.extraLines })}</span>}
    </span>}
  </>;
  return <div className={`wt-call wt-${row.type}`} title={clockTime(row.event.time)}>
    {expandable
      ? <button type="button" className="wt-call-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{body}</button>
      : <div className="wt-call-toggle">{body}</div>}
    {row.changes && row.changes.length > 0 && <ul className="wt-changes">{row.changes.map((change, index) => <li key={`${change.path}-${index}`}><span className={`wt-change-kind ${change.kind}`}>{changeLabels[change.kind]}</span><code>{change.path}</code></li>)}</ul>}
    {open && <pre className="wt-output"><code>{output}</code></pre>}
  </div>;
}

/** Error/warning: one tinted line; long text expands in place. */
function AlertLine({ item }: { item: WorkerLogItem }) {
  const [open, setOpen] = useState(false);
  const text = item.row.text.trim();
  const summary = summarizeOutput(text);
  const expandable = summary.extraLines > 0 || text.length > LONG_TEXT;
  const line = <><span className="wt-alert-line">{summary.line}</span>{expandable && <Chevron open={open} />}</>;
  return <div className={`wt-alert ${item.row.type}`} role={item.row.type === "error" ? "alert" : undefined} title={clockTime(item.row.event.time)}>
    {expandable ? <button type="button" className="wt-alert-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{line}</button> : <div className="wt-alert-toggle">{line}</div>}
    {open && <pre className="wt-output"><code>{text}</code></pre>}
  </div>;
}

function itemState(item: WorkerLogItem, isLastCall: boolean, running: boolean): ItemStatus {
  if (item.row.status) return item.row.status;
  return isLastCall && running && item.output === undefined ? "in_progress" : "completed";
}

function TaskLog({ task, index }: { task: DelegationTask; index: number }) {
  const items = groupWorkerLog(workerLogRows(task.thread));
  let lastCall = -1;
  items.forEach((item, itemIndex) => { if (item.name || item.output !== undefined) lastCall = itemIndex; });
  const title = cleanBriefTitle(task.event.text) || task.event.text;
  const briefHasMore = task.event.text.trim() !== title;
  return <section className="worker-task-log" aria-labelledby={`worker-task-${task.event.id}`}>
    <div className="worker-task-divider wt-divider"><span>{t("worker.taskN", { n: index + 1 })}</span><strong id={`worker-task-${task.event.id}`} title={title}>{title}</strong><span className={`status-label ${task.status}`}>{task.status === "running" && <Beat />}{statuses[task.status]}</span><Elapsed start={task.startedAt} end={task.endedAt} /></div>
    {briefHasMore && <details className="wt-brief"><summary>{t("worker.showBrief")}</summary><div className="wt-brief-body"><Markdown text={task.event.text} /></div></details>}
    <div className="wt-transcript">
      {items.map((item, itemIndex) => {
        const { row } = item;
        const key = row.event.id;
        if (row.type === "message" || row.type === "delegation") return <div className="wt-prose" key={key} title={clockTime(row.event.time)}><Markdown text={row.text} /></div>;
        if (row.type === "error" || row.type === "warning") return <AlertLine key={key} item={item} />;
        if (row.type === "status" || row.type === "handoff" || (row.type === "tool" && !item.name && item.output === undefined)) return <p className="wt-note" key={key} title={clockTime(row.event.time)}>{row.text}</p>;
        return <CallLine key={key} item={item} state={itemState(item, itemIndex === lastCall, task.status === "running")} />;
      })}
    </div>
    {!task.thread.length && <p className="thread-empty">{task.status === "running" ? t("worker.preparing") : t("worker.noHistory")}</p>}
  </section>;
}

/** What the worker is writing right now, revealed smoothly until the stored message replaces it. */
function WorkerDraft({ draftKey }: { draftKey: string }) {
  // Subscribes to this one draft so its ~50ms frames re-render only this block.
  const text = useDraft(draftKey)?.text ?? "";
  const shown = useSmoothText(text);
  if (!text) return null;
  return <div className="wt-draft streaming-message" aria-busy="true"><Markdown text={shown} /></div>;
}

export function WorkerThread({ worker, draftKey }: { worker: DelegationWorker; draftKey?: string }) {
  return <div className="worker-thread" role="log" aria-label={t("worker.logLabel")} aria-live="off">
    <div className="worker-thread-heading"><AgentMark agent={worker.agent} /><strong>{worker.label} · {t("worker.taskCount", { n: worker.tasks.length })}</strong><span className={`status-label ${worker.status}`}>{worker.status === "running" && <Beat />}{statuses[worker.status]}</span></div>
    {worker.tasks.map((task, index) => <TaskLog key={task.event.id} task={task} index={index} />)}
    {draftKey && <WorkerDraft draftKey={draftKey} />}
  </div>;
}
