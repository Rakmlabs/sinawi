// Settings section: "자동으로 업데이트 확인" toggle, manual "업데이트 확인", current status.
import { useLang } from "../i18n";
import { Markdown } from "../Markdown";
import { useUpdateT } from "./strings";
import { useAppUpdate } from "./useAppUpdate";
import "./update.css";

export function UpdateSettings() {
  const { state, actions } = useAppUpdate();
  const ut = useUpdateT();
  const lang = useLang();
  if (!state.supported) return <section className="sinawi-update-settings"><h3>{ut("update.settingsTitle")}</h3><p className="sinawi-update-muted">{ut("update.unsupported")}</p></section>;

  const percent = state.progress?.total ? `${Math.round((state.progress.downloaded / state.progress.total) * 100)}%` : "";
  const status =
    state.phase === "checking" ? ut("update.checking")
    : state.phase === "upToDate" ? ut("update.upToDate")
    : state.phase === "checkFailed" ? ut("update.checkFailed", { error: state.error ?? "" })
    : state.phase === "downloading" ? ut("update.downloading", { version: state.version ?? "", percent })
    : state.phase === "downloadFailed" ? ut("update.downloadFailed", { version: state.version ?? "" })
    : state.phase === "installFailed" ? ut("update.installFailed", { error: state.error ?? "" })
    : state.phase === "installing" ? ut("update.installing")
    : state.version ? ut("update.ready", { version: state.version })
    : "";
  const checked = state.lastChecked ? new Date(state.lastChecked).toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : null;
  const ready = state.phase === "ready" || state.phase === "installFailed";

  return (
    <section className="sinawi-update-settings">
      <h3>{ut("update.settingsTitle")}</h3>
      <label className="sinawi-update-toggle">
        <input type="checkbox" checked={state.autoCheck} onChange={(event) => actions.setAutoCheck(event.target.checked)} />
        <span>
          <span>{ut("update.autoCheck")}</span>
          <small className="sinawi-update-muted">{ut("update.autoCheckHint")}</small>
        </span>
      </label>
      <div className="sinawi-update-actions">
        <button type="button" className="sinawi-update-secondary" disabled={state.phase === "checking" || state.phase === "downloading" || state.phase === "installing"} onClick={() => void actions.checkNow()}>{ut("update.checkNow")}</button>
        {ready && <button type="button" className="sinawi-update-primary" onClick={() => void actions.restart()}>{ut("update.restartNow")}</button>}
      </div>
      <p className="sinawi-update-muted" aria-live="polite">
        {[state.currentVersion && ut("update.currentVersion", { version: state.currentVersion }), status, checked && ut("update.lastChecked", { time: checked })].filter(Boolean).join(" · ")}
      </p>
      {state.version && state.notes && <div className="sinawi-update-notes"><Markdown text={state.notes} /></div>}
    </section>
  );
}
