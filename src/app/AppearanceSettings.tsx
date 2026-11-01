import { useId, useState } from "react";
import { updateAppearance, useAppearance, type Appearance, type FontSize, type ThemePref } from "../appearance";
import { t, type Lang, type MessageKey } from "../i18n";

type Option<V extends string> = { value: V; label: string };

function RadioGroup<V extends string>({ legend, name, value, options, onChange }: { legend: string; name: string; value: V; options: Option<V>[]; onChange: (value: V) => void }) {
  return <fieldset className="appearance-group">
    <legend>{legend}</legend>
    <div className="appearance-options">
      {options.map((option) => <label key={option.value} className={value === option.value ? "selected" : ""}>
        <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
        <span>{option.label}</span>
      </label>)}
    </div>
  </fieldset>;
}

/** Font choice: default stack, the system font, or a custom installed font typed by name. */
function FontChoice({ kind, value }: { kind: "uiFont" | "monoFont"; value: string }) {
  const id = useId();
  const isCustom = value !== "default" && value !== "system";
  const [custom, setCustom] = useState(isCustom ? value : "");
  const [mode, setMode] = useState<"default" | "system" | "custom">(isCustom ? "custom" : value as "default" | "system");
  const choose = (next: "default" | "system" | "custom") => {
    setMode(next);
    updateAppearance({ [kind]: next === "custom" ? custom.trim() || "default" : next } as Partial<Appearance>);
  };
  const key = (suffix: string) => `appearance.${kind}.${suffix}` as MessageKey;
  return <fieldset className="appearance-group">
    <legend>{t(key("legend"))}</legend>
    <div className="appearance-options">
      {(["default", "system", "custom"] as const).map((option) => <label key={option} className={mode === option ? "selected" : ""}>
        <input type="radio" name={`${id}-font`} value={option} checked={mode === option} onChange={() => choose(option)} />
        <span>{t(key(option))}</span>
      </label>)}
    </div>
    {mode === "custom" && <label className="appearance-custom" htmlFor={`${id}-custom`}>
      <span>{t("appearance.customName")}</span>
      <input id={`${id}-custom`} type="text" spellCheck={false} autoComplete="off" value={custom}
        placeholder={kind === "uiFont" ? "Inter" : "Fira Code"}
        onChange={(event) => { setCustom(event.target.value); updateAppearance({ [kind]: event.target.value.trim() || "default" } as Partial<Appearance>); }} />
    </label>}
  </fieldset>;
}

/** Theme, language, fonts and text size. Changes apply immediately and persist. */
export function AppearanceSettings() {
  const appearance = useAppearance();
  const id = useId();
  return <section className="appearance-settings" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t("appearance.title")}</h3>
    <RadioGroup<ThemePref> legend={t("appearance.theme")} name={`${id}-theme`} value={appearance.theme} onChange={(theme) => updateAppearance({ theme })}
      options={[{ value: "system", label: t("appearance.theme.system") }, { value: "dark", label: t("appearance.theme.dark") }, { value: "light", label: t("appearance.theme.light") }]} />
    <RadioGroup<Lang> legend={t("appearance.language")} name={`${id}-lang`} value={appearance.lang} onChange={(lang) => updateAppearance({ lang })}
      options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }]} />
    <FontChoice kind="uiFont" value={appearance.uiFont} />
    <FontChoice kind="monoFont" value={appearance.monoFont} />
    <RadioGroup<FontSize> legend={t("appearance.fontSize")} name={`${id}-size`} value={appearance.fontSize} onChange={(fontSize) => updateAppearance({ fontSize })}
      options={[{ value: "small", label: t("appearance.fontSize.small") }, { value: "normal", label: t("appearance.fontSize.normal") }, { value: "large", label: t("appearance.fontSize.large") }]} />
  </section>;
}
