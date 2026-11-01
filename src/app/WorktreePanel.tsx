import { useCallback, useEffect, useState } from "react";
import { Check, Copy, FolderOpen, GitBranch, Trash2 } from "lucide-react";
import type { Session, WorktreeStatus } from "../../server/types";
import { writeClipboard } from "../CopyButton";
import { t } from "../i18n";
import { workspaceApi } from "./api";
import "../worktrees.css";

/**
 * The session's worker branches (git worktrees): where each worker's changes are, how many files
 * changed, and actions. Merging is left to the developer: the panel only copies a merge command.
 */
export function WorktreePanel({ session }: { session: Pick<Session, "id" | "status" | "worktrees"> }) {
  const [items, setItems] = useState<WorktreeStatus[]>();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<{ workerId: string; uncommitted: number }>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string>();
  const count = session.worktrees?.length ?? 0;
  const key = (session.worktrees ?? []).map((item) => `${item.workerId}:${item.path}`).join("|");
  const load = useCallback(async () => {
    try {
      const data = await workspaceApi<{ worktrees: WorktreeStatus[] }>(`/sessions/${session.id}/worktrees`);
      setItems(data.worktrees);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [session.id]);
  useEffect(() => { if (count) void load(); }, [count, key, session.status, load]);
  if (!count) return null;

  const open = async (workerId: string) => {
    try { await workspaceApi(`/sessions/${session.id}/worktrees/${encodeURIComponent(workerId)}/open`, {}, "POST"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const copy = async (workerId: string, command: string) => {
    let clipboard: { writeText: (text: string) => Promise<void> } | undefined;
    try { clipboard = navigator.clipboard; } catch { clipboard = undefined; }
    if (await writeClipboard(command, clipboard)) {
      setCopied(workerId);
      window.setTimeout(() => setCopied((current) => current === workerId ? undefined : current), 1_800);
    } else setError(t("copy.clipboardError"));
  };
  const remove = async (workerId: string, force = false) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/sessions/${session.id}/worktrees/${encodeURIComponent(workerId)}${force ? "?force=1" : ""}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.code === "WORKTREE_DIRTY") { setConfirming({ workerId, uncommitted: data.uncommitted ?? 0 }); return; }
      if (!response.ok) throw new Error(data.error || t("api.requestFailed"));
      setConfirming(undefined);
      setError(data.branchKept ? t("wt.branchKept", { commits: data.commits }) : "");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <details className="worktree-panel">
    <summary><GitBranch size={14} />{t("wt.title", { count })}<span>{t("wt.subtitle")}</span></summary>
    {error && <p className="worktree-error" role="alert">{error}</p>}
    <ul>
      {(items ?? session.worktrees ?? []).map((item) => {
        const status = "exists" in item ? item as WorktreeStatus : undefined;
        return <li key={item.workerId}>
          <div className="worktree-head">
            <strong>{item.workerLabel ?? item.workerId}</strong>
            <code>{item.branch}</code>
            {status && <span className="worktree-count">{status.exists ? t("wt.changed", { count: status.changedFiles }) : t("wt.missing")}{status.uncommitted ? ` · ${t("wt.uncommitted", { count: status.uncommitted })}` : ""}{status.commits ? ` · ${t("wt.commits", { count: status.commits })}` : ""}</span>}
          </div>
          <p className="worktree-path" title={item.path}>{item.path}</p>
          {item.mainDirty && <p className="worktree-note">{t("wt.mainDirty")}</p>}
          <div className="worktree-actions">
            <button type="button" className="button light" disabled={status?.exists === false} onClick={() => void open(item.workerId)}><FolderOpen size={13} />{t("wt.open")}</button>
            {status && <button type="button" className="button light" title={status.mergeCommand} onClick={() => void copy(item.workerId, status.mergeCommand)}>{copied === item.workerId ? <Check size={13} /> : <Copy size={13} />}{copied === item.workerId ? t("copy.copied") : t("wt.copyMerge")}</button>}
            <button type="button" className="button light worktree-danger" disabled={busy || session.status === "running"} onClick={() => void remove(item.workerId)}><Trash2 size={13} />{t("wt.remove")}</button>
          </div>
          {confirming?.workerId === item.workerId && <div className="worktree-confirm" role="alert">
            <p>{t("wt.dirtyConfirm", { count: confirming.uncommitted })}</p>
            <button type="button" className="button light worktree-danger" disabled={busy} onClick={() => void remove(item.workerId, true)}>{t("wt.removeAnyway")}</button>
            <button type="button" className="button light" onClick={() => setConfirming(undefined)}>{t("side.cancel")}</button>
          </div>}
        </li>;
      })}
    </ul>
  </details>;
}
