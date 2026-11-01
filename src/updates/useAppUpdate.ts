// React binding + real dependencies (Tauri updater/process plugins, /api/health, preferences).
import { useEffect, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { readPreference, savedBoolean, writePreference } from "../preferences";
import { createUpdateStore, type Health, type PendingUpdate, type ServerVersions, type UpdateStore } from "./update-store";

export const AUTO_CHECK_PREFERENCE = "updates.autoCheck";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function checkForUpdate(): Promise<PendingUpdate | null> {
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    date: update.date,
    async download(onProgress) {
      let downloaded = 0;
      let total: number | undefined;
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") downloaded += event.data.chunkLength;
        onProgress(downloaded, total);
      });
    },
    install: () => update.install(),
  };
}

async function health(): Promise<Health | null> {
  const response = await fetch("/api/health", { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as { running?: unknown; version?: unknown };
  return { running: typeof body.running === "number" ? body.running : 0, version: typeof body.version === "string" ? body.version : "" };
}

let store: UpdateStore | null = null;

/** The app-wide update store (one per page, shared by the banner and the settings section). */
export function appUpdateStore(): UpdateStore {
  store ??= createUpdateStore({
    supported: inTauri(),
    check: checkForUpdate,
    relaunch,
    health,
    serverVersions: () => invoke<ServerVersions | null>("server_version_status"),
    appVersion: getVersion,
    readAutoCheck: () => savedBoolean(readPreference(AUTO_CHECK_PREFERENCE), true),
    writeAutoCheck: (value) => writePreference(AUTO_CHECK_PREFERENCE, String(value)),
    now: () => Date.now(),
    setTimer: (callback, ms) => { const id = setTimeout(callback, ms); return () => clearTimeout(id); },
  });
  return store;
}

/** Update state + actions. The first mounted caller starts the launch/6h checks (idempotent). */
export function useAppUpdate() {
  const updates = appUpdateStore();
  const state = useSyncExternalStore(updates.subscribe, updates.getState, updates.getState);
  useEffect(() => { updates.start(); }, [updates]);
  return { state, actions: updates };
}
