import { createContext, useContext } from "react";
import type { WorkspaceDefaults, WorkspaceId, WorkspacePolicy } from "../server/types";
import { workspaceName, type WorkspaceSummary } from "./workspaces";

/** Workspace list and management actions shared by the header, sidebar, settings and dialogs. */
export type WorkspacesApi = {
  workspaces: WorkspaceSummary[];
  currentId?: WorkspaceId;
  defaults: Partial<Record<WorkspaceId, WorkspaceDefaults>>;
  /** Per-workspace rules (media generation, computer control, blocked tools, ...). */
  settings: Partial<Record<WorkspaceId, WorkspacePolicy>>;
  /** Running sessions per workspace id (every workspace, not only the current one). */
  running: Record<string, number>;
  switchTo: (id: WorkspaceId) => void;
  create: (name: string) => Promise<boolean>;
  rename: (id: WorkspaceId, name: string) => Promise<boolean>;
  remove: (id: WorkspaceId, moveTo: WorkspaceId) => Promise<boolean>;
  /** Saves another workspace's defaults (the current one is owned by its mounted WorkspaceApp). */
  saveDefaults: (id: WorkspaceId, defaults: WorkspaceDefaults) => Promise<boolean>;
  /** Saves part of a workspace's rules; the server merges it onto the stored ones. */
  saveSettings: (id: WorkspaceId, settings: Partial<WorkspacePolicy>) => Promise<boolean>;
};

const noop = async () => false;
export const WorkspacesContext = createContext<WorkspacesApi>({
  workspaces: [], defaults: {}, settings: {}, running: {},
  switchTo: () => {}, create: noop, rename: noop, remove: noop, saveDefaults: noop, saveSettings: noop,
});

export function useWorkspaces() {
  return useContext(WorkspacesContext);
}

export function useWorkspaceName(id: WorkspaceId | undefined) {
  return workspaceName(useWorkspaces().workspaces, id);
}
