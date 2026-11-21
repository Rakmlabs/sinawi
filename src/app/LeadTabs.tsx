import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { List, Plug, Plus, Search, Settings2, X } from "lucide-react";
import { hiddenTabs, reopenRunning, saveHiddenTabs, visibleTabs } from "../lead-tree";
import { LeadChatList } from "./LeadChatList";
import { AgentMark } from "../AgentMark";
import type { Session } from "../../server/types";
import { Beat } from "../Beat";
import { goalProgress } from "../goal-progress";
import { leadHue } from "../lead";
export { threadTabs } from "../lead";
import { t, useT } from "../i18n";
import { originLabel } from "../origin";
import { names, statusLabels } from "./labels";
import "../lead-tabs.css";

/** Asks the open lead chat's StewardPanel to show its settings drawer (the button lives in the tab bar). */
export const LEAD_SETTINGS_EVENT = "sinawi:lead-settings";

export type LeadTabsProps = {
  stewardId: string;
  name: string;
  /** The lead's chats, oldest first: a tab keeps its place while others are added. */
  threads: Session[];
  /** The chat shown now; unset while a new chat of this lead is being written. */
  activeId?: string;
  busy?: boolean;
  /** The lead's own CLI: a chat running another one (a quota switch, an outside AI's pick) says so on its tab. */
  leadAgent?: string;
  onSelect: (id: string) => void;
  /** A worker of one of the lead's chats (the chat list under the "all chats" button). */
  onSelectWorker?: (sessionId: string, workerId: string) => void;
  onNew: () => void;
  onRename?: (id: string, title: string) => Promise<boolean>;
};

/**
 * One lead, several chats: tabs above the conversation, like a browser's. Each tab is its own chat
 * (own messages and CLI session); the lead's folder, instructions, skills and notes are shared. A tab
 * opened by an outside AI over MCP shows a plug and who opened it.
 */
export const LeadTabs = memo(function LeadTabs({ stewardId, name, threads: allThreads, activeId, busy, leadAgent, onSelect, onSelectWorker, onNew, onRename }: LeadTabsProps) {
  useT();
  const list = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; value: string }>();
  // Closed tabs (this browser only): the chat stays, in the list below and in the sidebar.
  const [hidden, setHidden] = useState(() => hiddenTabs(stewardId));
  useEffect(() => setHidden(hiddenTabs(stewardId)), [stewardId]);
  // A closed tab that runs again stays open afterwards, so its result is not missed.
  useEffect(() => {
    const next = reopenRunning(allThreads, hidden);
    if (next !== hidden) { setHidden(next); saveHiddenTabs(stewardId, next); }
  }, [allThreads, hidden, stewardId]);
  const threads = visibleTabs(allThreads, hidden, activeId);
  const closeTab = (id: string) => {
    const next = new Set(hidden); next.add(id);
    setHidden(next); saveHiddenTabs(stewardId, next);
    if (id !== activeId) return;
    // Closing the open tab shows its neighbour, like a browser.
    const at = threads.findIndex((thread) => thread.id === id);
    const neighbour = threads[at + 1] ?? threads[at - 1];
    if (neighbour) onSelect(neighbour.id);
  };
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const allButton = useRef<HTMLButtonElement>(null);
  // A closed list starts fresh: the next open shows every chat, not the last search.
  const closeList = () => { setListOpen(false); setQuery(""); };
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listOpen) return;
    const away = (event: MouseEvent) => { if (!panel.current?.parentElement?.contains(event.target as Node)) { setListOpen(false); setQuery(""); } };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [listOpen]);
  const pick = (id: string) => {
    if (hidden.has(id)) { const next = new Set(hidden); next.delete(id); setHidden(next); saveHiddenTabs(stewardId, next); }
    setListOpen(false); setQuery("");
    onSelect(id);
  };
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = () => {
    const box = list.current;
    if (!box) return;
    setEdges({ start: box.scrollLeft > 2, end: box.scrollLeft + box.clientWidth < box.scrollWidth - 2 });
  };
  useEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>("[aria-selected='true']");
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
  }, [activeId, threads.length]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const focusTab = (index: number) => {
    const tabs = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [])];
    const tab = tabs[(index + tabs.length) % tabs.length];
    tab?.focus();
    tab?.click();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [])];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const move = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    focusTab(move);
  };
  const commit = async () => {
    if (!editing || !onRename) return;
    const value = editing.value.trim();
    const current = threads.find((thread) => thread.id === editing.id);
    if (!value || value === current?.title) { setEditing(undefined); return; }
    if (await onRename(editing.id, value)) setEditing(undefined);
  };
  const label = t("leadTabs.label", { name });
  return <nav className="lead-tabs" aria-label={label}>
    <span className="lead-tabs-name" title={name}>
      <span className="lead-tabs-avatar" style={{ background: `hsl(${leadHue(name)} 52% 44%)` }} aria-hidden="true">{[...name][0]?.toUpperCase()}</span>
      <strong>{name}</strong>
    </span>
    <div ref={list} className={`lead-tabs-list${edges.start ? " fade-start" : ""}${edges.end ? " fade-end" : ""}`} role="tablist" aria-label={label} onKeyDown={onKeyDown} onScroll={measure}>
      {threads.map((thread) => {
        const selected = thread.id === activeId;
        const progress = goalProgress(thread);
        const via = thread.origin ? originLabel(thread.origin) : "";
        const runner = `${names[thread.agent] ?? thread.agent}${thread.model ? ` ${thread.model}` : ""}`;
        const otherAgent = Boolean(leadAgent && thread.agent !== leadAgent);
        if (editing?.id === thread.id) return <input key={thread.id} className="lead-tab-rename" autoFocus aria-label={t("side.chatName")} maxLength={100} value={editing.value}
          onChange={(event) => setEditing({ id: thread.id, value: event.target.value })} onBlur={() => void commit()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(undefined); } }} />;
        return <span key={thread.id} className={`lead-tab-wrap${selected ? " active" : ""}`}><button type="button" role="tab" id={`lead-tab-${thread.id}`} aria-selected={selected} tabIndex={selected || (!activeId && thread === threads.at(-1)) ? 0 : -1}
          className={`lead-tab${selected ? " active" : ""} ${thread.status}`}
          onKeyDown={(event) => { if ((event.key === "Delete" || event.key === "Backspace") && thread.status !== "running") { event.preventDefault(); closeTab(thread.id); } }}
          title={[thread.title, statusLabels[thread.status], runner, via && t("origin.openedBy", { name: via }), onRename ? t("leadTabs.renameHint") : ""].filter(Boolean).join(" · ")}
          onClick={() => onSelect(thread.id)} onDoubleClick={() => onRename && setEditing({ id: thread.id, value: thread.title })}>
          {thread.status === "running" ? <span className="lead-tab-state running" role="img" aria-label={statusLabels.running}><Beat /></span>
            : <span className={`lead-tab-state ${thread.status}`} role="img" aria-label={statusLabels[thread.status]} />}
          {via && <Plug size={12} className="lead-tab-origin" aria-label={t("origin.openedBy", { name: via })} />}
          <AgentMark agent={thread.agent} size="small" />
          <span className="lead-tab-title">{thread.title}</span>
          {otherAgent && <small className="lead-tab-agent">{names[thread.agent] ?? thread.agent}</small>}
          {progress && <small className="lead-tab-progress">{progress.done}/{progress.total}</small>}
        </button>
        {thread.status !== "running" && <button type="button" className="lead-tab-close" tabIndex={-1} aria-label={t("leadTabs.close", { title: thread.title })} title={t("leadTabs.close", { title: thread.title })} onClick={() => closeTab(thread.id)}><X size={12} aria-hidden="true" /></button>}
        </span>;
      })}
      {!activeId && <span className="lead-tab active draft" role="tab" aria-selected="true" tabIndex={-1}><span className="lead-tab-title">{t("leadTabs.newTab")}</span></span>}
    </div>
    <span className="lead-tabs-all-wrap">
      <button type="button" className={`lead-tabs-all${listOpen ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={listOpen} title={t("leadTabs.all", { n: allThreads.length })} aria-label={t("leadTabs.all", { n: allThreads.length })}
        ref={allButton} onClick={() => listOpen ? closeList() : setListOpen(true)}>
        <List size={15} aria-hidden="true" /><span>{t("leadTabs.allShort", { n: allThreads.length })}</span>
        {allThreads.some((thread) => thread.status === "running") && <span className="lead-tabs-all-running" aria-hidden="true" />}
      </button>
      {listOpen && <div ref={panel} className="lead-tabs-panel" role="dialog" aria-label={t("leadTabs.allTitle", { name })}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeList(); allButton.current?.focus(); } }}>
        <div className="lead-tabs-panel-head">
          <label className="lead-tabs-search"><Search size={14} aria-hidden="true" /><input autoFocus type="search" value={query} placeholder={t("leadTabs.search")} aria-label={t("leadTabs.search")} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className="lead-tabs-new" disabled={busy || !activeId} onClick={() => { setListOpen(false); onNew(); }}><Plus size={15} aria-hidden="true" /><span>{t("leadTabs.new")}</span></button>
        </div>
        <div className="lead-tabs-panel-body">
          <LeadChatList chats={allThreads} query={query} selectedId={activeId} onSelect={pick} onSelectWorker={onSelectWorker ? (sessionId, workerId) => { setListOpen(false); onSelectWorker(sessionId, workerId); } : undefined} limit={50} variant="panel" />
        </div>
        {allThreads.length > threads.length && <p className="lead-tabs-panel-note">{t("leadTabs.hiddenNote", { n: allThreads.length - threads.length })}</p>}
      </div>}
    </span>
    <button type="button" className="lead-tabs-new" disabled={busy || !activeId} onClick={onNew} title={t("side.leadNewThread", { name })} aria-label={t("side.leadNewThread", { name })}>
      <Plus size={15} aria-hidden="true" /><span>{t("leadTabs.new")}</span>
    </button>
    {activeId && <button type="button" className="lead-tabs-settings" title={t("steward.more")} aria-label={t("steward.more")} aria-haspopup="dialog"
      onClick={() => window.dispatchEvent(new CustomEvent(LEAD_SETTINGS_EVENT, { detail: { sessionId: activeId, stewardId } }))}>
      <Settings2 size={15} aria-hidden="true" />
    </button>}
  </nav>;
});
