import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { APP_ERROR_EVENT } from "./link-open";
import { t } from "./i18n";
import type { AppApproval } from "../server/app-approvals";

/** The server's `app-approvals` WebSocket message (pending ones), re-sent as a window event. */
export const APP_APPROVALS_EVENT = "orchestra:app-approvals";

/** Who asked, by name: "담당 '백엔드'" before a bare "담당"; an outside AI has no name. */
export function approvalSource(item: Pick<AppApproval, "source" | "requester">): string {
  if (item.source !== "lead") return t("approval.external");
  return item.requester?.trim() ? t("approval.leadNamed", { name: item.requester.trim() }) : t("approval.lead");
}

type Props = { activeSessionId?: string; sessionTitle: (id: string) => string | undefined; onOpenSession: (id: string) => void };

/**
 * Tool calls from a lead or an outside AI (server/app-tools.ts) that are hard to undo: deleting,
 * changing settings, merging, stopping. Nothing ran yet; 승인 runs the tool, 거절 drops it. Shown
 * in every workspace, since an outside AI is not tied to the one on screen.
 */
export function AppApprovals({ activeSessionId, sessionTitle, onOpenSession }: Props) {
  const [items, setItems] = useState<AppApproval[]>([]);
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/app-approvals?status=pending");
      if (res.ok) setItems(((await res.json()) as { approvals?: AppApproval[] }).approvals ?? []);
    } catch { /* server restarting: the next push refreshes */ }
  }, []);
  useEffect(() => {
    void load();
    const pushed = (event: Event) => {
      const list = (event as CustomEvent<AppApproval[]>).detail;
      if (Array.isArray(list)) setItems(list);
    };
    window.addEventListener(APP_APPROVALS_EVENT, pushed);
    return () => window.removeEventListener(APP_APPROVALS_EVENT, pushed);
  }, [load]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/app-approvals/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { method: "POST" });
      const body = await res.json().catch(() => ({})) as { error?: string; status?: string };
      if (!res.ok) window.dispatchEvent(new CustomEvent(APP_ERROR_EVENT, { detail: body.error || res.statusText }));
      else if (body.status === "failed") window.dispatchEvent(new CustomEvent(APP_ERROR_EVENT, { detail: body.error || res.statusText }));
      setItems((old) => old.filter((item) => item.id !== id));
    } finally { setBusy(undefined); }
  };

  const shown = [...items].sort((a, b) => Number(b.sessionId === activeSessionId) - Number(a.sessionId === activeSessionId) || a.createdAt.localeCompare(b.createdAt));
  if (!shown.length) return null;
  return (
    <div className="perm-stack" role="region" aria-label={t("approval.label")}>
      {shown.map((item) => {
        const title = t("approval.title", { source: approvalSource(item) });
        const chat = item.sessionId ? sessionTitle(item.sessionId) || item.sessionTitle : undefined;
        const where = [
          item.workspaceName && t("approval.workspace", { name: item.workspaceName }),
          chat && t("approval.session", { name: `'${chat}'` }),
        ].filter(Boolean).join(" · ");
        return (
          <div key={item.id} className="perm-card" role="alertdialog" aria-label={title}>
            <div className="perm-head">
              <ShieldAlert size={15} aria-hidden="true" />
              <strong>{title}</strong>
              {item.sessionId && item.sessionId !== activeSessionId && (
                <button type="button" className="perm-session" onClick={() => onOpenSession(item.sessionId!)}>{chat || t("perm.otherSession")}</button>
              )}
            </div>
            <div>{item.summary}</div>
            {where && <div className="perm-meta">{where}</div>}
            <div className="perm-meta perm-id">{t("approval.id", { id: item.id.slice(0, 8) })}{item.sessionId ? ` · ${item.sessionId.slice(0, 8)}` : ""}</div>
            <code className="perm-detail" aria-label={t("approval.args")}>{item.tool} {JSON.stringify(item.args, null, 1)}</code>
            <div className="perm-actions">
              <button type="button" className="perm-deny" disabled={busy === item.id} onClick={() => void decide(item.id, false)}>{t("approval.reject")}</button>
              <button type="button" className="perm-allow" disabled={busy === item.id} onClick={() => void decide(item.id, true)}>{t("approval.approve")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
