import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkspaceSaver, workspaceShortcut } from "../workspaces";
import { readPreference, savedAutoSwitch, savedMode } from "../preferences";
import { terminalOwnsKeyboardEvent } from "../terminal-events";
import { workspaceApi } from "./api";
import type { WorkspaceDefaults, WorkspaceId, WorkspaceState } from "../../server/types";

/** Personal/company workspace state, persisted to the server and flushed on page hide. */
export function useWorkspaceState() {
  const [workspaces, setWorkspaces] = useState<WorkspaceState>();
  const [workspaceError, setWorkspaceError] = useState("");
  const state = useRef<WorkspaceState | undefined>(undefined);
  const [saveWorkspaces] = useState(() => createWorkspaceSaver((body) => workspaceApi("/workspaces", body, "PATCH")));
  const persist = useCallback((next: WorkspaceState) => {
    void saveWorkspaces(next).then(() => setWorkspaceError(""), (error) => setWorkspaceError((error as Error).message));
  }, [saveWorkspaces]);
  const loadWorkspaces = useCallback(async () => {
    try {
      const next = await workspaceApi<WorkspaceState>("/workspaces");
      // Retain the previous global mode on the first migration only.
      if (!next.defaults.personal.mode) next.defaults.personal.mode = savedMode(readPreference("mode"));
      if (next.defaults.personal.autoSwitch === undefined) next.defaults.personal.autoSwitch = savedAutoSwitch(readPreference("autoSwitch"));
      state.current = next;
      setWorkspaces(next);
      setWorkspaceError("");
    } catch (error) { setWorkspaceError((error as Error).message); }
  }, []);
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
    persist(state.current);
  }, [persist]);
  const switchWorkspace = useCallback((workspaceId: WorkspaceId) => {
    const current = state.current;
    if (!current || current.currentWorkspaceId === workspaceId) return;
    const next = { ...current, currentWorkspaceId: workspaceId };
    persist(next);
    state.current = next;
    setWorkspaces(next);
  }, [persist]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event)) return;
      const next = workspaceShortcut(event);
      if (!next) return;
      event.preventDefault();
      switchWorkspace(next);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [switchWorkspace]);
  /** Retry button: reload when nothing loaded yet, otherwise re-save the current state. */
  const retry = useCallback(() => {
    if (!state.current) void loadWorkspaces();
    else persist(state.current);
  }, [loadWorkspaces, persist]);
  return { workspaces, workspaceError, updateDefaults, switchWorkspace, retry };
}
