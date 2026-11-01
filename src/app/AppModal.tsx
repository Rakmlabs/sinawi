import { X } from "lucide-react";
import { FolderPicker } from "../FolderPicker";
import type { WorkspaceId } from "../../server/types";
import { t } from "../i18n";

export type AppModalProps = {
  modal: string;
  setModal: (modal: string | undefined) => void;
  workspaceId: WorkspaceId;
  error: string;
  clearError: () => void;
  cwd: string;
  onUseFolder: (path: string) => void;
};

/**
 * Small app dialogs. Only the folder picker is left here: session options moved to the composer's
 * SessionPopover, bots to BotEditor, help and app settings to the settings window, usage to its page.
 */
export function AppModal({ modal, setModal, workspaceId, error, clearError, cwd, onUseFolder }: AppModalProps) {
  const close = () => setModal(undefined);
  if (modal !== "directory") return null;
  return <div className="modal-backdrop" onClick={close}>
    <section className="glass modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
      <div className="panel-header">
        <h2 id="modal-title">{t("modal.directory")}</h2>
        <button className="icon-button" onClick={close} aria-label={t("modal.close")}><X size={20} /></button>
      </div>
      <div className="modal-body">
        {error && <div className="error-banner" role="alert">
          {error}
          <button aria-label={t("modal.closeError")} onClick={clearError}><X size={16} /></button>
        </div>}
        <FolderPicker key={workspaceId} workspaceId={workspaceId} currentPath={cwd} onUse={onUseFolder} />
      </div>
    </section>
  </div>;
}
