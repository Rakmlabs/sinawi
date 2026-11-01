import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkspaceSaver, normalizeWorkspaces, workspaceShortcut, type WorkspacesState } from "../workspaces";
import { readPreference, savedAutoSwitch, savedMode } from "../preferences";
import { terminalOwnsKeyboardEvent } from "../terminal-events";
import { workspaceApi } from "./api";
import type { WorkspaceDefaults, WorkspaceId, WorkspacePolicy, WorkspaceState } from "../../server/types";

/** User-defined workspaces: list, current id and per-workspace defaults, persisted to the server. */
export function useWorkspaceState() {
  const [workspaces, setWorkspaces] = useState<WorkspacesState>();
  const [workspaceError, setWorkspaceError] = useState("");
  const state = useRef<WorkspacesState | undefined>(undefined);
  const [saveWorkspaces] = useState(() => createWorkspaceSaver((body) => workspaceApi("/workspaces", body, "PATCH")));
  const persist = useCallback((next: WorkspaceState, workspaceId?: WorkspaceId) => {
    void saveWorkspaces(next, false, workspaceId).then(() => setWorkspaceError(""), (error) => setWorkspaceError((error as Error).message));
  }, [saveWorkspaces]);
  const adopt = useCallback((raw: WorkspaceState) => {
    const next = normalizeWorkspaces(raw);
    state.current = next;
    setWorkspaces(next);
    setWorkspaceError("");
    return next;
  }, []);
  const loadWorkspaces = useCallback(async () => {
    try {
      const next = normalizeWorkspaces(await workspaceApi<WorkspaceState>("/workspaces"));
      // Retain the previous global mode on the first migration only (it belonged to the first workspace).
      const first = next.workspaces[0] && next.defaults[next.workspaces[0].id];
      if (first && !first.mode) first.mode = savedMode(readPreference("mode"));
      if (first && first.autoSwitch === undefined) first.autoSwitch = savedAutoSwitch(readPreference("autoSwitch"));
      adopt(next);
    } catch (error) { setWorkspaceError((error as Error).message); }
  }, [adopt]);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => {
    const flush = () => {
      const current = state.current;
      if (current) void saveWorkspaces(current, true).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [saveWorkspaces]);
  const updateDefaults = useCallback((workspaceId: WorkspaceId, defaults: WorkspaceDefaults) => {
    if (!state.current) return;
    state.current = { ...state.current, defaults: { ...state.current.defaults, [workspaceId]: defaults } };
    persist(state.current, workspaceId);
  }, [persist]);
  const switchWorkspace = useCallback((workspaceId: WorkspaceId) => {
    const current = state.current;
    if (!current || current.currentWorkspaceId === workspaceId || !current.workspaces.some((item) => item.id === workspaceId)) return;
    const next = { ...current, currentWorkspaceId: workspaceId };
    persist(next);
    state.current = next;
    setWorkspaces(next);
  }, [persist]);
  /** Runs a list mutation; the server answers with the full state, which replaces ours. */
  const mutate = useCallback(async (path: string, body: unknown, method: string) => {
    try {
      adopt(await workspaceApi<WorkspaceState>(path, body, method));
      return true;
    } catch (error) {
      setWorkspaceError((error as Error).message);
      return false;
    }
  }, [adopt]);
  const createWorkspace = useCallback((name: string) => mutate("/workspaces", { name }, "POST"), [mutate]);
  const renameWorkspace = useCallback((id: WorkspaceId, name: string) => mutate(`/workspaces/${encodeURIComponent(id)}`, { name }, "PATCH"), [mutate]);
  const saveSettings = useCallback((id: WorkspaceId, settings: Partial<WorkspacePolicy>) => mutate(`/workspaces/${encodeURIComponent(id)}`, { settings }, "PATCH"), [mutate]);
  const deleteWorkspace = useCallback((id: WorkspaceId, moveTo: WorkspaceId) =>
    mutate(`/workspaces/${encodeURIComponent(id)}?moveTo=${encodeURIComponent(moveTo)}`, undefined, "DELETE"), [mutate]);
  /** Defaults of a workspace that is not mounted (edited from settings). */
  const saveDefaults = useCallback(async (id: WorkspaceId, defaults: WorkspaceDefaults) => {
    const current = state.current;
    if (!current) return false;
    if (id === current.currentWorkspaceId) { updateDefaults(id, defaults); return true; }
    const next = { ...current, defaults: { ...current.defaults, [id]: defaults } };
    state.current = next;
    setWorkspaces(next);
    try {
      await saveWorkspaces(next, false, id);
      return true;
    } catch (error) {
      setWorkspaceError((error as Error).message);
      return false;
    }
  }, [saveWorkspaces, updateDefaults]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event)) return;
      const index = workspaceShortcut(event);
      const target = index === undefined ? undefined : state.current?.workspaces[index];
      if (!target) return;
      event.preventDefault();
      switchWorkspace(target.id);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [switchWorkspace]);
  /** Retry button: reload when nothing loaded yet, otherwise re-save the current state. */
  const retry = useCallback(() => {
    if (!state.current) void loadWorkspaces();
    else persist(state.current);
  }, [loadWorkspaces, persist]);
  return { workspaces, workspaceError, updateDefaults, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, saveDefaults, saveSettings, retry };
}
