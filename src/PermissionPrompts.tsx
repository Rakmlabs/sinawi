import { waitsElsewhere } from "./AppApprovals";
import { useCallback, useEffect, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { APP_ERROR_EVENT } from "./link-open";
import { t } from "./i18n";
import { openSettings } from "./settings/settings-nav";

/** A shell command that starts one of the interpreters the workspace no longer pre-approves (H2). */
export function isRuntimeCommand(detail: string): boolean {
  return /^(?:Bash\()?\s*(?:node|npx|python3|npm|pnpm|yarn|find|ao-serve\s+start)\b/u.test(detail.trim());
}

export type PermissionRequest = { id: string; sessionId: string; workspaceId: string; agent: string; toolName: string; detail: string; createdAt: string };
/** The server's `permissions` WebSocket message, re-sent as a window event. */
export const PERMISSIONS_EVENT = "orchestra:permissions";

type Props = { workspaceId: string; activeSessionId?: string; sessionTitle: (id: string) => string | undefined; onOpenSession: (id: string) => void };

/**
 * Questions a running agent is waiting on ("may I read this folder / run this command?"). The run
 * is paused until the user answers here; the server refuses unanswered ones after a while.
 */
export function PermissionPrompts({ workspaceId, activeSessionId, sessionTitle, onOpenSession }: Props) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [answering, setAnswering] = useState<string>();
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/permissions?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (res.ok) setRequests(((await res.json()) as { requests?: PermissionRequest[] }).requests ?? []);
    } catch { /* server restarting: the next push refreshes */ }
  }, [workspaceId]);
  useEffect(() => {
    void load();
    const pushed = (event: Event) => {
      const list = (event as CustomEvent<PermissionRequest[]>).detail;
      if (Array.isArray(list)) setRequests(list.filter((item) => item.workspaceId === workspaceId));
    };
    window.addEventListener(PERMISSIONS_EVENT, pushed);
    return () => window.removeEventListener(PERMISSIONS_EVENT, pushed);
  }, [load, workspaceId]);

  const answer = async (id: string, allow: boolean) => {
    setAnswering(id);
    try {
      const res = await fetch(`/api/permissions/${encodeURIComponent(id)}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow }) });
      if (!res.ok) window.dispatchEvent(new CustomEvent(APP_ERROR_EVENT, { detail: ((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText }));
      setRequests((old) => old.filter((item) => item.id !== id));
    } finally { setAnswering(undefined); }
  };

  // The active session's questions first: those are the ones the user is looking at.
  const shown = [...requests].sort((a, b) => Number(b.sessionId === activeSessionId) - Number(a.sessionId === activeSessionId) || a.createdAt.localeCompare(b.createdAt));
  if (!shown.length) return null;
  return (
    <div className="perm-stack" role="region" aria-label={t("perm.label")}>
      {shown.map((item) => waitsElsewhere(item.sessionId, activeSessionId) ? (
        // Another chat's question: one line that leads there, not a full card over this chat (third review U2).
        <div key={item.id} className="perm-elsewhere" role="status">
          <ShieldQuestion size={14} aria-hidden="true" />
          <span>{t("perm.elsewhere", { chat: sessionTitle(item.sessionId) || t("perm.otherSession") })} <span className="perm-elsewhere-what">{t("perm.title", { tool: item.toolName })}</span></span>
          <button type="button" className="perm-session" onClick={() => onOpenSession(item.sessionId)}>{t("perm.openChat")}</button>
        </div>
      ) : (
        <div key={item.id} className="perm-card" role="alertdialog" aria-label={t("perm.title", { tool: item.toolName })}>
          <div className="perm-head">
            <ShieldQuestion size={15} aria-hidden="true" />
            <strong>{t("perm.title", { tool: item.toolName })}</strong>
            {item.sessionId !== activeSessionId && (
              <button type="button" className="perm-session" onClick={() => onOpenSession(item.sessionId)}>{sessionTitle(item.sessionId) || t("perm.otherSession")}</button>
            )}
          </div>
          <code className="perm-detail">{item.detail}</code>
          {isRuntimeCommand(item.detail) && <p className="perm-meta perm-hint">{t("perm.runtimeHint")} <button type="button" className="link-button" onClick={() => openSettings("workspaces", "ws-runtime-programs")}>{t("perm.runtimeOpen")}</button></p>}
          <div className="perm-actions">
            <button type="button" className="perm-deny" disabled={answering === item.id} onClick={() => void answer(item.id, false)}>{t("perm.deny")}</button>
            <button type="button" className="perm-allow" disabled={answering === item.id} onClick={() => void answer(item.id, true)} autoFocus={item.sessionId === activeSessionId}>{t("perm.allow")}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
