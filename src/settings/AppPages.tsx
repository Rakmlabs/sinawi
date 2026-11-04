// App-wide settings pages: General, Notifications, Shortcuts, Updates.
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { updateAppearance, useAppearance } from "../appearance";
import { GlassSelect } from "../GlassSelect";
import { SHORTCUTS } from "../onboarding-state";
import { UpdateSettings } from "../updates/UpdateSettings";
import { t, type Lang, type MessageKey } from "../i18n";
import { APPEARANCE_DEFAULTS } from "../app/AppearanceSettings";
import { ConfirmDialog, SettingRow, SettingsPage, SettingsSection, StatusBadge, SwitchRow, useSaveStatus } from "./controls";
import { NOTIFICATION_TYPES, resetToastTypes, setToastType, TOAST_PREFS_EVENT, toastTypes } from "./notification-prefs";
import { translatedMap } from "../i18n";
import { AUTO_RUN_KEY, autoRunEnabled, writePreference } from "../preferences";
import type { NotificationType } from "../../server/notification-types";
import { workspaceApi } from "../app/api";
import { CopyButton } from "../CopyButton";

const typeLabels = translatedMap<NotificationType>({ auth: "noti.auth", quota: "noti.quota", permission: "noti.permission", "run-finished": "noti.runFinished", lead: "noti.lead", error: "noti.error", info: "noti.info" });
const typeHints = translatedMap<NotificationType>({ auth: "set.noti.authDesc", quota: "set.noti.quotaDesc", permission: "set.noti.permissionDesc", "run-finished": "set.noti.runFinishedDesc", lead: "set.noti.leadDesc", error: "set.noti.errorDesc", info: "set.noti.infoDesc" });

export function GeneralPage() {
  const appearance = useAppearance();
  const { track } = useSaveStatus();
  const [confirm, setConfirm] = useState(false);
  const [autoRun, setAutoRun] = useState(autoRunEnabled);
  const saveAutoRun = (next: boolean) => { writePreference(AUTO_RUN_KEY, String(next)); setAutoRun(next); };
  return <SettingsPage>
    <SettingsSection title={t("set.general.basics")}>
      <SettingRow id="language" label={t("set.general.language")} description={t("set.general.languageDesc")}>
        <GlassSelect className="settings-select" label={t("set.general.language")} value={appearance.lang}
          onChange={(lang) => { void track(async () => updateAppearance({ lang: lang as Lang })); }}
          options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }]} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.general.work")}>
      <SwitchRow id="autoRun" label={t("set.general.autoRun")} description={t("set.general.autoRunDesc")} value={autoRun} save={saveAutoRun} />
      <UserPreferencesRow />
    </SettingsSection>
    <LeadSettingsSection />
    <AppMcpSection />
    <SettingsSection title={t("set.danger")} danger>
      <SettingRow id="reset" label={t("set.general.reset")} description={t("set.general.resetDesc")}>
        <button type="button" className="settings-button danger-outline" onClick={() => setConfirm(true)}>{t("set.general.resetAction")}</button>
      </SettingRow>
    </SettingsSection>
    {confirm && <ConfirmDialog title={t("set.general.resetConfirm")} body={t("set.general.resetConfirmBody")} confirmLabel={t("set.general.resetAction")}
      onCancel={() => setConfirm(false)}
      onConfirm={() => { setConfirm(false); void track(async () => { updateAppearance({ ...APPEARANCE_DEFAULTS }); resetToastTypes(); saveAutoRun(true); }); }} />}
  </SettingsPage>;
}

function useToastTypes() {
  const [types, setTypes] = useState(toastTypes);
  useEffect(() => {
    const sync = () => setTypes(toastTypes());
    window.addEventListener(TOAST_PREFS_EVENT, sync);
    return () => window.removeEventListener(TOAST_PREFS_EVENT, sync);
  }, []);
  return types;
}

type Policy = "auto" | "ask" | "never";
const policyLabel = (policy: Policy) => t(`steward.merge.${policy}` as MessageKey);

/** App-wide lead settings: the merge policy migrated leads get, and one click to set every lead's. */
function LeadSettingsSection() {
  const { track } = useSaveStatus();
  const [legacy, setLegacy] = useState<"auto" | "ask">();
  const [confirm, setConfirm] = useState<Policy>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    workspaceApi<{ legacyMergePolicy: "auto" | "ask" }>("/stewards/settings").then((next) => { if (live) setLegacy(next.legacyMergePolicy); }, (reason) => { if (live) setError(String(reason instanceof Error ? reason.message : reason)); });
    return () => { live = false; };
  }, []);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const saveLegacy = (value: "auto" | "ask") => {
    setError(""); setNote("");
    void track(async () => {
      const next = await workspaceApi<{ legacyMergePolicy: "auto" | "ask"; updated: number }>("/stewards/settings", { legacyMergePolicy: value }, "PUT");
      setLegacy(next.legacyMergePolicy);
      setNote(t("set.general.legacyMergeDone", { count: next.updated }));
    }).catch(fail);
  };
  const applyAll = (policy: Policy) => {
    setConfirm(undefined); setError(""); setNote("");
    void track(async () => {
      const next = await workspaceApi<{ updated: number }>("/stewards/merge-policy/bulk", { policy });
      setNote(t("set.general.bulkMergeDone", { count: next.updated }));
    }).catch(fail);
  };
  return <SettingsSection title={t("set.general.leads")}>
    <SettingRow id="legacyMergePolicy" label={t("set.general.legacyMerge")} description={t("set.general.legacyMergeDesc")} error={error || undefined}>
      <GlassSelect className="settings-select" label={t("set.general.legacyMerge")} value={legacy ?? "auto"} disabled={!legacy}
        onChange={(value) => saveLegacy(value as "auto" | "ask")} options={(["auto", "ask"] as const).map((policy) => ({ value: policy, label: policyLabel(policy) }))} />
    </SettingRow>
    <SettingRow id="bulkMergePolicy" block label={t("set.general.bulkMerge")} description={note || t("set.general.bulkMergeDesc")}>
      <div className="settings-advanced-actions">
        {(["auto", "ask", "never"] as const).map((policy) => <button key={policy} type="button" className="settings-button" onClick={() => setConfirm(policy)}>{t("set.general.bulkMergeApply", { policy: policyLabel(policy) })}</button>)}
      </div>
    </SettingRow>
    {confirm && <ConfirmDialog title={t("set.general.bulkMergeConfirm", { policy: policyLabel(confirm) })} body={t("set.general.bulkMergeConfirmBody")} confirmLabel={t("set.general.bulkMergeApply", { policy: policyLabel(confirm) })} onConfirm={() => applyAll(confirm)} onCancel={() => setConfirm(undefined)} />}
  </SettingsSection>;
}

type McpConnection = { token: string; tokenFile: string; script: string | null; config: unknown; scriptConfig?: unknown };
type McpClientId = "claude" | "cursor";
type McpClientPlan = { client: McpClientId; name: string; path: string; exists: boolean; replaces: boolean; upToDate: boolean; merge: string };

/** The connect routes (server/mcp-clients.ts) answer with a `code` for files Sinawi will not rewrite. */
async function mcpClientApi<T>(client: McpClientId, merge?: string): Promise<T> {
  const r = await fetch(`/api/app-mcp/clients/${client}`, merge === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merge }) });
  const data = await r.json().catch(() => undefined);
  if (r.ok) return data as T;
  const code = data?.code;
  if (code === "invalid_json" || code === "not_object" || code === "bad_servers") throw new Error(t("set.general.mcpConnectBadFile", { path: data.path }));
  if (code === "stale") throw new Error(t("set.general.mcpConnectStale"));
  throw new Error(data?.error || t("api.requestFailed"));
}

/** Connect Claude Desktop / Cursor: show exactly what is merged into the client's config, then write it. */
function McpClientButtons({ fail }: { fail: (reason: unknown) => void }) {
  const [plan, setPlan] = useState<McpClientPlan>();
  const [done, setDone] = useState("");
  const open = (client: McpClientId) => { setDone(""); mcpClientApi<McpClientPlan>(client).then(setPlan, fail); };
  const write = () => {
    const current = plan;
    setPlan(undefined);
    if (!current) return;
    mcpClientApi<{ path: string; backup: string | null; name: string }>(current.client, current.merge).then((result) => {
      setDone(result.backup ? t("set.general.mcpConnectDoneBackup", { name: result.name, path: result.path, backup: result.backup }) : t("set.general.mcpConnectDone", { name: result.name, path: result.path }));
    }, fail);
  };
  return <>
    <div className="settings-advanced-actions">
      <button type="button" className="settings-button primary" onClick={() => open("claude")}>{t("set.general.mcpConnectClaude")}</button>
      <button type="button" className="settings-button" onClick={() => open("cursor")}>{t("set.general.mcpConnectCursor")}</button>
    </div>
    {done && <p role="status">{done}</p>}
    {plan && <ConfirmDialog title={t("set.general.mcpConnectConfirm", { name: plan.name })}
      body={<>
        {t(plan.exists ? (plan.replaces ? "set.general.mcpConnectReplace" : "set.general.mcpConnectMerge") : "set.general.mcpConnectCreate", { path: plan.path })}
        <code className="settings-confirm-code" style={{ display: "block", whiteSpace: "pre", overflowX: "auto", marginTop: 8, maxHeight: 260, overflowY: "auto" }}>{plan.merge}</code>
        {t("set.general.mcpConnectRestart", { name: plan.name })}
      </>}
      confirmLabel={t("set.general.mcpConnectWrite")} onConfirm={write} onCancel={() => setPlan(undefined)} />}
  </>;
}

/**
 * How an outside AI connects: the connect buttons write the client's config; or copy `npx -y sinawi mcp`,
 * or the bridge copy in <data>/hooks without npx (server/app-mcp.ts).
 */
function AppMcpSection() {
  const [connection, setConnection] = useState<McpConnection>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => {
    let live = true;
    workspaceApi<McpConnection>("/app-mcp/connection").then((next) => { if (live) setConnection(next); }, (reason) => { if (live) fail(reason); });
    return () => { live = false; };
  }, []);
  const rotate = () => {
    setConfirm(false); setError("");
    workspaceApi<McpConnection>("/app-mcp/token", {}).then(setConnection, fail);
  };
  const config = connection?.config ? JSON.stringify(connection.config, null, 2) : "";
  const scriptConfig = connection?.scriptConfig ? JSON.stringify(connection.scriptConfig, null, 2) : "";
  return <SettingsSection title={t("set.general.mcp")}>
    <SettingRow id="appMcp" block label={t("set.general.mcp")} description={t("set.general.mcpDesc")} error={error || undefined}>
      <div className="settings-json">
        <p>{t("set.general.mcpConnectIntro")}</p>
        <McpClientButtons fail={fail} />
        <p>{t("set.general.mcpSteps")}</p>
        {connection && !connection.script && <p>{t("set.general.mcpNoScript")}</p>}
        {config && <textarea rows={10} readOnly value={config} aria-label={t("set.general.mcp")} />}
        <div className="settings-advanced-actions">
          {config && <CopyButton text={config} ariaLabel={t("set.general.mcpCopy")} className="settings-button" showLabel />}
          <button type="button" className="settings-button" disabled={!connection} onClick={() => setConfirm(true)}>{t("set.general.mcpRotate")}</button>
        </div>
        {scriptConfig && <details>
          <summary>{t("set.general.mcpAlt")}</summary>
          <textarea rows={10} readOnly value={scriptConfig} aria-label={t("set.general.mcpAltCopy")} />
          <div className="settings-advanced-actions">
            <CopyButton text={scriptConfig} ariaLabel={t("set.general.mcpAltCopy")} className="settings-button" showLabel />
          </div>
        </details>}
      </div>
    </SettingRow>
    {confirm && <ConfirmDialog title={t("set.general.mcpRotateConfirm")} body={t("set.general.mcpRotateBody")} confirmLabel={t("set.general.mcpRotate")} onConfirm={rotate} onCancel={() => setConfirm(false)} />}
  </SettingsSection>;
}

/** user-preferences.md: what every project lead reads with its notes (server/steward.ts). */
function UserPreferencesRow() {
  const { track } = useSaveStatus();
  const [saved, setSaved] = useState<string>();
  const [text, setText] = useState("");
  const [limit, setLimit] = useState(8_000);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    workspaceApi<{ text: string; limit: number }>("/user-preferences").then((next) => {
      if (!live) return;
      setSaved(next.text); setText(next.text); setLimit(next.limit);
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, []);
  const save = () => {
    setError("");
    void track(async () => {
      const next = await workspaceApi<{ text: string }>("/user-preferences", { text }, "PUT");
      setSaved(next.text); setText(next.text);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return <SettingRow id="userPreferences" block label={t("set.general.userPrefs")} description={t("set.general.userPrefsDesc")} error={error || undefined}>
    <div className="settings-json">
      <textarea rows={6} maxLength={limit} value={text} disabled={saved === undefined} placeholder={t("set.general.userPrefsPlaceholder")} aria-label={t("set.general.userPrefs")} onChange={(event) => setText(event.target.value)} />
      <div className="settings-advanced-actions">
        <button type="button" className="settings-button primary" disabled={saved === undefined || text.trim() === saved} onClick={save}>{t("set.general.userPrefsSave")}</button>
      </div>
    </div>
  </SettingRow>;
}

export function NotificationsPage({ openSystemSettings }: { openSystemSettings: () => void }) {
  const types = useToastTypes();
  const [permission, setPermission] = useState(() => typeof Notification === "undefined" ? "unknown" : Notification.permission);
  return <SettingsPage>
    <SettingsSection title={t("set.noti.toasts")} description={t("set.noti.toastsDesc")}>
      {NOTIFICATION_TYPES.map((type) => <SwitchRow key={type} id={`toast-${type}`} label={typeLabels[type]} description={typeHints[type]} value={types.has(type)} save={(next) => setToastType(type, next)} />)}
    </SettingsSection>
    <SettingsSection title={t("set.noti.system")}>
      <SettingRow id="noti-permission" label={t("ob.perm.notifications")} description={t("set.noti.systemDesc")}
        badges={permission === "granted" ? <StatusBadge tone="ok">{t("ob.allowed")}</StatusBadge> : permission === "denied" ? <StatusBadge tone="warn">{t("ob.off")}</StatusBadge> : <StatusBadge tone="muted">{t("ob.unchecked")}</StatusBadge>}>
        <div className="settings-inline-actions">
          {permission === "default" && <button type="button" className="settings-button" onClick={() => { void Notification.requestPermission().then(setPermission); }}>{t("ob.request")}</button>}
          <button type="button" className="settings-button" onClick={openSystemSettings}><ExternalLink size={14} aria-hidden="true" />{t("ob.openSettings")}</button>
        </div>
      </SettingRow>
    </SettingsSection>
  </SettingsPage>;
}

const extraShortcuts: ReadonlyArray<[string, Parameters<typeof t>[0]]> = [
  ["⌘N", "common.newChat"],
  ["⌘K", "side.search"],
  ["⌘R", "common.reload"],
];

export function ShortcutsPage() {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => [...SHORTCUTS, ...extraShortcuts].map(([keys, label]) => ({ keys, label: t(label) })), []);
  const term = query.trim().toLocaleLowerCase();
  const shown = term ? rows.filter((row) => `${row.label} ${row.keys}`.toLocaleLowerCase().includes(term)) : rows;
  return <SettingsPage>
    <div className="settings-search-field inline">
      <Search size={14} aria-hidden="true" />
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("set.shortcuts.search")} aria-label={t("set.shortcuts.search")}
        onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
    </div>
    <SettingsSection title={t("set.shortcuts.list")} description={t("set.shortcuts.listDesc")}>
      <div data-setting-id="shortcuts" className="settings-shortcuts" role="table" aria-label={t("set.shortcuts.list")}>
        {shown.map((row) => <div role="row" key={row.keys} className="settings-shortcut">
          <span role="cell">{row.label}</span>
          <span role="cell" className="settings-keys">{row.keys.split(" · ").map((combo) => <kbd key={combo}>{combo}</kbd>)}</span>
        </div>)}
        {!shown.length && <p className="settings-empty-line" role="status">{t("set.search.none", { query })}</p>}
      </div>
    </SettingsSection>
  </SettingsPage>;
}

export function UpdatesPage() {
  return <SettingsPage>
    <SettingsSection title={t("set.cat.updates")} description={t("set.updates.desc")}>
      <div className="settings-hosted" data-setting-id="update-auto"><UpdateSettings /></div>
    </SettingsSection>
  </SettingsPage>;
}
