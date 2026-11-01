import { useState, type FormEvent } from "react";
import { Check, FolderOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { allowedAgentsForWorkspace } from "../../server/workspace-policy";
import { useWorkspaces } from "../workspace-context";
import { workspaceName } from "../workspaces";
import { names } from "./labels";
import type { AgentId, WorkspaceId } from "../../server/types";
import { t } from "../i18n";

const AGENTS: AgentId[] = ["codex", "claude", "grok"];

/**
 * Settings › Workspaces: add, rename, switch and delete user-defined workspaces, and edit the
 * defaults of the workspaces that are not open. The open workspace's folder comes from the
 * composer's folder picker and its agents from the "allowed agents" section below.
 */
export function WorkspaceSettings({ currentId, busy, cwd, onPickFolder }: { currentId: WorkspaceId; busy: boolean; cwd: string; onPickFolder: () => void }) {
  const { workspaces, defaults, running, switchTo, create, rename, remove, saveDefaults } = useWorkspaces();
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<{ id: WorkspaceId; value: string }>();
  const [deleting, setDeleting] = useState<{ id: WorkspaceId; moveTo: WorkspaceId }>();
  const [pending, setPending] = useState(false);
  const [folders, setFolders] = useState<Partial<Record<WorkspaceId, string>>>({});
  const run = async (task: () => Promise<boolean>) => {
    setPending(true);
    try { return await task(); } finally { setPending(false); }
  };
  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    const name = adding.trim();
    if (!name || pending) return;
    if (await run(() => create(name))) setAdding("");
  };
  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renaming?.value.trim() || pending) return;
    if (await run(() => rename(renaming.id, renaming.value.trim()))) setRenaming(undefined);
  };
  const locked = busy || pending;
  return <section id="workspace-settings" className="panel routing-settings workspace-settings" aria-labelledby="workspace-settings-heading">
    <div>
      <h2 id="workspace-settings-heading">{t("wsset.title")}</h2>
      <p className="muted">{t("wsset.body")}</p>
    </div>
    <ul className="workspace-list">
      {workspaces.map((workspace, index) => {
        const name = workspaceName(workspaces, workspace.id);
        const current = workspace.id === currentId;
        const count = running[workspace.id] ?? 0;
        const own = defaults[workspace.id] ?? {};
        const allowed = allowedAgentsForWorkspace(workspace.id, own.allowedAgents);
        const folder = current ? cwd : own.cwd ?? "";
        const draftFolder = folders[workspace.id] ?? folder;
        const others = workspaces.filter((item) => item.id !== workspace.id);
        return <li key={workspace.id} className={`workspace-item${current ? " current" : ""}`}>
          <div className="workspace-item-head">
            {renaming?.id === workspace.id ? <form className="workspace-inline-form" onSubmit={(event) => void submitRename(event)}>
              <input autoFocus aria-label={t("wsset.name")} maxLength={40} value={renaming.value} onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(undefined); } }} />
              <button type="submit" className="icon-button" aria-label={t("side.saveName")} disabled={locked || !renaming.value.trim()}><Check size={15} /></button>
              <button type="button" className="icon-button" aria-label={t("side.cancelRename")} onClick={() => setRenaming(undefined)}><X size={15} /></button>
            </form> : <>
              <strong className="workspace-item-name">{name}</strong>
              {current && <span className="workspace-tag">{t("wsset.current")}</span>}
              {count > 0 && <span className="workspace-tag running">{t("workspace.runningCount", { count })}</span>}
              {index < 2 && <kbd className="workspace-item-key" aria-label={t("wsset.shortcut", { key: `F${index + 1}` })}>F{index + 1}</kbd>}
              <span className="workspace-item-spacer" />
              {!current && <button type="button" className="button light" disabled={locked} onClick={() => switchTo(workspace.id)}>{t("wsset.open")}</button>}
              <button type="button" className="icon-button" aria-label={t("wsset.renameNamed", { name })} title={t("side.rename")} disabled={locked} onClick={() => { setDeleting(undefined); setRenaming({ id: workspace.id, value: workspace.name }); }}><Pencil size={15} /></button>
              <button type="button" className="icon-button danger" aria-label={t("wsset.deleteNamed", { name })} title={workspaces.length < 2 ? t("wsset.lastOne") : t("side.delete")} disabled={locked || workspaces.length < 2}
                onClick={() => { setRenaming(undefined); setDeleting(deleting?.id === workspace.id ? undefined : { id: workspace.id, moveTo: others.find((item) => item.id === currentId)?.id ?? others[0].id }); }}><Trash2 size={15} /></button>
            </>}
          </div>
          {deleting?.id === workspace.id && <div className="workspace-confirm" role="alert">
            <p>{t("wsset.deleteConfirm", { name })}</p>
            {count > 0 && <p className="workspace-warning">{t("wsset.deleteRunning", { count })}</p>}
            <label>{t("wsset.moveTo")}
              <select value={deleting.moveTo} disabled={locked} onChange={(event) => setDeleting({ ...deleting, moveTo: event.target.value })}>
                {others.map((item) => <option key={item.id} value={item.id}>{workspaceName(workspaces, item.id)}</option>)}
              </select>
            </label>
            <div className="workspace-confirm-actions">
              <button type="button" className="button light" onClick={() => setDeleting(undefined)}>{t("side.cancel")}</button>
              <button type="button" className="button danger" disabled={locked || count > 0} onClick={async () => { if (await run(() => remove(workspace.id, deleting.moveTo))) setDeleting(undefined); }}>{t("wsset.deleteAndMove", { dest: workspaceName(workspaces, deleting.moveTo) })}</button>
            </div>
          </div>}
          <dl className="workspace-defaults">
            <div>
              <dt>{t("wsset.folder")}</dt>
              <dd>{current
                ? <button type="button" className="workspace-folder" title={folder} onClick={onPickFolder}><FolderOpen size={14} aria-hidden="true" /><span>{folder || t("comp.chooseFolder")}</span></button>
                : <form className="workspace-inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => saveDefaults(workspace.id, { ...own, cwd: draftFolder.trim() || undefined })); }}>
                  <input aria-label={t("wsset.folderFor", { name })} placeholder={t("wsset.folderPlaceholder")} value={draftFolder} onChange={(event) => setFolders((old) => ({ ...old, [workspace.id]: event.target.value }))} />
                  {draftFolder !== folder && <button type="submit" className="button light" disabled={locked}>{t("wsset.save")}</button>}
                </form>}</dd>
            </div>
            <div>
              <dt>{t("wsset.agents")}</dt>
              <dd className="workspace-agents">{current
                ? <>{allowedAgentsLabel(allowed)}<small>{t("wsset.agentsBelow")}</small></>
                : AGENTS.map((id) => <label key={id} className="workspace-agent">
                  <input type="checkbox" checked={allowed.includes(id)} disabled={locked}
                    onChange={(event) => void run(() => saveDefaults(workspace.id, { ...own, allowedAgents: event.target.checked ? [...allowed, id] : allowed.filter((item) => item !== id) }))} />
                  <AgentMark agent={id} size="small" />{names[id]}
                </label>)}</dd>
            </div>
          </dl>
        </li>;
      })}
    </ul>
    <form className="workspace-add" onSubmit={(event) => void submitAdd(event)}>
      <input aria-label={t("wsset.newName")} placeholder={t("wsset.newPlaceholder")} maxLength={40} value={adding} onChange={(event) => setAdding(event.target.value)} />
      <button type="submit" className="button light" disabled={locked || !adding.trim()}><Plus size={14} />{t("wsset.add")}</button>
    </form>
  </section>;
}

function allowedAgentsLabel(allowed: AgentId[]) {
  return allowed.length ? allowed.map((id) => names[id]).join(" · ") : t("wsset.noAgents");
}
