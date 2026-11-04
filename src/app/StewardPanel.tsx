import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { GitMerge, NotebookText, Plus, Settings2, UserCheck, Users, WandSparkles, X } from "lucide-react";
import type { AgentId, AgentSelection, MergePolicy, PendingMerge, Session, SkillInfo as Skill, Steward } from "../../server/types";
import { workspaceApi } from "./api";
import { Markdown } from "../Markdown";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { SkillPicker } from "./SkillPicker";
import { StewardSchedules } from "./StewardSchedules";
import { names } from "./labels";
import { t, type MessageKey } from "../i18n";

type StewardInfo = {
  notes: string; transcript?: string; turns: number; rolloverAt: number;
  name: string; report: string | null; acceptWork: boolean; peers: { id: string; name: string; cwd: string }[];
  steward: Steward | null; pendingMerge: PendingMerge | null;
  /** How many chats the lead has; this is one of them. */
  threads?: number;
};

/** What the panel edits on the lead itself (server/steward.ts StewardPatch). */
type EntityDraft = Pick<Steward, "systemPrompt" | "skills" | "agent" | "workers" | "mergePolicy"> & { model: string };

const AGENTS: AgentId[] = ["codex", "claude", "grok"];
const POLICIES: MergePolicy[] = ["ask", "auto", "never"];
const DIALOG_FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

const draftOf = (steward: Steward): EntityDraft => ({
  systemPrompt: steward.systemPrompt, skills: [...steward.skills], agent: steward.agent, model: steward.model ?? "",
  workers: steward.workers.map((worker) => ({ ...worker })), mergePolicy: steward.mergePolicy,
});

/** The team as the server stores it: ids and labels are renumbered there (normalizeWorkerConfigs). */
const teamOf = (workers: AgentSelection[]) => workers.map(({ agent, model }) => ({ agent, ...(model ? { model } : {}) }));
const same = (a: EntityDraft, b: EntityDraft) => JSON.stringify({ ...a, workers: teamOf(a.workers) }) === JSON.stringify({ ...b, workers: teamOf(b.workers) });

/**
 * The project lead at the top of its chat: its name, daily report time and the other leads it can
 * ask; its finished branches when they wait for the user's approval; and, folded in "lead
 * settings", its instructions, skills, team, merge policy, schedules and notes (the notes are the
 * lead's memory, server/steward.ts, so they stay out of the conversation). Refreshed when a turn ends.
 */
export function StewardPanel({ session, onChange }: { session: Session; onChange?: (session: Session) => void }) {
  const [info, setInfo] = useState<StewardInfo>();
  const [name, setName] = useState("");
  const [report, setReport] = useState("");
  const [acceptWork, setAcceptWork] = useState(false);
  const [draft, setDraft] = useState<EntityDraft>();
  const [notes, setNotes] = useState<string>();
  const [skills, setSkills] = useState<Skill[]>();
  const [pickingSkills, setPickingSkills] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const turnEnded = session.status !== "running" ? session.endedAt : undefined;
  const pendingAt = session.steward?.pendingMerge?.createdAt;
  useEffect(() => {
    if (!session.steward) return;
    let live = true;
    workspaceApi<StewardInfo>(`/sessions/${session.id}/steward`).then((next) => {
      if (!live) return;
      setInfo(next);
      setName(next.name);
      setReport(next.report ?? "");
      setAcceptWork(next.acceptWork);
      setDraft(next.steward ? draftOf(next.steward) : undefined);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [session.id, Boolean(session.steward), turnEnded, pendingAt, session.steward?.name, session.steward?.acceptWork, reload]);
  useEffect(() => {
    if (!settingsOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : settingsButton.current;
    settingsDialog.current?.focus();
    return () => {
      const target = settingsButton.current?.isConnected ? settingsButton.current : previous;
      target?.focus();
    };
  }, [settingsOpen]);
  if (!session.steward) return null;
  const pending = session.steward.pendingMerge ?? info?.pendingMerge ?? undefined;
  const entity = info?.steward ?? undefined;
  const chatChanged = Boolean(info && (name.trim() !== info.name || (report || null) !== info.report || acceptWork !== info.acceptWork));
  const entityChanged = Boolean(entity && draft && !same(draft, draftOf(entity)));
  const notesChanged = notes !== undefined && notes !== info?.notes;
  const changed = chatChanged || entityChanged || notesChanged;
  const settingsId = `steward-settings-${session.id}`;
  const settingsTitleId = `${settingsId}-title`;
  const fail = (error: unknown) => setStatus(error instanceof Error ? error.message : String(error));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    try {
      if (chatChanged) {
        const next = await workspaceApi<Session>(`/sessions/${session.id}/steward`, { name: name.trim(), report: report || null, acceptWork }, "PATCH");
        onChange?.(next);
      }
      if (entity && draft && (entityChanged || notesChanged)) {
        await workspaceApi<Steward>(`/stewards/${entity.id}`, {
          ...(entityChanged ? { systemPrompt: draft.systemPrompt, skills: draft.skills, agent: draft.agent, model: draft.model, workers: teamOf(draft.workers), mergePolicy: draft.mergePolicy } : {}),
          ...(notesChanged ? { notes } : {}),
        }, "PATCH");
      }
      setNotes(undefined);
      setReload((value) => value + 1);
      setStatus(notesChanged && !chatChanged && !entityChanged ? t("steward.notesSaved") : t("steward.saved"));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const decide = async (action: "approve" | "reject") => {
    setBusy(true);
    try {
      const next = await workspaceApi<Session>(`/sessions/${session.id}/merge/${action}`, undefined, "POST");
      onChange?.(next);
      setReload((value) => value + 1);
      setStatus(t(action === "approve" ? "steward.mergeApproved" : "steward.mergeRejected"));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const openSkills = () => {
    setPickingSkills(true);
    if (!skills) workspaceApi<Skill[]>(`/skills?cwd=${encodeURIComponent(session.cwd)}&workspace=${encodeURIComponent(session.workspaceId)}`).then(setSkills, () => setSkills([]));
  };
  const closeSettings = () => { setSettingsOpen(false); setPickingSkills(false); };
  const onSettingsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSettings(); return; }
    if (event.key !== "Tab") return;
    const nodes = [...(settingsDialog.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE) ?? [])].filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (!nodes.length) { event.preventDefault(); settingsDialog.current?.focus(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (document.activeElement === settingsDialog.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const edit = (patch: Partial<EntityDraft>) => { setDraft((old) => old && { ...old, ...patch }); setStatus(""); };
  const setWorker = (index: number, patch: Partial<AgentSelection>) => edit({ workers: draft!.workers.map((worker, at) => at === index ? { ...worker, ...patch } : worker) });
  const agentOptions = AGENTS.map((agent) => ({ value: agent, label: names[agent], icon: <AgentMark agent={agent} size="small" /> }));
  return <>
    <header className="steward-bar">
      <span className="steward-identity"><UserCheck size={14} aria-hidden="true" /><strong>{info?.name ?? t("steward.badge")}</strong></span>
      <span className={`steward-state ${session.status}`}><i aria-hidden="true" />{t(`status.${session.status}` as MessageKey)}</span>
      {status && !settingsOpen && <span className="steward-feedback" role="status">{status}</span>}
      <button ref={settingsButton} type="button" className="button light steward-settings-trigger" aria-haspopup="dialog" aria-expanded={settingsOpen} aria-controls={settingsId}
        onClick={() => setSettingsOpen(true)}><Settings2 size={13} aria-hidden="true" />{t("steward.more")}</button>
    </header>
    {pending && <div className="steward-merge" role="group" aria-label={t("steward.pendingMerge", { count: pending.branches.length })}>
      <GitMerge size={14} aria-hidden="true" />
      <div><strong>{t("steward.pendingMerge", { count: pending.branches.length })}</strong><span title={pending.branches.map((item) => item.branch).join(", ")}>{pending.branches.map((item) => item.workerLabel || item.branch).join(", ")}</span></div>
      <div className="steward-merge-actions">
        <button type="button" className="button light" disabled={busy || session.status === "running"} onClick={() => void decide("reject")}>{t("steward.rejectMerge")}</button>
        <button type="button" className="button primary" disabled={busy || session.status === "running"} onClick={() => void decide("approve")}>{t("steward.approveMerge")}</button>
      </div>
    </div>}
    {settingsOpen && createPortal(<div className="steward-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }}>
      <section ref={settingsDialog} id={settingsId} className="steward-settings-drawer" role="dialog" aria-modal="true" aria-labelledby={settingsTitleId} tabIndex={-1} onKeyDown={onSettingsKeyDown}>
        <header><div><h2 id={settingsTitleId}>{t("steward.more")}</h2><p>{info?.name ?? t("steward.badge")}</p></div>
          <button type="button" className="icon-button" aria-label={t("steward.closeSettings")} title={t("steward.closeSettings")} onClick={closeSettings}><X size={16} /></button></header>
        <form className="steward-settings" onSubmit={(event) => void save(event)}>
          <div className="steward-settings-basics">
            <label><span>{t("steward.name")}</span><input value={name} maxLength={80} onChange={(event) => { setName(event.target.value); setStatus(""); }} /></label>
            <label title={t("steward.reportLeadHint")}><span>{t("steward.report")}</span><input type="time" value={report} onChange={(event) => { setReport(event.target.value); setStatus(""); }} /></label>
            <label className="steward-accept" title={t("steward.acceptWorkHint")}><input type="checkbox" checked={acceptWork} onChange={(event) => { setAcceptWork(event.target.checked); setStatus(""); }} /><span>{t("steward.acceptWork")}</span></label>
          </div>
          {entity && draft && (pickingSkills
            ? <SkillPicker skills={skills ?? []} selected={draft.skills} onChange={(next) => edit({ skills: next })} onBack={() => setPickingSkills(false)} />
            : <div className="steward-settings-sections">
              <label className="steward-wide" title={t("steward.instructionsHint")}><span>{t("steward.instructions")}</span>
                <textarea rows={4} value={draft.systemPrompt} placeholder={t("steward.instructionsHint")} onChange={(event) => edit({ systemPrompt: event.target.value })} />
              </label>
              <div className="steward-settings-row">
                <button type="button" className="button light" onClick={openSkills}><WandSparkles size={12} aria-hidden="true" />{t("steward.skillsChoose", { n: draft.skills.length })}</button>
                <label title={t("steward.mergePolicyHint")}><span>{t("steward.mergePolicy")}</span>
                  <GlassSelect className="settings-select" label={t("steward.mergePolicy")} value={draft.mergePolicy} onChange={(value) => edit({ mergePolicy: value as MergePolicy })}
                    options={POLICIES.map((policy) => ({ value: policy, label: t(`steward.merge.${policy}` as MessageKey) }))} />
                </label>
              </div>
              <fieldset className="steward-team">
                <legend>{t("steward.team")}</legend>
                <label><span>{t("steward.lead")}</span>
                  <GlassSelect className="settings-select" label={t("steward.lead")} value={draft.agent} onChange={(value) => edit({ agent: value as AgentId })} options={agentOptions} />
                </label>
                <label><span>{t("steward.model")}</span><input value={draft.model} maxLength={200} onChange={(event) => edit({ model: event.target.value })} /></label>
                {draft.workers.map((worker, index) => <div className="steward-worker" key={index}>
                  <label><span>{t("steward.worker", { n: index + 1 })}</span>
                    <GlassSelect className="settings-select" label={t("steward.worker", { n: index + 1 })} value={worker.agent} onChange={(value) => setWorker(index, { agent: value as AgentId })} options={agentOptions} />
                  </label>
                  <label><span>{t("steward.model")}</span><input value={worker.model ?? ""} maxLength={200} onChange={(event) => setWorker(index, { model: event.target.value || undefined })} /></label>
                  <button type="button" className="icon-button" aria-label={t("steward.removeWorker")} title={t("steward.removeWorker")} disabled={draft.workers.length <= 1} onClick={() => edit({ workers: draft.workers.filter((_, at) => at !== index) })}><X size={13} /></button>
                </div>)}
                {draft.workers.length < 3 && <button type="button" className="button light" onClick={() => edit({ workers: [...draft.workers, { agent: "claude" }] })}><Plus size={12} aria-hidden="true" />{t("steward.addWorker")}</button>}
              </fieldset>
              <StewardSchedules stewardId={entity.id} refresh={`${turnEnded ?? ""}:${session.events.filter((event) => event.metadata?.schedule).length}`} />
              <section className="steward-notes-section" aria-label={t("steward.notesTitle")}>
                <header><NotebookText size={13} aria-hidden="true" /><strong>{t("steward.notesTitle")}</strong><small>{info?.notes ? t("steward.notesSummary", { turns: info.turns, total: info.rolloverAt }) : t("steward.noNotes")}</small></header>
                {notes !== undefined
                  ? <label className="steward-wide steward-notes-edit"><span>{t("steward.editNotes")}</span><textarea rows={8} value={notes} onChange={(event) => { setNotes(event.target.value); setStatus(""); }} /></label>
                  : info?.notes ? <Markdown text={info.notes} /> : <p>{t("steward.noNotesBody")}</p>}
                {notes === undefined && <button type="button" className="settings-link" onClick={() => setNotes(info?.notes ?? "")}>{t("steward.editNotes")}</button>}
                {info?.transcript && <p className="goal-note">{t("steward.transcript", { path: info.transcript })}</p>}
              </section>
            </div>)}
          <p className="goal-note steward-peers"><Users size={12} />{info?.peers.length ? t("steward.peers", { names: info.peers.map((peer) => `「${peer.name}」`).join(", ") }) : t("steward.noPeers")}</p>
          <footer>{status && <small role="status">{status}</small>}<button className="button primary" disabled={!changed || busy}>{t("steward.save")}</button></footer>
        </form>
      </section>
    </div>, document.body)}
  </>;
}
