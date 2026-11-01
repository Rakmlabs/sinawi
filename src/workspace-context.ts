import { createContext, useContext } from "react";
import type { WorkspaceDefaults, WorkspaceId } from "../server/types";
import { workspaceName, type WorkspaceSummary } from "./workspaces";

/** Workspace list and management actions shared by the header, sidebar, settings and dialogs. */
export type WorkspacesApi = {
  workspaces: WorkspaceSummary[];
  currentId?: WorkspaceId;
  defaults: Partial<Record<WorkspaceId, WorkspaceDefaults>>;
  /** Running sessions per workspace id (every workspace, not only the current one). */
  running: Record<string, number>;
  switchTo: (id: WorkspaceId) => void;
  create: (name: string) => Promise<boolean>;
  rename: (id: WorkspaceId, name: string) => Promise<boolean>;
  remove: (id: WorkspaceId, moveTo: WorkspaceId) => Promise<boolean>;
  /** Saves another workspace's defaults (the current one is owned by its mounted WorkspaceApp). */
  saveDefaults: (id: WorkspaceId, defaults: WorkspaceDefaults) => Promise<boolean>;
};

const noop = async () => false;
export const WorkspacesContext = createContext<WorkspacesApi>({
  workspaces: [], defaults: {}, running: {},
  switchTo: () => {}, create: noop, rename: noop, remove: noop, saveDefaults: noop,
});

export function useWorkspaces() {
  return useContext(WorkspacesContext);
}

export function useWorkspaceName(id: WorkspaceId | undefined) {
  return workspaceName(useWorkspaces().workspaces, id);
}
