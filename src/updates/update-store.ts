// App update state machine (framework-free; React binds it in useAppUpdate.ts).
//
// Policy: check ~10s after launch and every 6h (when enabled), download in the background, never
// install on its own. Installing + relaunching happens only on a user action, and only after the
// running-session count from /api/health is 0 or the user explicitly chose to restart anyway.
// Sessions live in the launchd server, so an app relaunch does not end them; the server code itself
// is swapped by server_agent.rs once idle. `server` reports when that swap is still pending/failed.

export interface PendingUpdate {
  version: string;
  body?: string;
  date?: string;
  download(onProgress: (downloaded: number, total?: number) => void): Promise<void>;
  install(): Promise<void>;
}

export interface Health { running: number; version: string }
export interface ServerVersions { bundled: string; installed: string }

export interface UpdateDeps {
  supported: boolean;
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
  health(): Promise<Health | null>;
  serverVersions(): Promise<ServerVersions | null>;
  appVersion(): Promise<string | null>;
  readAutoCheck(): boolean;
  writeAutoCheck(value: boolean): void;
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "downloading"
  | "ready"
  | "downloadFailed"
  | "confirmSessions" // user asked to restart while sessions run
  | "waitingForSessions" // restart scheduled for when they finish
  | "installing"
  | "installFailed"
  | "checkFailed";

export type ServerState = { kind: "ok" } | { kind: "pending"; running: number } | { kind: "stale" };

export interface UpdateState {
  supported: boolean;
  autoCheck: boolean;
  phase: UpdatePhase;
  currentVersion: string | null;
  version: string | null;
  notes: string;
  date: string | null;
  progress: { downloaded: number; total?: number } | null;
  running: number;
  error: string | null;
  lastChecked: number | null;
  /** True when the last check was user-initiated (failures and "up to date" are shown). */
  manual: boolean;
  /** Version the user closed the banner for; it stays hidden until a different version shows up. */
  dismissedVersion: string | null;
  server: ServerState;
  /** The user closed the server-version notice (re-shown when the state changes again). */
  serverDismissed: boolean;
}

export const CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SESSION_POLL_MS = 15_000;
export const SERVER_FIRST_CHECK_MS = 15_000;
export const SERVER_POLL_MS = 60_000;
/** Consecutive idle mismatches before the server is reported stale (the swap needs ~1 min). */
export const STALE_AFTER = 3;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createUpdateStore(deps: UpdateDeps) {
  let state: UpdateState = {
    supported: deps.supported,
    autoCheck: deps.readAutoCheck(),
    phase: "idle",
    currentVersion: null,
    version: null,
    notes: "",
    date: null,
    progress: null,
    running: 0,
    error: null,
    lastChecked: null,
    manual: false,
    dismissedVersion: null,
    server: { kind: "ok" },
    serverDismissed: false,
  };
  const listeners = new Set<() => void>();
  let pending: PendingUpdate | null = null;
  let started = false;
  let cancelCheckTimer: (() => void) | null = null;
  let cancelSessionTimer: (() => void) | null = null;
  let cancelServerTimer: (() => void) | null = null;
  let idleMismatches = 0;

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  /** Phases that hold a downloaded update; a background check must not clobber them. */
  const busy = () => ["checking", "downloading", "ready", "confirmSessions", "waitingForSessions", "installing"].includes(state.phase);

  function scheduleChecks(delay: number) {
    cancelCheckTimer?.();
    cancelCheckTimer = deps.setTimer(() => {
      void check(false);
      scheduleChecks(CHECK_INTERVAL_MS);
    }, delay);
  }

  async function download() {
    const update = pending;
    if (!update) return;
    set({ phase: "downloading", progress: { downloaded: 0 }, error: null });
    try {
      await update.download((downloaded, total) => set({ progress: { downloaded, total } }));
      if (pending === update) set({ phase: "ready" });
    } catch (error) {
      if (pending === update) set({ phase: "downloadFailed", error: message(error) });
    }
  }

  async function check(manual: boolean) {
    // While an update is downloaded or being applied, keep it (a re-check would discard the download).
    if (!deps.supported || busy()) return;
    set({ phase: "checking", manual, error: null });
    try {
      const update = await deps.check();
      set({ lastChecked: deps.now() });
      if (!update) { pending = null; set({ phase: "upToDate", version: null, notes: "", date: null }); return; }
      pending = update;
      set({ version: update.version, notes: update.body?.trim() ?? "", date: update.date ?? null });
      await download();
    } catch (error) {
      set({ phase: "checkFailed", error: message(error), lastChecked: deps.now() });
    }
  }

  async function install() {
    const update = pending;
    if (!update) return;
    cancelSessionTimer?.();
    cancelSessionTimer = null;
    set({ phase: "installing", error: null });
    try {
      await update.install();
      await deps.relaunch();
    } catch (error) {
      set({ phase: "installFailed", error: message(error) });
    }
  }

  async function runningSessions(): Promise<number> {
    // Unknown (server unreachable) counts as 0: there is nothing we could protect by waiting.
    return (await deps.health().catch(() => null))?.running ?? 0;
  }

  function pollSessions() {
    cancelSessionTimer?.();
    cancelSessionTimer = deps.setTimer(async () => {
      if (state.phase !== "waitingForSessions") return;
      const running = await runningSessions();
      if (state.phase !== "waitingForSessions") return;
      if (running === 0) await install();
      else { set({ running }); pollSessions(); }
    }, SESSION_POLL_MS);
  }

  const setServer = (server: ServerState) => {
    const same = JSON.stringify(server) === JSON.stringify(state.server);
    set({ server, serverDismissed: same ? state.serverDismissed : false });
  };

  async function checkServer() {
    cancelServerTimer?.();
    cancelServerTimer = null;
    const [versions, health] = await Promise.all([deps.serverVersions().catch(() => null), deps.health().catch(() => null)]);
    // No LaunchAgent (dev) or no version reported (dev server): nothing to compare.
    if (!versions || !health || !health.version || health.version === versions.bundled) {
      idleMismatches = 0;
      setServer({ kind: "ok" });
      return;
    }
    if (health.running > 0) { idleMismatches = 0; setServer({ kind: "pending", running: health.running }); }
    else {
      idleMismatches += 1;
      // A swap is normally done within about a minute of going idle; only then is it "stale".
      if (idleMismatches >= STALE_AFTER) setServer({ kind: "stale" });
    }
    cancelServerTimer = deps.setTimer(() => { void checkServer(); }, SERVER_POLL_MS);
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Idempotent: starts the launch check, the 6h interval and the server version check. */
    start() {
      if (started || !deps.supported) return;
      started = true;
      void deps.appVersion().then((currentVersion) => set({ currentVersion }), () => undefined);
      if (state.autoCheck) scheduleChecks(CHECK_DELAY_MS);
      cancelServerTimer = deps.setTimer(() => { void checkServer(); }, SERVER_FIRST_CHECK_MS);
    },
    stop() {
      started = false;
      for (const cancel of [cancelCheckTimer, cancelSessionTimer, cancelServerTimer]) cancel?.();
      cancelCheckTimer = cancelSessionTimer = cancelServerTimer = null;
    },
    checkNow: () => check(true),
    retryDownload: () => download(),
    setAutoCheck(value: boolean) {
      deps.writeAutoCheck(value);
      set({ autoCheck: value });
      if (!started) return;
      if (value) scheduleChecks(CHECK_DELAY_MS);
      else { cancelCheckTimer?.(); cancelCheckTimer = null; }
    },
    /** "지금 재시작": installs right away when idle, otherwise asks first. */
    async restart() {
      if (!pending || !["ready", "installFailed"].includes(state.phase)) return;
      const running = await runningSessions();
      if (running > 0) { set({ phase: "confirmSessions", running }); return; }
      await install();
    },
    /** "끝나면 재시작": install + relaunch as soon as no session runs. */
    restartWhenIdle() {
      if (!pending) return;
      set({ phase: "waitingForSessions" });
      pollSessions();
    },
    restartAnyway: () => install(),
    cancelRestart() {
      cancelSessionTimer?.();
      cancelSessionTimer = null;
      if (pending && ["confirmSessions", "waitingForSessions"].includes(state.phase)) set({ phase: "ready" });
    },
    dismiss() {
      if (updateBannerPhase(state)) set({ dismissedVersion: state.version, manual: false });
      else set({ serverDismissed: true });
    },
    recheckServer: () => checkServer(),
  };
}

export type UpdateStore = ReturnType<typeof createUpdateStore>;

function updateBannerPhase(state: UpdateState): boolean {
  if (["confirmSessions", "waitingForSessions", "installing", "installFailed"].includes(state.phase)) return true;
  // Background failures stay quiet (the next check retries); a manual check reports them.
  if (state.phase === "downloadFailed") return state.manual && state.version !== state.dismissedVersion;
  return state.phase === "ready" && state.version !== state.dismissedVersion;
}

/** What the floating banner shows, if anything: the update, else the server-version notice. */
export function bannerContent(state: UpdateState): "update" | "server" | null {
  if (!state.supported) return null;
  if (updateBannerPhase(state)) return "update";
  if (state.server.kind !== "ok" && !state.serverDismissed) return "server";
  return null;
}
