import { readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isArray, isPlainObject, readJsonFile, writeJsonFile } from "./json-file.js";
import type { Bot, Group, Session, ToolSettings, WorkspaceState } from "./types.js";
import { normalizeWorkerConfigs } from "./workers.js";
import { defaultDataDir } from "./runtime.js";

const dataDir = defaultDataDir;
const botsFile = resolve(dataDir, "bots.json");
let botMutationQueue: Promise<void> = Promise.resolve();
let groupMutationQueue: Promise<void> = Promise.resolve();
let sessionMutationQueue: Promise<void> = Promise.resolve();
let workspaceMutationQueue: Promise<void> = Promise.resolve();
let toolMutationQueue: Promise<void> = Promise.resolve();

async function loadArray<T>(file: string): Promise<T[]> {
  return (await readJsonFile(file, isArray) as T[] | undefined) ?? [];
}

async function saveArray<T>(file: string, values: T[]): Promise<void> {
  await writeJsonFile(file, values, 2);
}

async function loadObject<T>(file: string): Promise<T | undefined> {
  return await readJsonFile(file, isPlainObject) as T | undefined;
}

async function saveObject<T>(file: string, value: T): Promise<void> {
  await writeJsonFile(file, value, 2);
}

export async function loadBots(): Promise<Bot[]> {
  return loadArray<Bot>(botsFile);
}

async function saveBots(bots: Bot[]): Promise<void> {
  await saveArray(botsFile, bots);
}

async function readGroups(directory: string): Promise<Group[]> {
  const file = resolve(directory, "groups.json");
  const groups = await loadArray<Group>(file);
  const migrated = groups.some((group) => !group.workspaceId);
  for (const group of groups) group.workspaceId ??= "personal";
  if (migrated) await saveArray(file, groups);
  return groups;
}

export function loadGroups(directory = dataDir): Promise<Group[]> {
  const operation = groupMutationQueue.then(() => readGroups(directory));
  groupMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function mutateGroups<T>(mutator: (groups: Group[]) => T | Promise<T>, directory = dataDir): Promise<T> {
  const operation = groupMutationQueue.then(async () => {
    const groups = await readGroups(directory);
    const result = await mutator(groups);
    await saveArray(resolve(directory, "groups.json"), groups);
    return result;
  });
  groupMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// Each session lives in `sessions/<id>.json`, so a run only rewrites its own file.
// Older versions kept every session in one `sessions.json`; it is split on first load.
const sessionsFolder = (directory: string) => resolve(directory, "sessions");
const sessionFile = (directory: string, id: string) => resolve(sessionsFolder(directory), `${encodeURIComponent(id)}.json`);

function sessionIdFromFile(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  try { return decodeURIComponent(name.slice(0, -".json".length)); } catch { return undefined; }
}

async function listSessionFiles(directory: string): Promise<string[]> {
  try { return (await readdir(sessionsFolder(directory))).filter((name) => sessionIdFromFile(name) !== undefined); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

async function readSessions(directory: string): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const name of await listSessionFiles(directory)) {
    const session = await readJsonFile(resolve(sessionsFolder(directory), name), isPlainObject) as Session | undefined;
    if (session?.id) sessions.push(session);
  }
  const legacyFile = resolve(directory, "sessions.json");
  const legacy = await readJsonFile(legacyFile, isArray) as Session[] | undefined;
  const known = new Set(sessions.map((session) => session.id));
  // Files already split out are newer than a legacy copy left by an interrupted migration.
  const imported = (legacy ?? []).filter((session) => session?.id && !known.has(session.id));
  sessions.push(...imported);
  const changed = new Set(imported.map((session) => session.id));
  for (const session of sessions) {
    if (!session.workspaceId || session.workerConfigs?.some((worker) => !worker.id || !worker.label) || !session.workerConfigs?.length) changed.add(session.id);
    session.workspaceId ??= "personal";
    session.workerConfigs = normalizeWorkerConfigs(session.workers, session.workerConfigs);
  }
  if (changed.size) await writeSessionFiles(sessions.filter((session) => changed.has(session.id)), directory);
  if (legacy) await rename(legacyFile, `${legacyFile}.migrated`);
  return sessions;
}

async function writeSessionFiles(sessions: Session[], directory: string): Promise<void> {
  for (const session of sessions) await writeJsonFile(sessionFile(directory, session.id), session);
}

async function removeDeletedSessionFiles(ids: Set<string>, directory: string): Promise<void> {
  for (const name of await listSessionFiles(directory)) {
    if (!ids.has(sessionIdFromFile(name)!)) await rm(resolve(sessionsFolder(directory), name), { force: true });
  }
}

export function loadSessions(directory = dataDir): Promise<Session[]> {
  const operation = sessionMutationQueue.then(() => readSessions(directory));
  sessionMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function loadWorkspaceState(directory = dataDir): Promise<WorkspaceState> {
  const stored = await loadObject<WorkspaceState>(resolve(directory, "workspaces.json"));
  return {
    currentWorkspaceId: stored?.currentWorkspaceId === "company" ? "company" : "personal",
    defaults: {
      personal: stored?.defaults?.personal ?? {},
      company: stored?.defaults?.company ?? {},
    },
  };
}

export function saveWorkspaceState(state: WorkspaceState, directory = dataDir): Promise<void> {
  const snapshot = structuredClone(state);
  const operation = workspaceMutationQueue.then(() => saveObject(resolve(directory, "workspaces.json"), snapshot));
  workspaceMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function mutateWorkspaceState<T>(mutator: (state: WorkspaceState) => T | Promise<T>, directory = dataDir): Promise<T> {
  const operation = workspaceMutationQueue.then(async () => {
    const state = await loadWorkspaceState(directory);
    const result = await mutator(state);
    await saveObject(resolve(directory, "workspaces.json"), state);
    return result;
  });
  workspaceMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function loadToolSettings(directory = dataDir): Promise<ToolSettings> {
  const stored = await loadObject<Partial<ToolSettings>>(resolve(directory, "tool-settings.json"));
  const normalize = (value: ToolSettings["personal"] | undefined) => ({
    disabledSkills: Array.isArray(value?.disabledSkills) ? [...new Set(value.disabledSkills.filter((item): item is string => typeof item === "string"))] : [],
    disabledMcp: Array.isArray(value?.disabledMcp) ? [...new Set(value.disabledMcp.filter((item): item is string => typeof item === "string"))] : [],
  });
  return { personal: normalize(stored?.personal), company: normalize(stored?.company) };
}

export function mutateToolSettings<T>(mutator: (settings: ToolSettings) => T | Promise<T>, directory = dataDir): Promise<T> {
  const operation = toolMutationQueue.then(async () => {
    const settings = await loadToolSettings(directory);
    const result = await mutator(settings);
    await saveObject(resolve(directory, "tool-settings.json"), settings);
    return result;
  });
  toolMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// Saves the given session list. With `changedIds`, only those sessions are rewritten;
// files of sessions no longer in the list are removed either way.
export function saveSessions(sessions: Session[], directory = dataDir, changedIds?: Iterable<string>): Promise<void> {
  const ids = new Set(sessions.map((session) => session.id));
  const changed = changedIds ? new Set(changedIds) : undefined;
  const snapshot = structuredClone(changed ? sessions.filter((session) => changed.has(session.id)) : sessions);
  const operation = sessionMutationQueue.then(async () => {
    await writeSessionFiles(snapshot, directory);
    await removeDeletedSessionFiles(ids, directory);
  });
  sessionMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// Coalesces frequent saves (one per CLI output line) into at most one write per delay.
// `schedule` keeps the latest value (or folds it into the pending one with `merge`);
// `flush` writes now and resolves once that write, including anything scheduled before it, is on disk.
export function createCoalescedSaver<T>(save: (value: T) => void | Promise<void>, delayMs = 250, merge: (pending: T, next: T) => T = (_pending, next) => next) {
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!pending) return chain;
    const { value } = pending;
    pending = undefined;
    const write = chain.then(() => save(value));
    // A failed write is folded back in so the next save retries it.
    chain = write.catch(() => { add(value, false); });
    return write;
  };

  const add = (value: T, latest = true) => {
    pending = { value: !pending ? value : latest ? merge(pending.value, value) : merge(value, pending.value) };
  };

  return {
    schedule(value: T) {
      add(value);
      timer ??= setTimeout(() => { void run().catch(() => undefined); }, delayMs);
    },
    flush(...args: [] | [T]): Promise<void> {
      if (args.length) add(args[0]);
      return run();
    },
  };
}

export function mutateBots<T>(mutator: (bots: Bot[]) => T | Promise<T>): Promise<T> {
  const operation = botMutationQueue.then(async () => {
    const bots = await loadBots();
    const result = await mutator(bots);
    await saveBots(bots);
    return result;
  });
  botMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Worker IDs live on the persisted conversation, separate from its orchestrator ID. */
export function workerSessionId(session: Session, workerId: string): string | undefined {
  return session.workerSessionIds?.[workerId];
}

export function setWorkerSessionId(session: Session, workerId: string, id?: string): void {
  if (id) (session.workerSessionIds ??= {})[workerId] = id;
  else if (session.workerSessionIds) delete session.workerSessionIds[workerId];
}
