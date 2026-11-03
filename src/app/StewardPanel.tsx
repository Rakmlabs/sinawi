import { useEffect, useState } from "react";
import { NotebookText, UserCheck } from "lucide-react";
import type { Session } from "../../server/types";
import { workspaceApi } from "./api";
import { Markdown } from "../Markdown";
import { t } from "../i18n";

type StewardInfo = { notes: string; transcript?: string; turns: number; rolloverAt: number };

/**
 * The project lead's notes at the top of its chat: what it carries from turn to turn and across
 * fresh CLI sessions (server/steward.ts). Refreshed whenever a turn ends.
 */
export function StewardPanel({ session }: { session: Session }) {
  const [info, setInfo] = useState<StewardInfo>();
  const turnEnded = session.status !== "running" ? session.endedAt : undefined;
  useEffect(() => {
    if (!session.steward) return;
    let live = true;
    workspaceApi<StewardInfo>(`/sessions/${session.id}/steward`).then((next) => { if (live) setInfo(next); }).catch(() => undefined);
    return () => { live = false; };
  }, [session.id, Boolean(session.steward), turnEnded]);
  if (!session.steward) return null;
  const queued = session.pendingInstructions?.length ?? 0;
  return <details className="goal-panel steward-panel">
    <summary>
      <UserCheck size={14} aria-hidden="true" />
      <strong>{t("steward.badge")}</strong>
      <span>{info?.notes ? t("steward.notesSummary", { turns: info.turns, total: info.rolloverAt }) : t("steward.noNotes")}{queued > 0 ? ` · ${t("steward.queued", { count: queued })}` : ""}</span>
    </summary>
    <div className="steward-notes">
      {info?.notes ? <Markdown text={info.notes} /> : <p>{t("steward.noNotesBody")}</p>}
      {info?.transcript && <p className="goal-note"><NotebookText size={12} />{t("steward.transcript", { path: info.transcript })}</p>}
    </div>
  </details>;
}
