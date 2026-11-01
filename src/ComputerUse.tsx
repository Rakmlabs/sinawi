import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, MousePointerClick, OctagonX, X } from "lucide-react";
import type { ComputerActivity } from "../server/computer-bridge";
import { activitiesBetween, getComputerSnapshot, imageUrl, revokeComputer, startComputerUse, stopComputer, subscribeComputer } from "./computer-use";
import { useWorkspaces } from "./workspace-context";
import { t, useT } from "./i18n";
import { SettingRow, StatusBadge } from "./settings/controls";
import { openSettings } from "./settings/settings-nav";

const agentName = (agent?: string) => agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : agent === "grok" ? "Grok" : t("cu.agentFallback");
const useComputer = () => useSyncExternalStore(subscribeComputer, getComputerSnapshot, getComputerSnapshot);

/**
 * "Controlling your Mac" banner. Mounted once in the workspace shell. Display only: approval is a
 * native macOS alert shown by the app process (`computer_exec`), never a control on this page.
 */
export function ComputerUseLayer() {
  useT();
  const { state } = useComputer();
  const [notice, setNotice] = useState("");
  useEffect(() => { startComputerUse(); }, []);
  useEffect(() => { if (state.stopped) { setNotice(t("cu.stopped")); const timer = setTimeout(() => setNotice(""), 6_000); return () => clearTimeout(timer); } }, [state.stopped]);
  const agents = [...new Set(state.sessions.map((s) => agentName(s.agent)))].join(", ");
  return <>
    {state.active && <div className="cu-banner" role="status">
      <span className="cu-dot" aria-hidden="true" />
      <strong>{t("cu.banner", { agents })}</strong>
      <span className="cu-banner-sessions">{state.sessions.map((s) => <span key={s.key} className="cu-chip" title={s.title}>{agentName(s.agent)}{s.title ? ` · ${s.title}` : ""}
        <button type="button" aria-label={`${t("cu.revoke")} ${s.title ?? ""}`} title={t("cu.revoke")} onClick={() => void revokeComputer(s.key)}><X size={12} aria-hidden="true" /></button></span>)}</span>
      <span className="cu-spacer" />
      <kbd className="cu-hint">{t("cu.stopHint")}</kbd>
      <button type="button" className="cu-stop" onClick={() => void stopComputer("banner")}><OctagonX size={14} aria-hidden="true" />{t("cu.stop")}</button>
    </div>}
    {notice && !state.active && <div className="cu-banner stopped" role="status"><OctagonX size={14} aria-hidden="true" />{notice}</div>}
  </>;
}

/** Header pill shown while any session may control the computer; click stops everything. */
export function ComputerIndicator() {
  useT();
  const { state } = useComputer();
  if (!state.active) return null;
  const agents = [...new Set(state.sessions.map((s) => agentName(s.agent)))].join(", ");
  return <button type="button" className="cu-indicator" title={t("cu.activeTitle", { agents })} aria-label={t("cu.activeTitle", { agents })} onClick={() => void stopComputer("header")}>
    <span className="cu-dot" aria-hidden="true" />{t("cu.active")}
  </button>;
}

function Entry({ item }: { item: ComputerActivity }) {
  const [open, setOpen] = useState(false);
  return <li className={`cu-entry${item.ok ? "" : " failed"}`}>
    <MousePointerClick size={13} aria-hidden="true" />
    <span className="cu-entry-text">{item.summary}{!item.ok && <em title={item.error}> · {t("cu.failed")}: {item.error}</em>}</span>
    <time>{new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
    {item.image && <button type="button" className={`cu-thumb${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      <img src={imageUrl(item.image.name)} alt={t("cu.shotAlt", { summary: item.summary })} loading="lazy" />
    </button>}
  </li>;
}

/** Computer actions a session took between two chat messages, like a folded tool-call list. */
export function ComputerTrail({ sessionId, from, to }: { sessionId: string; from?: string; to?: string }) {
  useT();
  const { activity } = useComputer();
  const items = activitiesBetween(activity, sessionId, from, to);
  if (!items.length) return null;
  return <section className="cu-trail" aria-label={t("cu.entry")}>
    <header><MousePointerClick size={13} aria-hidden="true" />{t("cu.entry")} · {items.length}</header>
    <ol>{items.map((item) => <Entry key={item.id} item={item} />)}</ol>
  </section>;
}

/** Onboarding/permissions row: the per-workspace switch state (off by default). */
export function ComputerUseStatus({ workspaceId }: { workspaceId: string }) {
  useT();
  const { settings, saveSettings } = useWorkspaces();
  const on = settings[workspaceId]?.computerUse === true;
  return <div className={`ob-row ${on ? "ok" : "optional"}`}>
    <div className="ob-row-head"><MousePointerClick size={18} /><strong>{t("cu.status.title")}</strong><small>{t("ob.optional")}</small><span className="ob-spacer" />
      <span className={`ob-badge ${on ? "ok" : "info"}`}>{on ? <><Check size={13} />{t("cu.status.on")}</> : t("cu.status.off")}</span></div>
    <p className="ob-why">{t("cu.status.why")}</p>
    <p className="ob-hint">{t("cu.status.hint")}</p>
    {!on && <div className="ob-actions"><button className="ob-btn" onClick={() => void saveSettings(workspaceId, { computerUse: true })}>{t("cu.status.enable")}</button></div>}
  </div>;
}

/** Settings › Environment slot: this workspace's switch (changed in Settings › Workspaces) and the sessions allowed right now. */
export function ComputerUseWorkspaceRows({ workspaceId }: { workspaceId?: string }) {
  useT();
  const { settings } = useWorkspaces();
  const { state } = useComputer();
  if (!workspaceId) return null;
  const on = settings[workspaceId]?.computerUse === true;
  const sessions = state.sessions.filter((s) => s.workspaceId === workspaceId);
  return <>
    <SettingRow id="env-computer-workspace" icon={<MousePointerClick size={15} aria-hidden="true" />} label={t("cu.status.workspace")}
      description={on ? t("cu.status.onHint") : t("cu.status.why")}
      badges={on ? <StatusBadge tone="ok">{t("cu.status.on")}</StatusBadge> : <StatusBadge tone="muted">{t("cu.status.off")}</StatusBadge>}>
      <button type="button" className="settings-button" onClick={() => openSettings("workspaces", "ws-computer")}>{on ? t("cu.status.manage") : t("cu.status.enable")}</button>
    </SettingRow>
    {sessions.length > 0 && <SettingRow id="env-computer-sessions" label={t("cu.status.sessions", { n: sessions.length })}
      description={<span className="cu-banner-sessions">{sessions.map((s) => <span key={s.key} className="cu-chip" title={s.title}>{agentName(s.agent)}{s.title ? ` · ${s.title}` : ""}
        <button type="button" aria-label={`${t("cu.revoke")} ${s.title ?? ""}`} title={t("cu.revoke")} onClick={() => void revokeComputer(s.key)}><X size={12} aria-hidden="true" /></button></span>)}</span>}>
      <button type="button" className="settings-button" onClick={() => void stopComputer("settings")}><OctagonX size={14} aria-hidden="true" />{t("cu.stop")}</button>
    </SettingRow>}
  </>;
}
