import { useState, type FormEvent } from "react";
import { Check, FolderOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { allowedAgentsForWorkspace, defaultWorkspacePolicy, toolNamePattern } from "../../server/workspace-policy";
import { useWorkspaces } from "../workspace-context";
import { workspaceName } from "../workspaces";
import { names } from "./labels";
import type { AgentId, WorkspaceId, WorkspacePolicy } from "../../server/types";
import { t } from "../i18n";

const AGENTS: AgentId[] = ["codex", "claude", "grok"];

/**
 * Settings › Workspaces: add, rename, switch and delete user-defined workspaces, edit the defaults
 * of the workspaces that are not open, and every workspace's rules (media, computer control, Grok
 * MCP, blocked tools, ...). The open workspace's folder comes from the composer's folder picker and
 * its agents from the "allowed agents" section below.
 */
export function WorkspaceSettings({ currentId, busy, cwd, onPickFolder }: { currentId: WorkspaceId; busy: boolean; cwd: string; onPickFolder: () => void }) {
  const { workspaces, defaults, settings, running, switchTo, create, rename, remove, saveDefaults, saveSettings } = useWorkspaces();
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
                : <>{AGENTS.map((id) => <label key={id} className="workspace-agent">
                  <input type="checkbox" checked={allowed.includes(id)} disabled={locked}
                    onChange={(event) => void run(() => saveDefaults(workspace.id, { ...own, allowedAgents: event.target.checked ? [...allowed, id] : allowed.filter((item) => item !== id) }))} />
                  <AgentMark agent={id} size="small" />{names[id]}
                </label>)}<small>{t("wsset.agentsHint")}</small></>}</dd>
            </div>
          </dl>
          <WorkspaceRules workspaceId={workspace.id} policy={settings[workspace.id] ?? defaultWorkspacePolicy()} open={current} locked={locked}
            save={(patch) => run(() => saveSettings(workspace.id, patch))} />
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

/** Restrictions that differ from a fresh workspace, for the collapsed summary. */
function restrictionCount(policy: WorkspacePolicy) {
  return Number(!policy.mediaGeneration) + Number(!policy.grokMcp) + policy.blockedTools.length;
}

function RuleToggle({ id, settingId, label, hint, checked, disabled, onChange }: { id: string; settingId?: string; label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <div className="workspace-rule" data-setting-id={settingId}>
    <label className="workspace-rule-head" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.checked)} />
    </label>
    <small id={`${id}-hint`}>{hint}</small>
  </div>;
}

/** Editable list of MCP server names, optionally scoped to one agent (`agent:name`). */
function ToolList({ id, label, hint, values, scoped, disabled, onChange }: { id: string; label: string; hint: string; values: string[]; scoped: boolean; disabled: boolean; onChange: (next: string[]) => Promise<boolean> }) {
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState<"" | AgentId>("");
  const name = draft.trim();
  const valid = !name || toolNamePattern.test(name);
  const entry = scoped && agent ? `${agent}:${name}` : name;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name || !valid || disabled) return;
    if (values.some((value) => value.toLocaleLowerCase() === entry.toLocaleLowerCase())) { setDraft(""); return; }
    if (await onChange([...values, entry])) setDraft("");
  };
  const show = (value: string) => {
    const [prefix, rest] = value.includes(":") ? value.split(":") : ["", value];
    return prefix ? `${rest} · ${names[prefix as AgentId] ?? prefix}` : rest;
  };
  return <div className="workspace-rule">
    <span className="workspace-rule-head" id={`${id}-label`}>{label}</span>
    <small id={`${id}-hint`}>{hint}</small>
    <ul className="workspace-tool-chips" aria-labelledby={`${id}-label`}>
      {values.length ? values.map((value) => <li key={value} className="workspace-tool-chip">
        <span>{show(value)}</span>
        <button type="button" aria-label={t("wsset.removeTool", { name: show(value) })} disabled={disabled} onClick={() => void onChange(values.filter((item) => item !== value))}><X size={12} /></button>
      </li>) : <li className="workspace-tool-empty">{t("wsset.noTools")}</li>}
    </ul>
    <form className="workspace-inline-form" onSubmit={(event) => void submit(event)}>
      <input aria-label={`${label} · ${t("wsset.toolName")}`} aria-describedby={`${id}-hint`} aria-invalid={!valid} placeholder={t("wsset.toolPlaceholder")} maxLength={100} value={draft} onChange={(event) => setDraft(event.target.value)} />
      {scoped && <select aria-label={t("wsset.toolAgent")} value={agent} disabled={disabled} onChange={(event) => setAgent(event.target.value as "" | AgentId)}>
        <option value="">{t("wsset.allAgents")}</option>
        {AGENTS.map((item) => <option key={item} value={item}>{names[item]}</option>)}
      </select>}
      <button type="submit" className="button light" disabled={disabled || !name || !valid}><Plus size={14} />{t("wsset.addTool")}</button>
    </form>
    {!valid && <small className="workspace-warning" role="alert">{t("wsset.invalidTool")}</small>}
  </div>;
}

/** One workspace's rules; each change is saved on its own and applies from the next run. */
function WorkspaceRules({ workspaceId, policy, open, locked, save }: { workspaceId: WorkspaceId; policy: WorkspacePolicy; open: boolean; locked: boolean; save: (patch: Partial<WorkspacePolicy>) => Promise<boolean> }) {
  const [prompt, setPrompt] = useState<string>();
  const count = restrictionCount(policy);
  const key = workspaceId;
  const draftPrompt = prompt ?? policy.mediaPrompt ?? "";
  return <details className="workspace-rules" open={open}>
    <summary><span>{t("wsset.rules")}</span><span className={`workspace-tag${count ? " restricted" : ""}`}>{count ? t("wsset.rulesSummary", { count }) : t("wsset.rulesNone")}</span>{policy.computerUse && <span className="workspace-tag">{t("wsset.computerUse")}</span>}</summary>
    <div className="workspace-rules-body">
    <p className="muted">{t("wsset.rulesBody")}</p>
    <RuleToggle id={`ws-${key}-media`} label={t("wsset.media")} hint={t("wsset.mediaHint")} checked={policy.mediaGeneration} disabled={locked} onChange={(value) => void save({ mediaGeneration: value })} />
    <RuleToggle id={`ws-${key}-computer`} settingId={open ? "ws-computer" : undefined} label={t("wsset.computerUse")} hint={t("wsset.computerUseHint")} checked={policy.computerUse} disabled={locked} onChange={(value) => void save({ computerUse: value })} />
    <RuleToggle id={`ws-${key}-grok-mcp`} label={t("wsset.grokMcp")} hint={t("wsset.grokMcpHint")} checked={policy.grokMcp} disabled={locked} onChange={(value) => void save({ grokMcp: value })} />
    <ToolList id={`ws-${key}-blocked`} label={t("wsset.blockedTools")} hint={t("wsset.blockedToolsHint")} values={policy.blockedTools} scoped disabled={locked} onChange={(next) => save({ blockedTools: next })} />
    <ToolList id={`ws-${key}-alerts`} label={t("wsset.alertTools")} hint={t("wsset.alertToolsHint")} values={policy.authAlertTools} scoped={false} disabled={locked} onChange={(next) => save({ authAlertTools: next })} />
    {policy.mediaGeneration && <div className="workspace-rule">
      <label className="workspace-rule-head" htmlFor={`ws-${key}-media-prompt`}>{t("wsset.mediaPrompt")}</label>
      <small id={`ws-${key}-media-prompt-hint`}>{t("wsset.mediaPromptHint")}</small>
      <textarea id={`ws-${key}-media-prompt`} aria-describedby={`ws-${key}-media-prompt-hint`} rows={3} maxLength={4000} placeholder={t("wsset.mediaPromptPlaceholder")} value={draftPrompt} disabled={locked} onChange={(event) => setPrompt(event.target.value)} />
      {draftPrompt !== (policy.mediaPrompt ?? "") && <div className="workspace-confirm-actions">
        <button type="button" className="button light" onClick={() => setPrompt(undefined)}>{t("side.cancel")}</button>
        <button type="button" className="button light" disabled={locked} onClick={async () => { if (await save({ mediaPrompt: draftPrompt.trim() })) setPrompt(undefined); }}>{t("wsset.save")}</button>
      </div>}
    </div>}
    </div>
  </details>;
}
