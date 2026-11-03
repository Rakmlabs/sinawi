import { terminalOwnsKeyboardEvent } from "./terminal-events";
import { AgentMark } from "./AgentMark";
import { goalProgress } from "./goal-progress";
import { useEffect, useReducer, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, groupTree, type MenuItem } from "./SidebarMenu";
import { delegationWorkers } from "./conversation";
import type { Group, Session, SessionStatus, WorkspaceId } from "../server/types";
import { BarChart3, Bot, Check, ChevronRight, CircleHelp, Eye, FolderInput, Folder, Pencil, Trash2, ArrowLeftRight, FolderOpen, MoreHorizontal, Plus, RotateCw, Search, Settings2, SquarePen, WandSparkles, Wrench, X } from "lucide-react";
import { searchWorkspace, workspaceName } from "./workspaces";
import { useWorkspaces } from "./workspace-context";
import { reloadApp } from "./reload";
import { isMacPlatform } from "./sidebar-rail";
import { Beat } from "./Beat";
import { DeleteDialog } from "./DeleteDialog";
import { t, translatedMap } from "./i18n";

const agentNames: Record<Session["agent"], string> = { claude: "Claude", codex: "Codex", grok: "Grok Build" };
const statusLabels = translatedMap<SessionStatus>({ running: "status.running", done: "status.done", error: "status.error", stopped: "status.stopped" });
type SidebarProps = {
  /** DOM id the title-bar toggle points at (aria-controls). */ id?: string; /** Off-screen: removed from focus order and the accessibility tree. */ closed?: boolean; tab: string; onNavigate: (tab: string) => void; onSkills: () => void; connected: boolean;
  selectedWorker?: string; onSelectWorker?: (sessionId: string, workerId: string) => void;
  sessions: Session[]; groups: Group[]; busy: boolean; selected?: string; onNew: (groupId?: string) => void; onSelect: (id: string) => void; onHelp: () => void;
  onCreateGroup: (name: string) => Promise<boolean>; onRenameGroup: (id: string, name: string) => Promise<boolean>; onDeleteGroup: (id: string) => Promise<boolean>;
  onRenameSession: (id: string, title: string) => Promise<boolean>; onDeleteSession: (id: string, removeWorktrees?: boolean) => Promise<boolean>; onAssign: (id: string, groupId: string | null) => Promise<boolean>;
  workspaceId?: WorkspaceId;
  onMoveSession?: (id: string, workspaceId: WorkspaceId) => Promise<boolean>; onMoveGroup?: (id: string, workspaceId: WorkspaceId) => Promise<boolean>;
  onUsage?: () => void;
  /** Opens the settings window (⌘,); without it "Settings" falls back to the legacy settings tab. */
  onSettings?: () => void;
  onDeleteWorker?: (sessionId: string, workerId: string) => Promise<boolean>;
};
type MenuState = { kind: "session" | "group" | "worker"; id: string; workerId?: string; x: number; y: number };
const UNGROUPED = "__ungrouped__";
type Editor = { kind: "create" | "group" | "session"; id: string; value: string };

type WorkerTreeState = { expanded: Set<string>; activation?: string };
type WorkerTreeAction = { type: "toggle"; id: string } | { type: "activate"; id?: string; taskKey: string; workerId?: string };
export function workerTreeReducer(state: WorkerTreeState, action: WorkerTreeAction): WorkerTreeState {
  if (action.type === "toggle") {
    const expanded = new Set(state.expanded);
    if (expanded.has(action.id)) expanded.delete(action.id); else expanded.add(action.id);
    return { ...state, expanded };
  }
  const activation = JSON.stringify([action.id, action.taskKey, action.workerId]);
  if (activation === state.activation) return state;
  return { activation, expanded: action.id ? new Set([...state.expanded, action.id]) : state.expanded };
}

export function Sidebar(props: SidebarProps) {
  const { closed: railClosed, tab, onNavigate, onSkills, connected, sessions, groups, busy, selected, onNew, onSelect, onHelp } = props;
  const { workspaces } = useWorkspaces();
  const [footerMenu, setFooterMenu] = useState<{ x: number; y: number }>();
  const [workerTree, dispatchWorkerTree] = useReducer(workerTreeReducer, { expanded: new Set(selected ? [selected] : []) });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const activeSession = sessions.find((session) => session.id === selected);
  const taskKey = JSON.stringify(activeSession?.events.filter((event) => event.type === "delegation").map((event) => event.id) ?? []);
  useEffect(() => {
    dispatchWorkerTree({ type: "activate", id: selected, taskKey, workerId: props.selectedWorker });
    if (!selected) return;
    if (activeSession?.groupId) setClosed((old) => { const next = new Set(old); next.delete(activeSession.groupId!); return next; });
  }, [selected, taskKey, props.selectedWorker, activeSession?.groupId]);
  const [editor, setEditor] = useState<Editor>();
  const [menuState, setMenuState] = useState<MenuState>();
  const menu = menuState?.kind === "worker" ? undefined : menuState?.id;
  const setMenu = (id: undefined) => setMenuState(id);
  const openMenu = (kind: MenuState["kind"], id: string, event: { clientX: number; clientY: number; currentTarget: Element }, fromButton = false, workerId?: string) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenuState({ kind, id, workerId, x: fromButton ? box.right - 4 : event.clientX, y: fromButton ? box.bottom + 4 : event.clientY });
  };
  const [deletingWorker, setDeletingWorker] = useState<{ sessionId: string; workerId: string; name: string; running: boolean }>();
  const [drag, setDrag] = useState<{ id: string; title: string; agent: Session["agent"]; x: number; y: number }>();
  const [landed, setLanded] = useState<string>();
  const dragRef = useRef<{ id: string; title: string; agent: Session["agent"]; startX: number; startY: number; active: boolean; target?: string; hoverTimer?: number }>(undefined);
  const [deleting, setDeleting] = useState<{ kind: "group" | "session"; id: string; name: string }>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [query, setQuery] = useState("");
  // Sessions and groups arrive already scoped to the current workspace.
  const scoped = { sessions, groups };
  const results = searchWorkspace(sessions, groups, undefined, query);
  // A chat's goal chats sit under it (server/goals.ts), not in the list on their own.
  const shownIds = new Set(results.sessions.map((session) => session.id));
  const subChats = (id: string) => results.sessions.filter((session) => session.parentId === id);
  const visibleSessions = results.sessions.filter((session) => !session.parentId || !shownIds.has(session.parentId));
  const visibleGroups = results.groups;
  const searching = Boolean(query.trim());
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event)) return;
      if (event.key === "Escape") { setMenu(undefined); setEditor(undefined); setDeleting(undefined); setDeletingWorker(undefined); if (dragRef.current?.active) cancelDrag(); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const expand = (id: string) => setClosed((old) => { const next = new Set(old); next.delete(id); return next; });
  const cleanupDrag = useRef<() => void>(undefined);
  const cancelDrag = () => { cleanupDrag.current?.(); };
  useEffect(() => () => cleanupDrag.current?.(), []);
  const startDrag = (event: ReactPointerEvent, session: Session) => {
    if (busy || event.button !== 0 || !(event.target instanceof Element) || event.target.closest(".sidebar-row-action, .sidebar-chat-toggle, input")) return;
    cleanupDrag.current?.();
    dragRef.current = { id: session.id, title: session.title, agent: session.agent, startX: event.clientX, startY: event.clientY, active: false };
    const setTarget = (target: string | undefined) => {
      const state = dragRef.current!;
      if (state.target === target) return;
      state.target = target; setDropTarget(target);
      window.clearTimeout(state.hoverTimer);
      if (target && target !== UNGROUPED) state.hoverTimer = window.setTimeout(() => expand(target), 550);
    };
    const move = (move: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.active) {
        if (Math.hypot(move.clientX - state.startX, move.clientY - state.startY) < 5) return;
        state.active = true; setMenu(undefined); document.body.classList.add("sidebar-dragging");
      }
      move.preventDefault();
      setDrag({ id: state.id, title: state.title, agent: state.agent, x: move.clientX, y: move.clientY });
      const zone = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>("[data-drop-group]");
      setTarget(zone?.dataset.dropGroup);
      const nav = document.getElementById("sidebar-links");
      if (nav) { const box = nav.getBoundingClientRect(); if (move.clientY < box.top + 28) nav.scrollTop -= 8; else if (move.clientY > box.bottom - 28) nav.scrollTop += 8; }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const state = dragRef.current;
      dragRef.current = undefined; cleanupDrag.current = undefined;
      document.body.classList.remove("sidebar-dragging");
      setDrag(undefined); setDropTarget(undefined);
      if (!state?.active) return;
      window.clearTimeout(state.hoverTimer);
      const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (!commit || !state.target) return;
      const groupId = state.target === UNGROUPED ? null : state.target;
      const current = sessions.find((item) => item.id === state.id);
      const currentGroup = current?.groupId && scoped.groups.some((group) => group.id === current.groupId) ? current.groupId : null;
      if (!current || currentGroup === groupId) return;
      void props.onAssign(state.id, groupId).then((ok) => {
        if (!ok) return;
        const key = groupId ?? UNGROUPED;
        if (groupId) expand(groupId);
        setLanded(key); window.setTimeout(() => setLanded((value) => value === key ? undefined : value), 700);
      });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    cleanupDrag.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
  const dropClass = (key: string) => `${dropTarget === key ? " drop-target" : ""}${landed === key ? " drop-landed" : ""}`;
  const moveTree = (session: Session) => groupTree(scoped.groups, session.groupId);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor?.value.trim() || busy) return;
    const value = editor.value.trim();
    const ok = editor.kind === "create" ? await props.onCreateGroup(value) : editor.kind === "group" ? await props.onRenameGroup(editor.id, value) : await props.onRenameSession(editor.id, value);
    if (ok) setEditor(undefined);
  };
  const editForm = (current: Editor) => <form className="sidebar-edit" onSubmit={(event) => void save(event)}>
    <input autoFocus aria-label={current.kind === "session" ? t("side.chatName") : t("side.projectName")} maxLength={100} value={current.value} onChange={(event) => setEditor({ ...current, value: event.target.value })} />
    <button aria-label={t("side.saveName")} disabled={busy || !current.value.trim()}><Check size={14} /></button>
    <button type="button" aria-label={t("side.cancelRename")} onClick={() => setEditor(undefined)}><X size={14} /></button>
  </form>;
  const deleteDialog = () => {
    if (deletingWorker) {
      const { sessionId, workerId, name, running } = deletingWorker;
      return <DeleteDialog title={t("side.deleteWorkerConfirm", { name })} body={<p>{running ? t("side.runningStopsFirst") : ""}{t("side.deleteWorkerBody")}</p>} busy={busy}
        onCancel={() => setDeletingWorker(undefined)}
        actions={[{ label: t("side.delete"), primary: true, onClick: async () => { if (await props.onDeleteWorker!(sessionId, workerId)) setDeletingWorker(undefined); } }]} />;
    }
    if (!deleting) return null;
    const { kind, id, name } = deleting;
    if (kind === "group") return <DeleteDialog title={t("side.deleteProjectTitle", { name })} body={<p>{t("side.deleteProjectConfirm")}</p>} busy={busy}
      onCancel={() => setDeleting(undefined)}
      actions={[{ label: t("side.delete"), primary: true, onClick: async () => { if (await props.onDeleteGroup(id)) setDeleting(undefined); } }]} />;
    // Worker worktrees are kept by default; the extra button removes only those without uncommitted changes.
    const worktrees = sessions.find((item) => item.id === id)?.worktrees?.length ?? 0;
    return <DeleteDialog title={t("side.deleteChatConfirm", { name })} body={worktrees > 0 ? <p>{t("wt.deleteSessionNote", { count: worktrees })}</p> : undefined} busy={busy}
      onCancel={() => setDeleting(undefined)}
      actions={[
        ...(worktrees > 0 ? [{ label: t("wt.deleteClean"), onClick: async () => { if (await props.onDeleteSession(id, true)) setDeleting(undefined); } }] : []),
        { label: worktrees > 0 ? t("wt.deleteKeep") : t("side.delete"), primary: true, onClick: async () => { if (await props.onDeleteSession(id)) setDeleting(undefined); } },
      ]} />;
  };
  const sessionRow = (session: Session) => {
    const workers = delegationWorkers(session, Date.now());
    const open = workerTree.expanded.has(session.id);
    const parentActive = selected === session.id && tab === "workspace" && !props.selectedWorker;
    return <div key={session.id} className="sidebar-chat">

    {editor?.kind === "session" && editor.id === session.id ? editForm(editor) : <div className={`sidebar-row${drag?.id === session.id ? " dragging" : ""}`} draggable={false} data-draggable={!busy}
      onContextMenu={(event) => { event.preventDefault(); openMenu("session", session.id, event); }}
      onPointerDown={(event) => startDrag(event, session)}>
      <button className={`sidebar-chat-open ${parentActive ? "active" : ""}`} aria-current={parentActive ? "page" : undefined} title={`${session.title} · ${agentNames[session.agent]} · ${statusLabels[session.status]}`} onClick={() => onSelect(session.id)}>
        {session.status === "running" ? <span className="status-beat" role="img" aria-label={statusLabels.running}><Beat /></span> : <span className={`status-dot ${session.status}`} role="img" aria-label={statusLabels[session.status]} />}<span className="sidebar-session-title">{session.title}</span>
        {(() => { const progress = goalProgress(session); return progress && <small className="sidebar-goal-progress" title={t("goal.progressTitle", progress)}>{progress.done}/{progress.total}</small>; })()}
      </button>
      <button className={`sidebar-chat-toggle${open ? " open" : ""}`} aria-label={t(open ? "side.collapseWorkers" : "side.expandWorkers", { title: session.title })} aria-expanded={open} aria-controls={`workers-${session.id}`} onClick={() => dispatchWorkerTree({ type: "toggle", id: session.id })}><ChevronRight size={14} className={`folder-chevron ${open ? "open" : ""}`} /></button>
      <button className="sidebar-row-action" aria-label={t("side.chatMenuNamed", { title: session.title })} aria-haspopup="menu" aria-expanded={menu === session.id} onClick={(event) => menu === session.id ? setMenu(undefined) : openMenu("session", session.id, event, true)}><MoreHorizontal size={15} /></button>
    </div>}
    <ul className="sidebar-workers" id={`workers-${session.id}`} aria-label={t("side.workerSessions", { title: session.title })} hidden={!open}>
      {workers.map((worker) => {
        const latest = worker.tasks.at(-1)!;
        const event = latest.event;
        const config = session.workerConfigs?.find((item) => item.id === worker.id || (!item.id && item.agent === worker.agent));
        const model = config?.model || event.model || t("usage.cliDefaultModel");
        const workerActive = selected === session.id && props.selectedWorker === worker.id && tab === "workspace";
        const name = worker.label;
        return <li key={worker.id} className="sidebar-worker-item" onContextMenu={(event) => { if (!props.onDeleteWorker) return; event.preventDefault(); openMenu("worker", session.id, event, false, worker.id); }}><button id={`sidebar-worker-${session.id}-${worker.id}`} className={`sidebar-worker ${workerActive ? "active" : ""}`} aria-current={workerActive ? "page" : undefined} title={t("side.workerTitle", { name, model, n: worker.tasks.length, text: event.text })} onClick={() => props.onSelectWorker?.(session.id, worker.id)}>
          <AgentMark agent={worker.agent} size="small" /><span className="sidebar-chat-copy"><span className="sidebar-session-title">{name}</span><small title={model}>{model} · {t("side.workerTasks", { n: worker.tasks.length })}</small></span>{worker.status === "running" ? <span className="status-beat" role="img" aria-label={statusLabels.running}><Beat /></span> : <span className={`status-dot ${worker.status}`} role="img" aria-label={statusLabels[worker.status]} />}
        </button>
        {props.onDeleteWorker && <button className="sidebar-worker-delete" aria-label={t("side.deleteWorkerNamed", { name })} title={t("side.deleteWorker")} disabled={busy} onClick={() => setDeletingWorker({ sessionId: session.id, workerId: worker.id, name, running: worker.status === "running" })}><Trash2 size={14} /></button>}
</li>;
      })}
      {!workers.length && <li className="sidebar-empty">{session.status === "running" ? t("side.orchestratorHandling") : t("side.noWorkers")}</li>}
    </ul>
    {subChats(session.id).length > 0 && <div className="sidebar-subchats" aria-label={t("side.subChats", { title: session.title })}>{subChats(session.id).map(sessionRow)}</div>}
  </div>;
  };
  const ungrouped = visibleSessions.filter((session) => !visibleGroups.some((group) => group.id === session.groupId));
  const mac = isMacPlatform();
  const newChatKey = mac ? "⌘N" : "Ctrl+N";
  const searchKey = mac ? "⌘K" : "Ctrl+K";
  const footerItems: MenuItem[] = [
    { kind: "action", label: t("side.settings"), icon: <Settings2 size={15} />, meta: <kbd>{mac ? "⌘," : "Ctrl+,"}</kbd>, onSelect: () => props.onSettings ? props.onSettings() : onNavigate("routing") },
    { kind: "action", label: t("header.tools"), icon: <Wrench size={15} />, meta: <kbd>{mac ? "⌘⇧T" : "F3"}</kbd>, onSelect: () => onNavigate("tools") },
    { kind: "action", label: t("side.bots"), icon: <Bot size={15} />, onSelect: () => onNavigate("bots") },
    { kind: "action", label: t("side.skills"), icon: <WandSparkles size={15} />, onSelect: onSkills },
    ...(props.onUsage ? [{ kind: "action" as const, label: t("side.usage"), icon: <BarChart3 size={15} />, onSelect: props.onUsage }] : []),
    { kind: "separator" },
    { kind: "action", label: t("side.help"), icon: <CircleHelp size={15} />, onSelect: onHelp },
    { kind: "action", label: t("common.reload"), icon: <RotateCw size={15} />, meta: <kbd>{mac ? "⌘R" : "Ctrl+R"}</kbd>, onSelect: () => reloadApp() },
  ];
  const managementTab = ["routing", "tools", "bots", "usage"].includes(tab);
  return <aside id={props.id} className="rail" aria-label={t("side.label")} inert={railClosed || undefined}>
    <button className="sidebar-new" onClick={() => onNew()} aria-label={t("common.newChat")} title={`${t("common.newChat")} (${newChatKey})`}><SquarePen size={16} aria-hidden="true" /><span>{t("common.newChat")}</span><kbd aria-hidden="true">{newChatKey}</kbd></button>
    <label className="sidebar-search" title={`${t("side.search")} (${searchKey})`}><Search size={16} aria-hidden="true" /><input type="search" aria-label={t("side.search")} placeholder={t("side.searchShort")} value={query}
      onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />{!query && <kbd aria-hidden="true">{searchKey}</kbd>}</label>
    <nav id="sidebar-links" className="rail-main" aria-label={t("side.chatList")}>
      {searching && !visibleGroups.length && !visibleSessions.length && <p className="sidebar-search-empty" role="status">{t("side.noResults")}</p>}
      <section className="sidebar-projects" aria-label={t("side.projects")}>
        <div className="sidebar-section-heading"><h2>{t("side.projects")}</h2><button aria-label={t("ob.createProject")} title={t("ob.createProject")} disabled={busy} onClick={() => { setEditor({ kind: "create", id: "", value: "" }); setMenu(undefined); }}><Plus size={15} /></button></div>
        {editor?.kind === "create" && editForm(editor)}
        {!searching && !visibleGroups.length && <p className="sidebar-empty">{t("side.projectsEmpty")}</p>}
        {visibleGroups.map((group) => {
          const open = searching || !closed.has(group.id);
          const chats = visibleSessions.filter((session) => session.groupId === group.id);
          return <div key={group.id} className={`sidebar-project${dropClass(group.id)}`} data-drop-group={group.id}>
            {editor?.kind === "group" && editor.id === group.id ? editForm(editor) : <div className="sidebar-row" onContextMenu={(event) => { event.preventDefault(); openMenu("group", group.id, event); }}>
              <button className="sidebar-folder" aria-expanded={open} aria-controls={`project-${group.id}`} title={group.name} onClick={() => setClosed((old) => { const next = new Set(old); if (open) next.add(group.id); else next.delete(group.id); return next; })}>
                {open ? <FolderOpen size={18} /> : <Folder size={18} />}<span className="sidebar-session-title">{group.name}</span><small>{chats.length}</small>
              </button>
              <button className="sidebar-row-action" aria-label={t("side.newChatIn", { name: group.name })} title={t("side.newChatIn", { name: group.name })} disabled={busy} onClick={() => { onNew(group.id); expand(group.id); }}><Plus size={15} /></button>
              <button className="sidebar-row-action" aria-label={t("side.projectMenu", { name: group.name })} aria-haspopup="menu" aria-expanded={menu === group.id} onClick={(event) => menu === group.id ? setMenu(undefined) : openMenu("group", group.id, event, true)}><MoreHorizontal size={15} /></button>
            </div>}
            <div id={`project-${group.id}`} className="sidebar-project-chats" hidden={!open}>{dropTarget === group.id && drag && <div className="drop-slot" aria-hidden="true">{t("side.dropHere", { title: drag.title })}</div>}{chats.length ? chats.map(sessionRow) : <p className="sidebar-empty">{t("side.dropOrStart1")}<button onClick={() => onNew(group.id)}>{t("side.dropOrStart2")}</button></p>}</div>
          </div>;
        })}
      </section>
      <section className={`sidebar-recents${dropClass(UNGROUPED)}`} aria-label={t("side.recentChats")} data-drop-group={UNGROUPED}><div className="sidebar-section-heading"><h2>{t("side.recent")}</h2>{drag && <small className="drop-hint">{t("side.dropUnsorted")}</small>}</div>{dropTarget === UNGROUPED && drag && <div className="drop-slot" aria-hidden="true">{t("side.moveUnsorted", { title: drag.title })}</div>}{ungrouped.length ? ungrouped.map(sessionRow) : !searching ? <p className="sidebar-empty">{t("side.noChats")}</p> : null}</section>
    </nav>
    <div className="sidebar-footer">
      <button className={`sidebar-settings${managementTab ? " active" : ""}`} aria-haspopup="menu" aria-expanded={Boolean(footerMenu)} aria-current={managementTab ? "page" : undefined}
        onClick={(event) => { if (footerMenu) { setFooterMenu(undefined); return; } const box = event.currentTarget.getBoundingClientRect(); setFooterMenu({ x: box.left, y: box.top - 6 }); }}>
        <Settings2 size={16} aria-hidden="true" /><span>{t("side.settings")}</span>
      </button>
      <span className="rail-connection" role="status" title={connected && typeof window !== "undefined" && window.location?.hostname ? `${t("side.connected")} · ${window.location.hostname}` : undefined}>
        <span className={`rail-status ${connected ? "online" : "offline"}`} aria-hidden="true" /><span>{connected ? t("side.connected") : t("side.reconnecting")}</span>
      </span>
    </div>
    {footerMenu && <ContextMenu x={footerMenu.x} y={footerMenu.y} placement="above" className="sidebar-footer-menu" label={t("side.tools")} items={footerItems} onClose={() => setFooterMenu(undefined)} />}
    {menuState && <ContextMenu x={menuState.x} y={menuState.y} label={t("side.chatMenu")} onClose={() => setMenuState(undefined)} items={menuItems(menuState)} />}
    {deleteDialog()}
    {drag && createPortal(<div className="sidebar-drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true"><AgentMark agent={drag.agent} size="small" /><span>{drag.title}</span></div>, document.body)}
  </aside>;

  /** "Move to workspace": one action for a single other workspace, otherwise a submenu listing them all. */
  function moveItems(move: (target: WorkspaceId) => void, enabled: boolean): MenuItem[] {
    const others = workspaces.filter((workspace) => workspace.id !== props.workspaceId);
    if (!enabled || !props.workspaceId || !others.length) return [];
    if (others.length === 1) return [{ kind: "action", label: t("workspace.moveToNamed", { name: workspaceName(workspaces, others[0].id) }), icon: <ArrowLeftRight size={15} />, disabled: busy, onSelect: () => move(others[0].id) }];
    return [{ kind: "submenu", plain: true, label: t("workspace.moveToWorkspace"), icon: <ArrowLeftRight size={15} />, disabled: busy,
      items: others.map((workspace) => ({ id: workspace.id, label: workspaceName(workspaces, workspace.id), depth: 0, checked: false })), onPick: (id) => { if (id) move(id); } }];
  }

  function menuItems(state: MenuState): MenuItem[] {
    if (state.kind === "worker") {
      const session = sessions.find((item) => item.id === state.id);
      const worker = session ? delegationWorkers(session, Date.now()).find((item) => item.id === state.workerId) : undefined;
      if (!session || !worker) return [];
      return [
        { kind: "action", label: t("deleg.view"), icon: <Eye size={15} />, onSelect: () => props.onSelectWorker?.(session.id, worker.id) },
        { kind: "separator" },
        { kind: "action", label: t("side.deleteWorker"), icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => setDeletingWorker({ sessionId: session.id, workerId: worker.id, name: worker.label, running: worker.status === "running" }) },
      ];
    }
    if (state.kind === "group") {
      const group = scoped.groups.find((item) => item.id === state.id);
      if (!group) return [];
      return [
        { kind: "action", label: t("common.newChat"), icon: <Plus size={15} />, onSelect: () => { onNew(group.id); expand(group.id); } },
        { kind: "action", label: t("side.rename"), icon: <Pencil size={15} />, disabled: busy, onSelect: () => setEditor({ kind: "group", id: group.id, value: group.name }) },
        ...moveItems((target) => void props.onMoveGroup?.(group.id, target), Boolean(props.onMoveGroup)),
        { kind: "separator" },
        { kind: "action", label: t("side.deleteProject"), icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => setDeleting({ kind: "group", id: group.id, name: group.name }) },
      ];
    }
    const session = sessions.find((item) => item.id === state.id);
    if (!session) return [];
    return [
      { kind: "action", label: t("side.rename"), icon: <Pencil size={15} />, disabled: busy, onSelect: () => setEditor({ kind: "session", id: session.id, value: session.title }) },
      { kind: "submenu", label: t("side.moveToGroup"), icon: <FolderInput size={15} />, disabled: busy, items: moveTree(session), onPick: (id) => void props.onAssign(session.id, id).then((ok) => { if (ok && id) expand(id); }) },
      ...moveItems((target) => void props.onMoveSession?.(session.id, target), Boolean(props.onMoveSession)),
      { kind: "separator" },
      { kind: "action", label: t("side.deleteChat"), icon: <Trash2 size={15} />, danger: true, disabled: busy || session.status === "running", title: session.status === "running" ? t("side.stopFirst") : undefined, onSelect: () => setDeleting({ kind: "session", id: session.id, name: session.title }) },
    ];
  }
}
