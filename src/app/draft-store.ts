// Messages agents are still writing, keyed `${sessionId}:${workerId ?? ""}` (see server SessionDraft).
// The server pushes a draft about every 50ms. Keeping drafts in React state at the workspace root
// re-rendered the whole app per frame; this store lets only the components that show a draft
// subscribe to the one key they render.
import { useSyncExternalStore } from "react";
import type { SessionDraft } from "../../server/types";

export const draftKey = (sessionId: string, workerId?: string) => `${sessionId}:${workerId ?? ""}`;

export function createDraftStore() {
  let drafts = new Map<string, SessionDraft>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    get: (key: string) => drafts.get(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** An empty text ends the draft (the stored message replaces it). */
    put(draft: SessionDraft) {
      const key = draftKey(draft.sessionId, draft.workerId);
      if (!draft.text) {
        if (!drafts.has(key)) return;
        drafts = new Map(drafts);
        drafts.delete(key);
      } else {
        drafts = new Map(drafts).set(key, draft);
      }
      notify();
    },
    clear() {
      if (!drafts.size) return;
      drafts = new Map();
      notify();
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

/** The app-wide draft store (one socket per page feeds it). */
export const draftStore = createDraftStore();

/** The draft under `key`; re-renders the caller only when that draft changes. */
export function useDraft(key: string | undefined): SessionDraft | undefined {
  return useSyncExternalStore(draftStore.subscribe, () => key ? draftStore.get(key) : undefined, () => undefined);
}

/** Who is writing under `key` (a string, so callers re-render when a draft starts or ends, not per frame). */
export function useDraftAgent(key: string | undefined): SessionDraft["agent"] | undefined {
  return useSyncExternalStore(draftStore.subscribe, () => key ? draftStore.get(key)?.agent : undefined, () => undefined);
}
