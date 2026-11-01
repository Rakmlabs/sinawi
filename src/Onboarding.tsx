import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bell, Check, ExternalLink, FolderOpen, Keyboard, Layers, Monitor, MousePointerClick, Plug, RefreshCw, Sparkles, SquareTerminal, TriangleAlert, Wrench, X } from "lucide-react";
import type { SetupTool, PermissionId, PermissionState } from "../server/setup";
import type { WorkspaceId } from "../server/types";
import { CopyButton } from "./CopyButton";
import { openTerminal } from "./terminal-events";
import { permissionView, tauriInvoke, type PermState, loginStatus, saveProgress, SHORTCUTS, STEPS, toolsStatus, type AuthStatus, type OnboardingProgress, type StepStatus } from "./onboarding-state";
import "./onboarding.css";
import { t, tx } from "./i18n";
import { useWorkspaces } from "./workspace-context";
import { workspaceName } from "./workspaces";
import { SinawiMark } from "./SinawiMark";

export type SetupInfo = { platform: string; tools: SetupTool[]; permissions: Record<PermissionId, PermissionState> };
type Group = { id: string; name: string; workspaceId?: WorkspaceId };
type Mcp = { agent: string; name: string; displayName?: string; status: string; needsAuth?: boolean; forcedOff?: boolean; reason?: string };

const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const text = await r.text();
  let data: unknown; try { data = text ? JSON.parse(text) : undefined; } catch { throw new Error(t("ob.badResponse")); }
  if (!r.ok) throw new Error((data as { error?: string })?.error || t("api.requestFailed"));
  return data as T;
};

function Badge({ status, children }: { status: StepStatus | "info"; children?: ReactNode }) {
  if (status === "info" && !children) return null;
  return <span className={`ob-badge ${status}`}>{status === "ok" ? <Check size={13} /> : status === "warn" ? <TriangleAlert size={13} /> : null}{children ?? (status === "ok" ? t("ob.ready") : status === "warn" ? t("ob.needsCheck") : "")}</span>;
}

function Command({ command, label }: { command: string; label: string }) {
  return <div className="ob-command"><code>{command}</code><CopyButton text={command} ariaLabel={t("ob.copyCommand", { label })} showLabel /></div>;
}

export function Onboarding({ progress, onProgress, onClose, onMinimize, workspaceId, onSwitchWorkspace }: {
  progress: OnboardingProgress; onProgress: (next: OnboardingProgress) => void; onClose: (completed: boolean) => void; onMinimize: () => void;
  workspaceId: WorkspaceId; onSwitchWorkspace: (id: WorkspaceId) => void;
}) {
  const [setup, setSetup] = useState<SetupInfo>();
  const [auth, setAuth] = useState<Partial<Record<string, AuthStatus>>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { workspaces } = useWorkspaces();
  const [newGroup, setNewGroup] = useState<{ name: string; workspaceId: WorkspaceId }>({ name: "", workspaceId });
  const [native, setNative] = useState<Partial<Record<PermissionId, PermState>>>({});
  const [requesting, setRequesting] = useState<PermissionId>();
  const [notification, setNotification] = useState<string>(() => typeof Notification === "undefined" ? "unknown" : Notification.permission);
  const step = STEPS[progress.step];
  const set = (patch: Partial<OnboardingProgress>) => { const next = { ...progress, ...patch }; saveProgress(next); onProgress(next); };
  const go = (index: number) => set({ step: Math.max(0, Math.min(STEPS.length - 1, index)) });
  const ack = (id: string) => set({ acknowledged: progress.acknowledged.includes(id) ? progress.acknowledged.filter((v) => v !== id) : [...progress.acknowledged, id] });

  const check = useCallback(async (refreshAuth = false) => {
    setChecking(true); setError("");
    try {
      if (refreshAuth) await json("/api/settings/models/refresh", { method: "POST" }).catch(() => undefined);
      const [info, settings, groupList] = await Promise.all([
        json<SetupInfo>("/api/setup"),
        json<{ modelOptions?: Record<string, { authStatus?: AuthStatus }> }>("/api/settings").catch(() => ({ modelOptions: {} })),
        json<Group[]>("/api/groups").catch(() => []),
      ]);
      setSetup(info); setGroups(groupList);
      const invoke = tauriInvoke();
      if (invoke) setNative(await invoke("permission_status").then((v) => v as Record<PermissionId, PermState>).catch(() => ({})));
      setAuth(Object.fromEntries(Object.entries(settings.modelOptions ?? {}).map(([id, option]) => [id, (option as { authStatus?: AuthStatus } | undefined)?.authStatus])));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (mcp) return; // prefetch: MCP discovery runs each CLI and can take a few seconds
    void json<{ mcp: Mcp[] }>(`/api/tools?workspace=${workspaceId}`).then((r) => setMcp(r.mcp), () => setMcp([]));
  }, [mcp, workspaceId]);

  const tools = setup?.tools;
  const agents = tools?.filter((t) => t.agent) ?? [];
  const statusOf = (id: string): StepStatus | "info" => {
    if (id === "tools") return toolsStatus(tools);
    if (id === "login") return loginStatus(tools, auth);
    if (id === "permissions") return permissionRows.every((row) => row.state === "ok") ? "ok" : "warn";
    if (id === "workspaces") return groups.length ? "ok" : "info";
    return "info";
  };
  const openPane = async (pane: PermissionId) => {
    try { await json("/api/setup/open-settings", { method: "POST", body: JSON.stringify({ pane }) }); setNotice(t("ob.settingsOpened")); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const runLogin = (command: string) => { openTerminal({ command }); onMinimize(); };
  const createGroup = async () => {
    const name = newGroup.name.trim(); if (!name) return;
    try { await json("/api/groups", { method: "POST", body: JSON.stringify({ name, workspaceId: newGroup.workspaceId }) }); setNewGroup({ ...newGroup, name: "" }); setNotice(t("ob.projectCreated", { name })); void check(); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  const permState = (p: PermissionId) => permissionView(native[p], p === "notifications" ? (notification === "default" ? "unknown" : notification as PermState) : setup?.permissions[p], progress.acknowledged.includes(p));
  /** Ask from the app process itself (so macOS lists the app), then open the matching settings pane. */
  const request = async (p: PermissionId) => {
    const invoke = tauriInvoke();
    setRequesting(p);
    try {
      if (invoke && p !== "files") {
        const result = await invoke("request_permission", { kind: p }).catch(() => "unknown") as PermState;
        setNative((old) => ({ ...old, [p]: result }));
        if (result === "granted") { setNotice(t("ob.granted")); return; }
      } else if (p === "notifications" && typeof Notification !== "undefined") {
        setNotification(await Notification.requestPermission());
      }
      await openPane(p);
      if (p === "files") setNotice(t("ob.filesAddHint"));
      else if (p !== "notifications") setNotice(t("ob.toggleHint"));
    } finally { setRequesting(undefined); }
  };
  const permissionRows: { id: PermissionId; icon: ReactNode; title: string; why: string; optional?: boolean; state: "ok" | "warn" | "manual" }[] = [
    { id: "notifications", icon: <Bell size={18} />, title: t("ob.perm.notifications"), why: t("ob.perm.notificationsWhy"), state: permState("notifications") },
    { id: "screen", icon: <Monitor size={18} />, title: t("ob.perm.screen"), why: t("ob.perm.screenWhy"), state: permState("screen") },
    { id: "accessibility", icon: <MousePointerClick size={18} />, title: t("ob.perm.accessibility"), why: t("ob.perm.accessibilityWhy"), optional: true, state: permState("accessibility") },
    { id: "files", icon: <FolderOpen size={18} />, title: t("ob.perm.files"), why: t("ob.perm.filesWhy"), optional: true, state: permState("files") },
  ];

  const body = () => {
    switch (step.id) {
      case "tools": return <>
        <p className="ob-lead">{tx("ob.tools.lead")}</p>
        <div className="ob-list">{tools ? tools.map((tool) => <div key={tool.id} className={`ob-row ${tool.installed ? "ok" : tool.agent ? "optional" : "warn"}`}>
          <div className="ob-row-head"><strong>{tool.name}</strong>{tool.agent && <small>{t("ob.agent")}</small>}<span className="ob-spacer" />{tool.installed ? <Badge status="ok">{tool.version ? `v${tool.version}` : t("ob.installed")}</Badge> : <Badge status="warn">{tool.agent ? t("ob.missingOptional") : t("ob.installRequired")}</Badge>}</div>
          {!tool.installed && <><Command command={tool.install} label={tool.name} /><a className="ob-link" href={tool.docs} target="_blank" rel="noreferrer">{t("ob.installDocs")} <ExternalLink size={12} /></a></>}
        </div>) : <p className="ob-muted">{t("ob.checking")}</p>}</div>
        <p className="ob-muted">{tx("ob.tools.note")}</p>
      </>;
      case "login": return <>
        <p className="ob-lead">{t("ob.login.lead")}</p>
        <div className="ob-list">{agents.map((tool) => {
          const status = !tool.installed ? "none" : auth[tool.id] ?? "unknown";
          return <div key={tool.id} className={`ob-row ${status === "authenticated" ? "ok" : status === "none" ? "optional" : "warn"}`}>
            <div className="ob-row-head"><strong>{tool.name}</strong><span className="ob-spacer" />
              {status === "authenticated" ? <Badge status="ok">{t("ob.loggedIn")}</Badge> : status === "none" ? <Badge status="info">{t("ob.notInstalled")}</Badge> : status === "unauthenticated" ? <Badge status="warn">{t("ob.loginRequired")}</Badge> : <Badge status="warn">{t("ob.unchecked")}</Badge>}</div>
            {tool.installed && status !== "authenticated" && tool.login && <div className="ob-actions"><Command command={tool.login} label={t("ob.loginCommand", { name: tool.name })} /><button className="ob-btn primary" onClick={() => runLogin(tool.login!)}><SquareTerminal size={15} />{t("ob.loginInTerminal")}</button></div>}
          </div>;
        })}</div>
        <p className="ob-muted">{tx("ob.login.note")}</p>
      </>;
      case "permissions": return <>
        <p className="ob-lead">{t("ob.perm.lead")}</p>
        {setup && setup.platform !== "darwin" && <p className="ob-notice">{t("ob.perm.notMac")}</p>}
        <div className="ob-list">{permissionRows.map((row) => <div key={row.id} className={`ob-row ${row.state === "ok" ? "ok" : row.optional ? "optional" : "warn"}`}>
          <div className="ob-row-head">{row.icon}<strong>{row.title}</strong>{row.optional && <small>{t("ob.optional")}</small>}<span className="ob-spacer" />
            {row.state === "ok" ? <Badge status="ok">{progress.acknowledged.includes(row.id) ? t("ob.acknowledged") : t("ob.allowed")}</Badge> : row.state === "warn" ? <Badge status="warn">{t("ob.off")}</Badge> : <Badge status="info">{t("ob.checkManually")}</Badge>}</div>
          <p className="ob-why">{row.why}</p>
          {row.id === "files" && row.state !== "ok" && <p className="ob-hint">{tx("ob.perm.filesHint")}</p>}
          <div className="ob-actions">
            {row.state !== "ok" && <button className="ob-btn primary" disabled={requesting === row.id} onClick={() => void request(row.id)}>{row.icon}{row.id === "files" ? t("ob.addInSettings") : requesting === row.id ? t("ob.requesting") : t("ob.request")}</button>}
            <button className="ob-btn" onClick={() => void openPane(row.id)}><ExternalLink size={15} />{t("ob.openSettings")}</button>
            {(row.id === "files" || !native[row.id] || native[row.id] === "unknown") && (row.state !== "ok" || progress.acknowledged.includes(row.id)) ? <label className="ob-check"><input type="checkbox" checked={progress.acknowledged.includes(row.id)} onChange={() => ack(row.id)} />{t("ob.turnedOn")}</label> : null}
          </div>
        </div>)}</div>
        <p className="ob-muted">{tx("ob.perm.note")}</p>
      </>;
      case "workspaces": return <>
        <p className="ob-lead">{tx("ob.spaces.lead")}</p>
        <div className="ob-spaces">
          {workspaces.map(({ id }) => <button key={id} className={`ob-space ${workspaceId === id ? "active" : ""}`} onClick={() => onSwitchWorkspace(id)}>
            <div className="ob-row-head"><Layers size={18} /><strong>{workspaceName(workspaces, id)}</strong><span className="ob-spacer" />{workspaceId === id && <Badge status="ok">{t("ob.inUse")}</Badge>}</div>
            <small>{t("ob.projectCount", { n: groups.filter((g) => (g.workspaceId ?? workspaces[0]?.id) === id).length })}</small>
          </button>)}
        </div>
        <div className="ob-row"><div className="ob-row-head"><FolderOpen size={18} /><strong>{t("ob.createProject")}</strong><small>{t("ob.optional")}</small></div>
          <p className="ob-why">{t("ob.projectWhy")}</p>
          <div className="ob-actions"><input className="ob-input" placeholder={t("ob.projectPlaceholder")} value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void createGroup(); }} />
            {workspaces.length > 1 && <select className="ob-input small" aria-label={t("usage.workspace")} value={newGroup.workspaceId} onChange={(e) => setNewGroup({ ...newGroup, workspaceId: e.target.value })}>{workspaces.map(({ id }) => <option key={id} value={id}>{workspaceName(workspaces, id)}</option>)}</select>}
            <button className="ob-btn primary" disabled={!newGroup.name.trim()} onClick={() => void createGroup()}>{t("ob.create")}</button></div>
        </div>
      </>;
      case "connections": return <>
        <p className="ob-lead">{t("ob.mcp.lead")}</p>
        <div className="ob-list">{mcp === undefined ? <p className="ob-muted">{t("ob.mcp.loading")}</p> : mcp.length === 0 ? <div className="ob-row optional"><div className="ob-row-head"><Plug size={18} /><strong>{t("ob.mcp.none")}</strong></div><p className="ob-why">{t("ob.mcp.noneWhy")}</p></div>
          : mcp.slice(0, 8).map((tool) => <div key={`${tool.agent}:${tool.name}`} className={`ob-row ${tool.needsAuth ? "warn" : "ok"}`}><div className="ob-row-head"><Plug size={16} /><strong>{tool.displayName ?? tool.name}</strong><small>{tool.agent}</small><span className="ob-spacer" />{tool.forcedOff ? <Badge status="info">{t("ob.mcp.blocked")}</Badge> : tool.needsAuth ? <Badge status="warn">{t("ob.mcp.needsAuth")}</Badge> : <Badge status="ok">{tool.status === "connected" ? t("ob.mcp.connected") : t("ob.mcp.available")}</Badge>}</div></div>)}
          {mcp && mcp.length > 8 && <p className="ob-muted">{t("ob.mcp.more", { n: mcp.length - 8 })}</p>}</div>
        <button className="ob-btn" onClick={() => { window.dispatchEvent(new CustomEvent("orchestra:open-tools")); onMinimize(); }}><Wrench size={15} />{t("ob.openTools")}</button>
      </>;
      case "done": return <>
        <div className="ob-done"><Sparkles size={28} /><h3>{t("ob.done.title")}</h3><p>{t("ob.done.body", { agents: agents.filter((tool) => tool.installed).map((tool) => tool.name).join(" · ") || t("ob.done.agentFallback") })}</p></div>
        <div className="ob-shortcuts">{SHORTCUTS.map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{t(label)}</span></div>)}</div>
        <p className="ob-muted">{tx("ob.done.reopen")}</p>
      </>;
    }
  };

  return <div className="ob-backdrop" role="presentation">
    <section className="ob-dialog" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <aside className="ob-steps">
        <div className="ob-brand"><SinawiMark size={20} /><div><strong>{t("ob.title")}</strong><small>{t("ob.subtitle")}</small></div></div>
        <ol>{STEPS.map((item, index) => { const s = statusOf(item.id); return <li key={item.id}><button className={`${index === progress.step ? "current" : ""}`} onClick={() => go(index)}>
          <span className={`ob-dot ${s}`}>{s === "ok" ? <Check size={12} /> : s === "warn" ? "!" : index + 1}</span>{item.title}</button></li>; })}</ol>
        <button className="ob-skip" onClick={() => { set({ skipped: true }); onClose(false); }}>{t("ob.later")}</button>
      </aside>
      <div className="ob-main">
        <header><div><small>{progress.step + 1} / {STEPS.length}</small><h2 id="ob-title">{step.title}</h2></div><span className="ob-spacer" />
          {step.id !== "done" && <Badge status={statusOf(step.id)} />}
          <button className="ob-icon" aria-label={t("ob.checkAgain")} title={t("ob.checkAgain")} disabled={checking} onClick={() => void check(step.id === "login")}><RefreshCw size={16} className={checking ? "spin" : ""} /></button>
          <button className="ob-icon" aria-label={t("ob.close")} title={t("ob.closeTitle")} onClick={() => { set({ skipped: !progress.completed }); onClose(false); }}><X size={17} /></button></header>
        {error && <p className="ob-notice warn">{error}</p>}
        {notice && <p className="ob-notice" role="status">{notice}</p>}
        <div className="ob-body">{body()}</div>
        <footer>
          <button className="ob-btn" disabled={progress.step === 0} onClick={() => { setNotice(""); go(progress.step - 1); }}><ArrowLeft size={15} />{t("ob.prev")}</button>
          <button className="ob-btn" disabled={checking} onClick={() => void check(step.id === "login")}><RefreshCw size={15} />{t("ob.checkAgain")}</button>
          <span className="ob-spacer" />
          {step.id === "done" ? <button className="ob-btn primary" onClick={() => { set({ completed: true, skipped: false }); onClose(true); }}><Keyboard size={15} />{t("ob.start")}</button>
            : <button className="ob-btn primary" onClick={() => { setNotice(""); go(progress.step + 1); }}>{t("ob.next")}<ArrowRight size={15} /></button>}
        </footer>
      </div>
    </section>
  </div>;
}
