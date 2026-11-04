import { useEffect, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Schedule } from "../../server/schedules";
import { workspaceApi } from "./api";
import { scheduleWhen } from "../lead";
import { getLang, t } from "../i18n";
import { ConfirmDialog } from "../settings/controls";

type Draft = { id?: string; title: string; prompt: string; repeat: boolean; at: string; cron: string };

const empty = (): Draft => ({ title: "", prompt: "", repeat: false, at: "", cron: "0 9 * * 1-5" });

/** `datetime-local` value for an ISO time, in this computer's zone. */
function localInput(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const draftOf = (schedule: Schedule): Draft => ({ id: schedule.id, title: schedule.title, prompt: schedule.prompt, repeat: Boolean(schedule.cron), at: localInput(schedule.at), cron: schedule.cron ?? "0 9 * * 1-5" });

/**
 * The lead's schedules in its settings: what the lead made in conversation and what the user adds.
 * `refresh` changes when the chat may have changed them (a turn ended, a schedule card arrived).
 */
export function StewardSchedules({ stewardId, refresh, onCount }: { stewardId: string; refresh?: unknown; onCount?: (count: number) => void }) {
  const [list, setList] = useState<Schedule[]>();
  const [draft, setDraft] = useState<Draft>();
  const [removing, setRemoving] = useState<Schedule>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    workspaceApi<Schedule[]>(`/stewards/${stewardId}/schedules`).then((next) => {
      if (!live) return;
      setList(next);
      onCount?.(next.length);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [stewardId, refresh, reload]);
  const fail = (error: unknown) => setStatus(error instanceof Error ? error.message : String(error));
  const run = async (task: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await task(); setReload((value) => value + 1); setStatus(done ?? ""); } catch (error) { fail(error); } finally { setBusy(false); }
  };
  // Not a <form>: the panel sits inside the lead settings form.
  const save = () => {
    if (!draft || busy || !draft.prompt.trim()) return;
    // A one-off's time is read in this computer's zone (the server's default zone too).
    const timing = draft.repeat ? { cron: draft.cron.trim(), at: "" } : { at: draft.at ? new Date(draft.at).toISOString() : "", cron: "" };
    const body = { title: draft.title.trim(), prompt: draft.prompt.trim(), ...timing };
    void run(async () => {
      await (draft.id ? workspaceApi(`/schedules/${draft.id}`, body, "PATCH") : workspaceApi(`/stewards/${stewardId}/schedules`, body, "POST"));
      setDraft(undefined);
    }, t("steward.scheduleSaved"));
  };
  const locale = getLang() === "ko" ? "ko-KR" : "en-US";
  const edit = (patch: Partial<Draft>) => { setDraft((old) => old && { ...old, ...patch }); setStatus(""); };
  return <section className="steward-schedules" aria-label={t("steward.schedules")}>
    <header><CalendarClock size={13} aria-hidden="true" /><strong>{t("steward.schedules")}</strong><small>{t("steward.schedulesHint")}</small></header>
    {list && !list.length && !draft && <p className="steward-schedules-empty">{t("steward.schedulesEmpty")}</p>}
    {!!list?.length && <ul>
      {list.map((item) => <li key={item.id} className={item.enabled ? "" : "off"}>
        <div>
          <strong>{item.title}</strong>
          <span>{scheduleWhen(item, locale)}{item.enabled ? item.nextRunAt && item.cron ? ` · ${t("steward.scheduleNext", { time: new Date(item.nextRunAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) })}` : "" : ` · ${t("steward.scheduleOff")}`} · {t(item.createdBy === "lead" ? "steward.scheduleByLead" : "steward.scheduleByUser")}</span>
        </div>
        <button type="button" className="icon-button" disabled={busy || (!item.enabled && !item.cron && Boolean(item.at) && new Date(item.at!).getTime() <= Date.now())} title={t(item.enabled ? "steward.schedulePause" : "steward.scheduleResume")} aria-label={t(item.enabled ? "steward.schedulePause" : "steward.scheduleResume")}
          onClick={() => void run(() => workspaceApi(`/schedules/${item.id}`, { enabled: !item.enabled }, "PATCH"))}>{item.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
        <button type="button" className="icon-button" disabled={busy} title={t("steward.scheduleEdit")} aria-label={t("steward.scheduleEdit")} onClick={() => { setDraft(draftOf(item)); setStatus(""); }}><Pencil size={13} /></button>
        <button type="button" className="icon-button" disabled={busy} title={t("steward.scheduleDelete")} aria-label={t("steward.scheduleDelete")} onClick={() => setRemoving(item)}><Trash2 size={13} /></button>
      </li>)}
    </ul>}
    {draft
      ? <div className="steward-schedule-form" role="group" aria-label={t(draft.id ? "steward.scheduleEdit" : "steward.scheduleNew")}>
        <label><span>{t("steward.scheduleTitle")}</span><input value={draft.title} maxLength={120} onChange={(event) => edit({ title: event.target.value })} /></label>
        <label className="steward-wide"><span>{t("steward.schedulePrompt")}</span><textarea rows={3} value={draft.prompt} onChange={(event) => edit({ prompt: event.target.value })} /></label>
        <fieldset role="radiogroup" aria-label={t("steward.scheduleKind")}>
          <label><input type="radio" checked={!draft.repeat} onChange={() => edit({ repeat: false })} />{t("steward.scheduleOnce")}</label>
          <label><input type="radio" checked={draft.repeat} onChange={() => edit({ repeat: true })} />{t("steward.scheduleRepeat")}</label>
        </fieldset>
        {draft.repeat
          ? <label title={t("steward.scheduleCronHint")}><span>{t("steward.scheduleCron")}</span><input value={draft.cron} placeholder="0 9 * * 1-5" onChange={(event) => edit({ cron: event.target.value })} /><small>{t("steward.scheduleCronHint")}</small></label>
          : <label><span>{t("steward.scheduleAt")}</span><input type="datetime-local" value={draft.at} onChange={(event) => edit({ at: event.target.value })} /></label>}
        <div className="steward-schedule-actions">
          <button type="button" className="button light" disabled={busy || !draft.prompt.trim() || (draft.repeat ? !draft.cron.trim() : !draft.at)} onClick={save}>{t("steward.scheduleSave")}</button>
          <button type="button" className="button light" onClick={() => { setDraft(undefined); setStatus(""); }}>{t("steward.scheduleCancel")}</button>
        </div>
      </div>
      : <button type="button" className="button light" disabled={busy} onClick={() => { setDraft(empty()); setStatus(""); }}><Plus size={12} aria-hidden="true" />{t("steward.scheduleNew")}</button>}
    {status && <small role="status">{status}</small>}
    {removing && <ConfirmDialog title={t("steward.scheduleDelete")} body={t("steward.scheduleDeleteConfirm", { title: removing.title })} confirmLabel={t("steward.scheduleDelete")}
      onCancel={() => setRemoving(undefined)}
      onConfirm={() => { const item = removing; setRemoving(undefined); void run(() => workspaceApi(`/schedules/${item.id}`, undefined, "DELETE")); }} />}
  </section>;
}
