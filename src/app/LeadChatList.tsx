import { useState } from "react";
import { ChevronRight, Plug } from "lucide-react";
import type { Session } from "../../server/types";
import { AgentMark } from "../AgentMark";
import { Beat } from "../Beat";
import { formatElapsed } from "../conversation";
import { t, useT } from "../i18n";
import { chatRows, shortAgo, type ChatRow } from "../lead-tree";
import { useNow } from "./clock";
import { statusLabels } from "./labels";

type Props = {
  chats: Session[];
  query?: string;
  selectedId?: string;
  selectedWorker?: string;
  onSelect: (id: string) => void;
  onSelectWorker?: (sessionId: string, workerId: string) => void;
  /** Chats a chat split its work into (goal chats, parentId): listed with its workers. */
  childChats?: (id: string) => Session[];
  /** Rows shown before "N more" (running and open chats always show). */
  limit?: number;
  /** Inside a popover: every row is a plain button, no hover-only parts. */
  variant?: "sidebar" | "panel";
};

function State({ status, empty = false }: { status: Session["status"]; empty?: boolean }) {
  if (status === "running") return <span className="lcl-state running" role="img" aria-label={statusLabels.running}><Beat /></span>;
  // Nothing said yet: not "done", just empty.
  if (empty) return <span className="lcl-state empty" role="img" aria-label={t("lcl.empty")} />;
  return <span className={`lcl-state ${status}`} role="img" aria-label={statusLabels[status]} />;
}

/**
 * A lead's chats, and under each the workers it put to work: status, agent, what it is doing, how
 * long, and who opened the chat when it was an outside AI. Running and open chats show their workers;
 * the rest fold them behind a count.
 */
export function LeadChatList({ chats, query = "", selectedId, selectedWorker, onSelect, onSelectWorker, childChats, limit = 6, variant = "sidebar" }: Props) {
  useT();
  const anyRunning = chats.some((chat) => chat.status === "running");
  const now = useNow(anyRunning ? 1_000 : 30_000);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows = chatRows(chats, query, now);
  const pinned = (row: ChatRow) => row.session.status === "running" || row.session.id === selectedId;
  const shown = all || query ? rows : rows.filter((row, index) => index < limit || pinned(row));
  const hidden = rows.length - shown.length;
  if (!rows.length) return <p className="lcl-empty">{query ? t("side.noResults") : t("lcl.noChats")}</p>;
  return <ul className={`lead-chat-list ${variant}`}>
    {shown.map((row) => {
      const { session } = row;
      const children = childChats?.(session.id) ?? [];
      const selected = session.id === selectedId && !selectedWorker;
      const expanded = open.has(session.id) || session.status === "running" || session.id === selectedId || Boolean(query);
      const toggle = () => setOpen((old) => { const next = new Set(old); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; });
      const time = session.status === "running" ? formatElapsed(Date.parse([...session.events].reverse().find((event) => event.agent === "user")?.time ?? session.createdAt), now) : shortAgo(row.lastAt, now);
      return <li key={session.id} className="lcl-chat">
        <div className={`lcl-row${selected ? " active" : ""}`}>
          <button type="button" className="lcl-open" aria-current={selected ? "page" : undefined} onClick={() => onSelect(session.id)}
            title={[session.title, statusLabels[session.status], row.openedBy && t("origin.openedBy", { name: row.openedBy })].filter(Boolean).join(" · ")}>
            <State status={session.status} empty={!session.events.some((event) => event.type === "message")} />
            {row.openedBy && <Plug size={12} className="lcl-origin" aria-label={t("origin.openedBy", { name: row.openedBy })} />}
            <span className="lcl-title">{session.title}</span>
            {row.runningWorkers > 0 && <small className="lcl-count running">{t("lcl.workersRunning", { n: row.runningWorkers })}</small>}
            <time className="lcl-time">{time}</time>
          </button>
          {row.workers.length > 0 && !expanded && <button type="button" className="lcl-fold" aria-expanded={false} aria-label={t("lcl.showWorkers", { n: row.workers.length, title: session.title })} onClick={toggle}>
            <ChevronRight size={13} aria-hidden="true" /><span>{row.workers.length}</span>
          </button>}
          {row.workers.length > 0 && expanded && open.has(session.id) && session.status !== "running" && session.id !== selectedId && <button type="button" className="lcl-fold open" aria-expanded aria-label={t("lcl.hideWorkers", { title: session.title })} onClick={toggle}>
            <ChevronRight size={13} aria-hidden="true" />
          </button>}
        </div>
        {expanded && children.length > 0 && <ul className="lcl-workers" aria-label={t("side.subChats", { title: session.title })}>
          {children.map((child) => <li key={child.id}><button type="button" className={`lcl-worker${child.id === selectedId ? " active" : ""}`} aria-current={child.id === selectedId ? "page" : undefined} onClick={() => onSelect(child.id)} title={`${child.title} · ${statusLabels[child.status]}`}>
            <State status={child.status} />
            <AgentMark agent={child.agent} size="small" />
            <span className="lcl-worker-copy"><span className="lcl-title">{child.title}</span></span>
            <time className="lcl-time">{shortAgo(child.events.at(-1)?.time ?? child.createdAt, now)}</time>
          </button></li>)}
        </ul>}
        {expanded && row.workers.length > 0 && <ul className="lcl-workers" aria-label={t("side.workerSessions", { title: session.title })}>
          {row.workers.map((worker) => {
            const active = session.id === selectedId && selectedWorker === worker.id;
            return <li key={worker.id}><button type="button" className={`lcl-worker${active ? " active" : ""}`} aria-current={active ? "page" : undefined}
              disabled={!onSelectWorker} onClick={() => onSelectWorker?.(session.id, worker.id)} title={`${worker.label} · ${statusLabels[worker.status]} · ${worker.task}`}>
              <State status={worker.status} />
              <AgentMark agent={worker.agent} size="small" />
              <span className="lcl-worker-copy"><span className="lcl-title">{worker.label}</span><small>{worker.task}</small></span>
              <time className="lcl-time">{formatElapsed(Date.parse(worker.startedAt), worker.endedAt ? Date.parse(worker.endedAt) : now)}</time>
            </button></li>;
          })}
        </ul>}
      </li>;
    })}
    {hidden > 0 && <li><button type="button" className="lcl-more" onClick={() => setAll(true)}>{t("lcl.more", { n: hidden })}</button></li>}
    {all && rows.length > limit && !query && <li><button type="button" className="lcl-more" onClick={() => setAll(false)}>{t("lcl.less")}</button></li>}
  </ul>;
}
