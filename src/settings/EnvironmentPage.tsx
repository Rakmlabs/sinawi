// Settings › Permissions & environment: the always-available version of the setup assistant's
// checks (CLI tools, logins, macOS permissions), plus the computer-use readiness slot.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bell, ExternalLink, FolderOpen, Monitor, MousePointerClick, RefreshCw, Sparkles, SquareTerminal } from "lucide-react";
import type { PermissionId, SetupTool } from "../../server/setup";
import type { SetupInfo } from "../Onboarding";
import { accountScopeKey } from "../app/api";
import { CopyButton } from "../CopyButton";
import { openTerminal } from "../terminal-events";
import { environmentLoginCommand, environmentSettingsPath, loadProgress, ONBOARDING_OPEN_EVENT, permissionView, saveProgress, tauriInvoke, type AuthStatus, type PermState } from "../onboarding-state";
import { t } from "../i18n";
import { WebLink } from "../WebLink";
import { ComputerUseWorkspaceRows } from "../ComputerUse";
import { useWorkspaces } from "../workspace-context";
import { SettingRow, SettingsPage, SettingsSection, StatusBadge } from "./controls";

const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error((data as { error?: string })?.error || t("api.requestFailed"));
  return data as T;
};

type View = "ok" | "warn" | "manual";

export function EnvironmentPage({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<SetupInfo>();
  const [auth, setAuth] = useState<Partial<Record<string, AuthStatus>>>({});
  const [native, setNative] = useState<Partial<Record<PermissionId, PermState>>>({});
  const [acknowledged, setAcknowledged] = useState(() => loadProgress().acknowledged);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [requesting, setRequesting] = useState<PermissionId>();
  const [notification, setNotification] = useState<string>(() => typeof Notification === "undefined" ? "unknown" : Notification.permission);
  const { currentId, settings } = useWorkspaces();
  const accounts = currentId ? settings[currentId]?.accounts ?? {} : {};
  const accountsKey = accountScopeKey(accounts);

  const check = useCallback(async (refreshAuth = false) => {
    setChecking(true); setError("");
    try {
      if (refreshAuth) await json("/api/settings/models/refresh", { method: "POST", body: JSON.stringify({ reason: "settings", ...(currentId ? { workspaceId: currentId } : {}) }) }).catch(() => undefined);
      const [info, settings] = await Promise.all([
        json<SetupInfo>("/api/setup"),
        json<{ modelOptions?: Record<string, { authStatus?: AuthStatus }> }>(environmentSettingsPath(currentId)).catch(() => ({ modelOptions: {} })),
      ]);
      setSetup(info);
      setAuth(Object.fromEntries(Object.entries(settings.modelOptions ?? {}).map(([id, option]) => [id, (option as { authStatus?: AuthStatus } | undefined)?.authStatus])));
      const invoke = tauriInvoke();
      if (invoke) setNative(await invoke("permission_status").then((value) => value as Record<PermissionId, PermState>).catch(() => ({})));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  }, [currentId, accountsKey]);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    // Coming back from System Settings: re-check.
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [check]);

  const state = (id: PermissionId): View => permissionView(native[id], id === "notifications" ? (notification === "default" ? "unknown" : notification as PermState) : setup?.permissions[id], acknowledged.includes(id));
  const toggleAck = (id: PermissionId) => {
    const progress = loadProgress();
    const next = progress.acknowledged.includes(id) ? progress.acknowledged.filter((item) => item !== id) : [...progress.acknowledged, id];
    saveProgress({ ...progress, acknowledged: next });
    setAcknowledged(next);
  };
  const openPane = async (pane: PermissionId) => {
    try { await json("/api/setup/open-settings", { method: "POST", body: JSON.stringify({ pane }) }); setNotice(t("ob.settingsOpened")); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  };
  const request = async (id: PermissionId) => {
    const invoke = tauriInvoke();
    setRequesting(id);
    try {
      if (invoke && id !== "files") {
        const result = await invoke("request_permission", { kind: id }).catch(() => "unknown") as PermState;
        setNative((old) => ({ ...old, [id]: result }));
        if (result === "granted") { setNotice(t("ob.granted")); return; }
      } else if (id === "notifications" && typeof Notification !== "undefined") {
        setNotification(await Notification.requestPermission());
      }
      await openPane(id);
      if (id === "files") setNotice(t("ob.filesAddHint"));
      else if (id !== "notifications") setNotice(t("ob.toggleHint"));
    } finally { setRequesting(undefined); }
  };

  const tools = setup?.tools;
  const agents = tools?.filter((tool) => tool.agent) ?? [];
  const toolIssues = (tools ?? []).filter((tool) => !tool.installed && !tool.agent).length + (agents.length && !agents.some((tool) => tool.installed) ? 1 : 0);
  const loginIssues = agents.filter((tool) => tool.installed && auth[tool.id] === "unauthenticated").length;
  const permissions: { id: PermissionId; icon: ReactNode; title: string; why: string; optional?: boolean }[] = [
    { id: "notifications", icon: <Bell size={15} aria-hidden="true" />, title: t("ob.perm.notifications"), why: t("ob.perm.notificationsWhy") },
    { id: "screen", icon: <Monitor size={15} aria-hidden="true" />, title: t("ob.perm.screen"), why: t("ob.perm.screenWhy") },
    { id: "accessibility", icon: <MousePointerClick size={15} aria-hidden="true" />, title: t("ob.perm.accessibility"), why: t("ob.perm.accessibilityWhy"), optional: true },
    { id: "files", icon: <FolderOpen size={15} aria-hidden="true" />, title: t("ob.perm.files"), why: t("ob.perm.filesWhy"), optional: true },
  ];
  const permIssues = setup ? permissions.filter((row) => !row.optional && state(row.id) === "warn").length : 0;
  const issues = toolIssues + loginIssues + permIssues;
  const badge = (view: View, id: PermissionId) => view === "ok" ? <StatusBadge tone="ok">{acknowledged.includes(id) ? t("ob.acknowledged") : t("ob.allowed")}</StatusBadge>
    : view === "warn" ? <StatusBadge tone="warn">{t("ob.off")}</StatusBadge> : <StatusBadge tone="muted">{t("ob.checkManually")}</StatusBadge>;
  const computerReady = setup ? state("screen") === "ok" && state("accessibility") === "ok" : undefined;

  return <SettingsPage>
    <div className={`settings-summary ${!setup ? "pending" : issues ? "warn" : "ok"}`} role="status" aria-busy={checking}>
      {!setup ? <span>{t("ob.checking")}</span> : issues ? <StatusBadge tone="warn">{t("set.env.issues", { n: issues })}</StatusBadge> : <StatusBadge tone="ok">{t("set.env.allReady")}</StatusBadge>}
      <span className="settings-spacer" />
      <button type="button" className="settings-button" disabled={checking} onClick={() => void check(true)}><RefreshCw size={14} className={checking ? "spin" : ""} aria-hidden="true" />{t("ob.checkAgain")}</button>
    </div>
    {error && <p className="settings-banner danger" role="alert">{error}</p>}
    {notice && <p className="settings-banner" role="status">{notice}</p>}

    <SettingsSection title={t("set.env.tools")} description={t("set.env.toolsDesc")}>
      {tools ? tools.map((tool) => <ToolRow key={tool.id} tool={tool} />) : <div className="settings-skeleton" aria-busy="true"><span /><span /><span /></div>}
    </SettingsSection>

    <SettingsSection title={t("set.env.login")} description={t("set.env.loginDesc")}>
      {agents.length ? agents.map((tool) => {
        const status = !tool.installed ? "none" : auth[tool.id] ?? "unknown";
        const login = environmentLoginCommand(tool, accounts);
        return <SettingRow key={tool.id} id={`login-${tool.id}`} label={tool.name}
          description={status === "authenticated" ? undefined : status === "none" ? t("set.env.notInstalledDesc") : login ? <code className="settings-code">{login}</code> : undefined}
          badges={status === "authenticated" ? <StatusBadge tone="ok">{t("ob.loggedIn")}</StatusBadge> : status === "none" ? <StatusBadge tone="muted">{t("ob.notInstalled")}</StatusBadge> : status === "unauthenticated" ? <StatusBadge tone="warn">{t("ob.loginRequired")}</StatusBadge> : <StatusBadge tone="muted">{t("ob.unchecked")}</StatusBadge>}>
          {tool.installed && status !== "authenticated" && login && <button type="button" className="settings-button" onClick={() => { openTerminal({ command: login }); onClose(); }}><SquareTerminal size={14} aria-hidden="true" />{t("ob.loginInTerminal")}</button>}
        </SettingRow>;
      }) : <div className="settings-skeleton" aria-busy="true"><span /><span /></div>}
    </SettingsSection>

    <SettingsSection title={t("set.env.permissions")} description={setup && setup.platform !== "darwin" ? t("ob.perm.notMac") : t("set.env.permissionsDesc")}>
      {permissions.map((row) => {
        const view = state(row.id);
        const manual = (row.id === "files" || !native[row.id] || native[row.id] === "unknown") && (view !== "ok" || acknowledged.includes(row.id));
        return <SettingRow key={row.id} id={`perm-${row.id}`} icon={row.icon} label={row.title} description={<>{row.why}{row.optional && <> · {t("ob.optional")}</>}{manual && view !== "ok" && <><br />{t("set.env.manualWhy")}</>}</>}
          badges={setup ? badge(view, row.id) : undefined}>
          <div className="settings-inline-actions">
            {view !== "ok" && <button type="button" className="settings-button" disabled={requesting === row.id} onClick={() => void request(row.id)}>{row.id === "files" ? t("ob.addInSettings") : requesting === row.id ? t("ob.requesting") : t("ob.request")}</button>}
            <button type="button" className="settings-button ghost" aria-label={`${row.title} · ${t("ob.openSettings")}`} title={t("ob.openSettings")} onClick={() => void openPane(row.id)}><ExternalLink size={14} aria-hidden="true" /></button>
            {manual && <label className="settings-check"><input type="checkbox" checked={acknowledged.includes(row.id)} onChange={() => toggleAck(row.id)} />{t("ob.turnedOn")}</label>}
          </div>
        </SettingRow>;
      })}
    </SettingsSection>

    {/* Computer use: readiness + this workspace's state. The switch itself lives in Settings › Workspaces. */}
    <SettingsSection title={t("set.env.computer")} description={t("set.env.computerDesc")}>
      <div data-setting-id="env-computer" className="settings-computer-slot">
        <SettingRow icon={<Monitor size={15} aria-hidden="true" />} label={t("ob.perm.screen")} badges={setup ? badge(state("screen"), "screen") : undefined} />
        <SettingRow icon={<MousePointerClick size={15} aria-hidden="true" />} label={t("ob.perm.accessibility")} badges={setup ? badge(state("accessibility"), "accessibility") : undefined} />
        <SettingRow label={t("set.env.computerStatus")} description={computerReady === undefined ? t("ob.checking") : computerReady ? t("set.env.computerReady") : t("set.env.computerMissing")}
          badges={computerReady === undefined ? undefined : computerReady ? <StatusBadge tone="ok">{t("ob.ready")}</StatusBadge> : <StatusBadge tone="warn">{t("ob.needsCheck")}</StatusBadge>} />
        <ComputerUseWorkspaceRows workspaceId={currentId} />
      </div>
    </SettingsSection>

    <SettingsSection title={t("set.env.onboarding")}>
      <SettingRow id="env-onboarding" label={t("modal.reopenOnboarding")} description={t("set.env.onboardingDesc")}>
        <button type="button" className="settings-button" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT)); }}><Sparkles size={14} aria-hidden="true" />{t("set.env.onboardingAction")}</button>
      </SettingRow>
    </SettingsSection>
  </SettingsPage>;
}

function ToolRow({ tool }: { tool: SetupTool }) {
  return <SettingRow id={`tool-${tool.id}`} label={tool.name}
    description={tool.installed ? (tool.agent ? t("ob.agent") : undefined) : <span className="settings-command"><code>{tool.install}</code><CopyButton text={tool.install} ariaLabel={t("ob.copyCommand", { label: tool.name })} /><WebLink className="settings-link" href={tool.docs}>{t("ob.installDocs")} <ExternalLink size={11} aria-hidden="true" /></WebLink></span>}
    badges={tool.installed ? <StatusBadge tone="ok">{tool.version ? `v${tool.version}` : t("ob.installed")}</StatusBadge> : <StatusBadge tone={tool.agent ? "muted" : "warn"}>{tool.agent ? t("ob.missingOptional") : t("ob.installRequired")}</StatusBadge>} />;
}
