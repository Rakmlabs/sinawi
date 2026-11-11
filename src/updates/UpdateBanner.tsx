// Small non-modal update notice (bottom-right). Never blocks the app; installs only on click.
import { useState } from "react";
import { ArrowUpCircle, ServerCog, X } from "lucide-react";
import { Markdown } from "../Markdown";
import { bannerContent } from "./update-store";
import { useUpdateT } from "./strings";
import { useAppUpdate } from "./useAppUpdate";
import "./update.css";

export function UpdateBanner() {
  const { state, actions } = useAppUpdate();
  const ut = useUpdateT();
  const [showNotes, setShowNotes] = useState(false);
  const content = bannerContent(state);
  if (!content) return null;

  if (content === "server") {
    const text = state.server.kind === "pending"
      ? state.server.running > 0 ? ut("update.serverPending", { count: state.server.running }) : ut("update.serverPendingIdle")
      : ut("update.serverStale");
    return (
      <div className="sinawi-update" role="status" aria-live="polite">
        <div className="sinawi-update-row">
          <ServerCog className="sinawi-update-icon" size={16} aria-hidden />
          <span className="sinawi-update-text">{text}</span>
          <button type="button" className="sinawi-update-close" onClick={actions.dismiss} aria-label={ut("update.close")}><X size={14} /></button>
        </div>
      </div>
    );
  }

  const version = state.version ?? "";
  const { phase } = state;
  const title =
    phase === "confirmSessions" ? ut("update.sessionsRunning", { count: state.running })
    : phase === "waitingForSessions" ? ut("update.waiting", { count: state.running })
    : phase === "installing" ? ut("update.installing")
    : phase === "installFailed" ? ut("update.installFailed", { error: state.error ?? "" })
    : phase === "downloadFailed" ? ut("update.downloadFailed", { version })
    : ut("update.available", { version });
  const closable = phase === "ready" || phase === "downloadFailed" || phase === "installFailed";

  return (
    <div className="sinawi-update" role="status" aria-live="polite">
      <div className="sinawi-update-row">
        <ArrowUpCircle className="sinawi-update-icon" size={16} aria-hidden />
        <span className="sinawi-update-text">{title}</span>
        {closable && <button type="button" className="sinawi-update-close" onClick={actions.dismiss} aria-label={ut("update.later")} title={ut("update.later")}><X size={14} /></button>}
      </div>
      {phase === "confirmSessions" && <p className="sinawi-update-hint">{ut("update.sessionsHint")}</p>}
      <div className="sinawi-update-actions">
        {(phase === "ready" || phase === "installFailed") && <button type="button" className="sinawi-update-primary" onClick={() => void actions.restart()}>{phase === "installFailed" ? ut("update.retry") : ut("update.restartNow")}</button>}
        {phase === "downloadFailed" && <button type="button" className="sinawi-update-primary" onClick={() => void actions.retryDownload()}>{ut("update.retry")}</button>}
        {phase === "confirmSessions" && <>
          <button type="button" className="sinawi-update-primary" onClick={actions.restartWhenIdle}>{ut("update.whenDone")}</button>
          <button type="button" className="sinawi-update-secondary" onClick={() => void actions.restartAnyway()}>{ut("update.restartAnyway")}</button>
        </>}
        {(phase === "confirmSessions" || phase === "waitingForSessions") && <button type="button" className="sinawi-update-secondary" onClick={actions.cancelRestart}>{ut("update.cancel")}</button>}
        {state.notes && phase !== "installing" && <button type="button" className="sinawi-update-link" aria-expanded={showNotes} onClick={() => setShowNotes((open) => !open)}>{showNotes ? ut("update.hideNotes") : ut("update.notes")}</button>}
      </div>
      {showNotes && state.notes && <div className="sinawi-update-notes"><Markdown text={state.notes} /></div>}
    </div>
  );
}
