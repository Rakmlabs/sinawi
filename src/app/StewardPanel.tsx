import { useEffect, useState, type FormEvent } from "react";
import { NotebookText, UserCheck, Users } from "lucide-react";
import type { Session } from "../../server/types";
import { workspaceApi } from "./api";
import { Markdown } from "../Markdown";
import { t } from "../i18n";

type StewardInfo = {
  notes: string; transcript?: string; turns: number; rolloverAt: number;
  name: string; report: string | null; acceptWork: boolean; peers: { id: string; name: string; cwd: string }[];
};

/**
 * The project lead's notes at the top of its chat: what it carries from turn to turn and across
 * fresh CLI sessions (server/steward.ts), with its name, its daily report time and the other leads
 * it can ask. Refreshed whenever a turn ends.
 */
export function StewardPanel({ session, onChange }: { session: Session; onChange?: (session: Session) => void }) {
  const [info, setInfo] = useState<StewardInfo>();
  const [name, setName] = useState("");
  const [report, setReport] = useState("");
  const [acceptWork, setAcceptWork] = useState(false);
  const [status, setStatus] = useState("");
  const turnEnded = session.status !== "running" ? session.endedAt : undefined;
  useEffect(() => {
    if (!session.steward) return;
    let live = true;
    workspaceApi<StewardInfo>(`/sessions/${session.id}/steward`).then((next) => {
      if (!live) return;
      setInfo(next);
      setName(next.name);
      setReport(next.report ?? "");
      setAcceptWork(next.acceptWork);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [session.id, Boolean(session.steward), turnEnded, session.steward?.name, session.steward?.report, session.steward?.acceptWork]);
  if (!session.steward) return null;
  const queued = session.pendingInstructions?.length ?? 0;
  const changed = info && (name.trim() !== info.name || (report || null) !== info.report || acceptWork !== info.acceptWork);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    try {
      const updated = await workspaceApi<Session>(`/sessions/${session.id}/steward`, { name: name.trim(), report: report || null, acceptWork }, "PATCH");
      onChange?.(updated);
      setStatus(t("steward.saved"));
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const summary = [
    info?.notes ? t("steward.notesSummary", { turns: info.turns, total: info.rolloverAt }) : t("steward.noNotes"),
    session.steward.report ? t("steward.reportSummary", { time: session.steward.report }) : "",
    queued > 0 ? t("steward.queued", { count: queued }) : "",
  ].filter(Boolean).join(" · ");
  return <details className="goal-panel steward-panel">
    <summary>
      <UserCheck size={14} aria-hidden="true" />
      <strong>{info?.name ?? t("steward.badge")}</strong>
      <span>{summary}</span>
    </summary>
    <div className="steward-notes">
      <form className="steward-settings" onSubmit={(event) => void save(event)}>
        <label><span>{t("steward.name")}</span><input value={name} maxLength={80} onChange={(event) => { setName(event.target.value); setStatus(""); }} /></label>
        <label title={t("steward.reportHint")}><span>{t("steward.report")}</span><input type="time" value={report} onChange={(event) => { setReport(event.target.value); setStatus(""); }} /></label>
        <label className="steward-accept" title={t("steward.acceptWorkHint")}><input type="checkbox" checked={acceptWork} onChange={(event) => { setAcceptWork(event.target.checked); setStatus(""); }} /><span>{t("steward.acceptWork")}</span></label>
        <button className="button light" disabled={!changed}>{t("steward.save")}</button>
        {status && <small role="status">{status}</small>}
      </form>
      {info?.notes ? <Markdown text={info.notes} /> : <p>{t("steward.noNotesBody")}</p>}
      <p className="goal-note"><Users size={12} />{info?.peers.length ? t("steward.peers", { names: info.peers.map((peer) => `「${peer.name}」`).join(", ") }) : t("steward.noPeers")}</p>
      {info?.transcript && <p className="goal-note"><NotebookText size={12} />{t("steward.transcript", { path: info.transcript })}</p>}
    </div>
  </details>;
}
