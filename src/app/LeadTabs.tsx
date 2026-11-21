import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Plug, Plus, Settings2 } from "lucide-react";
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
  onNew: () => void;
  onRename?: (id: string, title: string) => Promise<boolean>;
};

/**
 * One lead, several chats: tabs above the conversation, like a browser's. Each tab is its own chat
 * (own messages and CLI session); the lead's folder, instructions, skills and notes are shared. A tab
 * opened by an outside AI over MCP shows a plug and who opened it.
 */
export const LeadTabs = memo(function LeadTabs({ stewardId, name, threads, activeId, busy, leadAgent, onSelect, onNew, onRename }: LeadTabsProps) {
  useT();
  const list = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; value: string }>();
  useEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>("[aria-selected='true']");
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, threads.length]);
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
    <div ref={list} className="lead-tabs-list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {threads.map((thread) => {
        const selected = thread.id === activeId;
        const progress = goalProgress(thread);
        const via = thread.origin ? originLabel(thread.origin) : "";
        const runner = `${names[thread.agent] ?? thread.agent}${thread.model ? ` ${thread.model}` : ""}`;
        const otherAgent = Boolean(leadAgent && thread.agent !== leadAgent);
        if (editing?.id === thread.id) return <input key={thread.id} className="lead-tab-rename" autoFocus aria-label={t("side.chatName")} maxLength={100} value={editing.value}
          onChange={(event) => setEditing({ id: thread.id, value: event.target.value })} onBlur={() => void commit()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(undefined); } }} />;
        return <button key={thread.id} type="button" role="tab" id={`lead-tab-${thread.id}`} aria-selected={selected} tabIndex={selected || (!activeId && thread === threads.at(-1)) ? 0 : -1}
          className={`lead-tab${selected ? " active" : ""} ${thread.status}`}
          title={[thread.title, statusLabels[thread.status], runner, via && t("origin.openedBy", { name: via }), onRename ? t("leadTabs.renameHint") : ""].filter(Boolean).join(" · ")}
          onClick={() => onSelect(thread.id)} onDoubleClick={() => onRename && setEditing({ id: thread.id, value: thread.title })}>
          {thread.status === "running" ? <span className="lead-tab-state running" role="img" aria-label={statusLabels.running}><Beat /></span>
            : <span className={`lead-tab-state ${thread.status}`} role="img" aria-label={statusLabels[thread.status]} />}
          {via && <Plug size={12} className="lead-tab-origin" aria-label={t("origin.openedBy", { name: via })} />}
          <span className="lead-tab-title">{thread.title}</span>
          {otherAgent && <small className="lead-tab-agent">{names[thread.agent] ?? thread.agent}</small>}
          {progress && <small className="lead-tab-progress">{progress.done}/{progress.total}</small>}
        </button>;
      })}
      {!activeId && <span className="lead-tab active draft" role="tab" aria-selected="true" tabIndex={-1}><span className="lead-tab-title">{t("leadTabs.newTab")}</span></span>}
    </div>
    <button type="button" className="lead-tabs-new" disabled={busy || !activeId} onClick={onNew} title={t("side.leadNewThread", { name })} aria-label={t("side.leadNewThread", { name })}>
      <Plus size={15} aria-hidden="true" /><span>{t("leadTabs.new")}</span>
    </button>
    {activeId && <button type="button" className="lead-tabs-settings" title={t("steward.more")} aria-label={t("steward.more")} aria-haspopup="dialog"
      onClick={() => window.dispatchEvent(new CustomEvent(LEAD_SETTINGS_EVENT, { detail: { sessionId: activeId, stewardId } }))}>
      <Settings2 size={15} aria-hidden="true" />
    </button>}
  </nav>;
});
