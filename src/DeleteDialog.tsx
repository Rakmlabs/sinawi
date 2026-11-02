import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";

export interface DeleteAction { label: string; primary?: boolean; onClick: () => void }

/** Centered destructive confirmation. Cancel has the initial focus; Escape and the backdrop cancel. */
export function DeleteDialog({ title, body, actions, busy, onCancel }: { title: string; body?: ReactNode; actions: DeleteAction[]; busy?: boolean; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { cancel.current?.focus(); }, []);
  return createPortal(<div className="delete-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={body ? `${id}-b` : undefined}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <h4 id={`${id}-t`}>{title}</h4>
      {body && <div id={`${id}-b`} className="delete-dialog-body">{body}</div>}
      <div className="delete-dialog-actions">
        <button ref={cancel} type="button" onClick={onCancel}>{t("side.cancel")}</button>
        {actions.map((action) => <button key={action.label} type="button" className={action.primary ? "danger" : "danger-outline"} disabled={busy} onClick={action.onClick}>{action.label}</button>)}
      </div>
    </div>
  </div>, document.body);
}
