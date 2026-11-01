// App-wide settings pages: General, Notifications, Shortcuts, Updates.
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { updateAppearance, useAppearance } from "../appearance";
import { GlassSelect } from "../GlassSelect";
import { SHORTCUTS } from "../onboarding-state";
import { UpdateSettings } from "../updates/UpdateSettings";
import { t, type Lang } from "../i18n";
import { APPEARANCE_DEFAULTS } from "../app/AppearanceSettings";
import { ConfirmDialog, SettingRow, SettingsPage, SettingsSection, StatusBadge, SwitchRow, useSaveStatus } from "./controls";
import { NOTIFICATION_TYPES, resetToastTypes, setToastType, TOAST_PREFS_EVENT, toastTypes } from "./notification-prefs";
import { translatedMap } from "../i18n";
import type { NotificationType } from "../../server/notification-types";

const typeLabels = translatedMap<NotificationType>({ auth: "noti.auth", quota: "noti.quota", permission: "noti.permission", "run-finished": "noti.runFinished", error: "noti.error", info: "noti.info" });
const typeHints = translatedMap<NotificationType>({ auth: "set.noti.authDesc", quota: "set.noti.quotaDesc", permission: "set.noti.permissionDesc", "run-finished": "set.noti.runFinishedDesc", error: "set.noti.errorDesc", info: "set.noti.infoDesc" });

export function GeneralPage() {
  const appearance = useAppearance();
  const { track } = useSaveStatus();
  const [confirm, setConfirm] = useState(false);
  return <SettingsPage>
    <SettingsSection title={t("set.general.basics")}>
      <SettingRow id="language" label={t("set.general.language")} description={t("set.general.languageDesc")}>
        <GlassSelect className="settings-select" label={t("set.general.language")} value={appearance.lang}
          onChange={(lang) => { void track(async () => updateAppearance({ lang: lang as Lang })); }}
          options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }]} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.danger")} danger>
      <SettingRow id="reset" label={t("set.general.reset")} description={t("set.general.resetDesc")}>
        <button type="button" className="settings-button danger-outline" onClick={() => setConfirm(true)}>{t("set.general.resetAction")}</button>
      </SettingRow>
    </SettingsSection>
    {confirm && <ConfirmDialog title={t("set.general.resetConfirm")} body={t("set.general.resetConfirmBody")} confirmLabel={t("set.general.resetAction")}
      onCancel={() => setConfirm(false)}
      onConfirm={() => { setConfirm(false); void track(async () => { updateAppearance({ ...APPEARANCE_DEFAULTS }); resetToastTypes(); }); }} />}
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
