// Shared building blocks of the settings window: sections, rows, switch, segmented control,
// the save indicator and the confirm dialog. Every control applies immediately; a failed save
// rolls the value back and shows an inline error with a retry.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, LoaderCircle, RotateCcw } from "lucide-react";
import { t } from "../i18n";

/* — Save status (top bar indicator) — */

export type SaveState = { phase: "idle" | "saving" | "saved" | "error"; retry?: () => void };
type SaveApi = { state: SaveState; track: <T>(work: () => Promise<T>) => Promise<T> };
const SaveContext = createContext<SaveApi>({ state: { phase: "idle" }, track: (work) => work() });
export const useSaveStatus = () => useContext(SaveContext);

/** Wraps the settings window: `track()` drives "저장 중… / 저장됨 / 저장 실패 · 재시도". */
export function SaveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const timer = useRef<number>(undefined);
  const pending = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const track = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    window.clearTimeout(timer.current);
    pending.current += 1;
    setState({ phase: "saving" });
    const run = work();
    run.then(() => {
      pending.current -= 1;
      if (pending.current > 0) return;
      setState({ phase: "saved" });
      timer.current = window.setTimeout(() => setState({ phase: "idle" }), 2_000);
    }, () => {
      pending.current = Math.max(0, pending.current - 1);
      setState({ phase: "error", retry: () => { void track(work).catch(() => undefined); } });
    });
    return run;
  }, []);
  return <SaveContext.Provider value={{ state, track }}>{children}</SaveContext.Provider>;
}

export function SaveIndicator() {
  const { state } = useSaveStatus();
  return <span className={`settings-save ${state.phase}`} aria-live="polite">
    {state.phase === "saving" && <><LoaderCircle size={13} className="spin" aria-hidden="true" />{t("set.save.saving")}</>}
    {state.phase === "saved" && <><Check size={13} aria-hidden="true" />{t("set.save.saved")}</>}
    {state.phase === "error" && <span role="alert">{t("set.save.failed")}{state.retry && <> · <button type="button" className="settings-link" onClick={state.retry}>{t("common.retry")}</button></>}</span>}
  </span>;
}

/**
 * Optimistic value: shows the new value at once, calls `save`, and rolls back on failure
 * (a thrown error or `false`). Returns the shown value, a setter and the inline error.
 */
export function useCommitted<V>(value: V, save: (next: V) => Promise<unknown> | unknown) {
  const { track } = useSaveStatus();
  const [shown, setShown] = useState(value);
  const [error, setError] = useState<{ retry: () => void }>();
  const latest = useRef(value);
  useEffect(() => { latest.current = value; setShown(value); }, [value]);
  const commit = useCallback((next: V) => {
    const previous = latest.current;
    setShown(next);
    setError(undefined);
    void track(async () => {
      const result = await save(next);
      if (result === false) throw new Error("save failed");
    }).then(() => { latest.current = next; }, () => {
      setShown(previous);
      setError({ retry: () => commit(next) });
    });
  }, [save, track]);
  return [shown, commit, error] as const;
}

/* — Layout — */

export function SettingsPage({ intro, children }: { intro?: ReactNode; children: ReactNode }) {
  return <div className="settings-page">{intro && <p className="settings-page-intro">{intro}</p>}{children}</div>;
}

export function SettingsSection({ title, description, children, danger = false, actions }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean; actions?: ReactNode }) {
  const id = useId();
  return <section className={`settings-section${danger ? " danger" : ""}`} aria-labelledby={`${id}-title`}>
    <header className="settings-section-head">
      <div><h3 id={`${id}-title`}>{title}</h3>{description && <p>{description}</p>}</div>
      {actions && <div className="settings-section-actions">{actions}</div>}
    </header>
    <div className="settings-card">{children}</div>
  </section>;
}

type RowIds = { controlId: string; labelId: string; descId: string };
/**
 * One setting: label + one-line description on the left, control on the right (or below for
 * `block` rows). `modified` draws the accent bar and offers a reset; `error` shows a retry line.
 */
export function SettingRow({ id, label, description, children, block = false, modified = false, onReset, error, onRetry, disabled = false, icon, badges }: {
  id?: string; label: ReactNode; description?: ReactNode; children?: ReactNode | ((ids: RowIds) => ReactNode);
  block?: boolean; modified?: boolean; onReset?: () => void; error?: ReactNode; onRetry?: () => void; disabled?: boolean; icon?: ReactNode; badges?: ReactNode;
}) {
  const base = useId();
  const ids: RowIds = { controlId: `${base}-control`, labelId: `${base}-label`, descId: `${base}-desc` };
  const control = typeof children === "function" ? children(ids) : children;
  return <div className={`setting-row${block ? " block" : ""}${modified ? " modified" : ""}${disabled ? " disabled" : ""}`} data-setting-id={id}>
    <div className="setting-row-text">
      <label className="setting-row-label" id={ids.labelId} htmlFor={ids.controlId}>{icon}<span>{label}</span>{badges}</label>
      {description && <p className="setting-row-desc" id={ids.descId}>{description}</p>}
    </div>
    {(control || onReset) && <div className="setting-row-control">
      {modified && onReset && <button type="button" className="setting-reset" aria-label={t("set.resetRow")} title={t("set.resetRow")} onClick={onReset}><RotateCcw size={14} /></button>}
      {control}
    </div>}
    {error && <p className="setting-row-error" role="alert"><AlertTriangle size={13} aria-hidden="true" />{error}{onRetry && <> · <button type="button" className="settings-link" onClick={onRetry}>{t("common.retry")}</button></>}</p>}
  </div>;
}

/* — Controls — */

export function Switch({ id, checked, onChange, disabled, labelledBy, describedBy, label }: { id?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; labelledBy?: string; describedBy?: string; label?: string }) {
  return <button type="button" id={id} role="switch" className="settings-switch" aria-checked={checked} aria-labelledby={label ? undefined : labelledBy} aria-label={label} aria-describedby={describedBy}
    disabled={disabled} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>;
}

/** Row with a switch: the whole row's label toggles it; failures roll back. */
export function SwitchRow({ id, label, description, value, save, disabled, icon, badges }: {
  id?: string; label: ReactNode; description?: ReactNode; value: boolean; save: (next: boolean) => Promise<unknown> | unknown; disabled?: boolean; icon?: ReactNode; badges?: ReactNode;
}) {
  const [shown, commit, error] = useCommitted(value, save);
  return <SettingRow id={id} label={label} description={description} disabled={disabled} icon={icon} badges={badges} error={error && t("set.save.rowFailed")} onRetry={error?.retry}>
    {({ controlId, labelId, descId }) => <Switch id={controlId} checked={shown} disabled={disabled} labelledBy={labelId} describedBy={description ? descId : undefined} onChange={commit} />}
  </SettingRow>;
}

export type SegmentOption<V extends string> = { value: V; label: string };
export function Segmented<V extends string>({ id, value, options, onChange, labelledBy, describedBy, disabled }: { id?: string; value: V; options: SegmentOption<V>[]; onChange: (value: V) => void; labelledBy?: string; describedBy?: string; disabled?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const move = (event: KeyboardEvent, from: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return <div id={id} className="settings-segmented" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
    {options.map((option, i) => <button key={option.value} ref={(node) => { refs.current[i] = node; }} type="button" role="radio" aria-checked={i === index}
      tabIndex={i === index ? 0 : -1} disabled={disabled} onClick={() => onChange(option.value)} onKeyDown={(event) => move(event, i)}>{option.label}</button>)}
  </div>;
}

export function StatusBadge({ tone, children }: { tone: "ok" | "warn" | "danger" | "muted" | "info"; children: ReactNode }) {
  return <span className={`settings-badge ${tone}`}>{tone === "ok" ? <Check size={12} aria-hidden="true" /> : tone === "warn" || tone === "danger" ? <AlertTriangle size={12} aria-hidden="true" /> : null}{children}</span>;
}

/** Destructive confirmation: Cancel has the initial focus, Escape cancels. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className="settings-confirm-backdrop" role="presentation" onClick={onCancel}>
    <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <h4 id={`${id}-t`}>{title}</h4>
      <p id={`${id}-b`}>{body}</p>
      <div className="settings-confirm-actions">
        <button ref={cancel} type="button" className="settings-button" onClick={onCancel}>{t("side.cancel")}</button>
        <button type="button" className="settings-button danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return <div className="settings-empty">{icon}<strong>{title}</strong>{body && <p>{body}</p>}{action}</div>;
}
