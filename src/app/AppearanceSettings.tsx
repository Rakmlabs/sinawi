import { useEffect, useState } from "react";
import { updateAppearance, useAppearance, type Appearance, type FontSize, type ThemePref } from "../appearance";
import { GlassSelect } from "../GlassSelect";
import { SettingRow, SettingsPage, SettingsSection, Segmented } from "../settings/controls";
import { t, type MessageKey } from "../i18n";

type FontKind = "uiFont" | "monoFont";
const DEFAULTS: Pick<Appearance, "theme" | "uiFont" | "monoFont" | "fontSize"> = { theme: "system", uiFont: "default", monoFont: "default", fontSize: "normal" };

/** True when the browser can render `name` (or the check is unavailable). */
function fontAvailable(name: string): boolean {
  try { return !name || typeof document === "undefined" || !document.fonts?.check || document.fonts.check(`12px "${name.replace(/"/g, "")}"`); } catch { return true; }
}

/** Font choice: default stack, the system font, or a custom installed font typed by name. */
function FontRow({ kind, value }: { kind: FontKind; value: string }) {
  const isCustom = value !== "default" && value !== "system";
  const [mode, setMode] = useState<"default" | "system" | "custom">(isCustom ? "custom" : value as "default" | "system");
  const [custom, setCustom] = useState(isCustom ? value : "");
  useEffect(() => { if (value === "default" || value === "system") { setMode(value); } }, [value]);
  const key = (suffix: string) => `appearance.${kind}.${suffix}` as MessageKey;
  const choose = (next: string) => {
    const pick = next as "default" | "system" | "custom";
    setMode(pick);
    updateAppearance({ [kind]: pick === "custom" ? custom.trim() || "default" : pick } as Partial<Appearance>);
  };
  const missing = mode === "custom" && custom.trim() !== "" && !fontAvailable(custom.trim());
  return <>
    <SettingRow id={kind} label={t(key("legend"))} description={t(kind === "uiFont" ? "set.appearance.uiFontDesc" : "set.appearance.monoFontDesc")}
      modified={value !== "default"} onReset={() => { setMode("default"); setCustom(""); updateAppearance({ [kind]: "default" } as Partial<Appearance>); }}>
      <GlassSelect label={t(key("legend"))} value={mode} onChange={choose} className="settings-select"
        options={(["default", "system", "custom"] as const).map((option) => ({ value: option, label: t(key(option)) }))} />
    </SettingRow>
    {mode === "custom" && <SettingRow label={t("appearance.customName")} description={missing ? <span className="settings-warn-text">{t("set.appearance.fontMissing")}</span> : t("set.appearance.customHint")}>
      {({ controlId, descId }) => <input id={controlId} className="settings-input" type="text" spellCheck={false} autoComplete="off" value={custom} aria-describedby={descId}
        placeholder={kind === "uiFont" ? "Inter" : "Fira Code"}
        onChange={(event) => { setCustom(event.target.value); updateAppearance({ [kind]: event.target.value.trim() || "default" } as Partial<Appearance>); }} />}
    </SettingRow>}
  </>;
}

/** Settings › Appearance: theme, fonts and text size. Changes apply immediately and persist. */
export function AppearanceSettings() {
  const appearance = useAppearance();
  return <SettingsPage>
    <SettingsSection title={t("set.appearance.look")}>
      <SettingRow id="theme" label={t("appearance.theme")} description={t("set.appearance.themeDesc")} modified={appearance.theme !== DEFAULTS.theme} onReset={() => updateAppearance({ theme: DEFAULTS.theme })}>
        {({ labelId, descId }) => <Segmented<ThemePref> labelledBy={labelId} describedBy={descId} value={appearance.theme} onChange={(theme) => updateAppearance({ theme })}
          options={[{ value: "system", label: t("appearance.theme.system") }, { value: "dark", label: t("appearance.theme.dark") }, { value: "light", label: t("appearance.theme.light") }]} />}
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.appearance.type")}>
      <FontRow kind="uiFont" value={appearance.uiFont} />
      <FontRow kind="monoFont" value={appearance.monoFont} />
      <SettingRow id="fontSize" label={t("appearance.fontSize")} description={t("set.appearance.fontSizeDesc")} modified={appearance.fontSize !== DEFAULTS.fontSize} onReset={() => updateAppearance({ fontSize: DEFAULTS.fontSize })}>
        {({ labelId, descId }) => <Segmented<FontSize> labelledBy={labelId} describedBy={descId} value={appearance.fontSize} onChange={(fontSize) => updateAppearance({ fontSize })}
          options={[{ value: "small", label: t("appearance.fontSize.small") }, { value: "normal", label: t("appearance.fontSize.normal") }, { value: "large", label: t("appearance.fontSize.large") }]} />}
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.appearance.preview")}>
      <div className="settings-preview" aria-hidden="true">
        <div className="settings-preview-bubble">{t("set.appearance.previewText")}</div>
        <code className="settings-preview-code">const sinawi = await team.run("가나다 ABC 123");</code>
      </div>
    </SettingsSection>
  </SettingsPage>;
}

export const APPEARANCE_DEFAULTS = DEFAULTS;
