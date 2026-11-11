import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_DELAY_MS, CHECK_INTERVAL_MS, SERVER_FIRST_CHECK_MS, SESSION_POLL_MS, STALE_AFTER, bannerContent, createUpdateStore, type Health, type PendingUpdate, type UpdateDeps } from "./update-store";
import { updateDictionaries } from "./strings";

function harness(overrides: Partial<UpdateDeps> = {}) {
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  let clock = 0;
  const calls = { check: 0, install: 0, relaunch: 0 };
  let health: Health | null = { running: 0, version: "srv" };
  let autoCheck = true;
  let update: PendingUpdate | null = {
    version: "1.2.0",
    body: "  notes\n",
    async download(onProgress) { onProgress(5, 10); onProgress(10, 10); },
    async install() { calls.install += 1; },
  };
  const deps: UpdateDeps = {
    supported: true,
    check: async () => { calls.check += 1; return update; },
    relaunch: async () => { calls.relaunch += 1; },
    health: async () => health,
    serverVersions: async () => ({ bundled: "srv", installed: "srv" }),
    appVersion: async () => "1.0.0",
    readAutoCheck: () => autoCheck,
    writeAutoCheck: (value) => { autoCheck = value; },
    now: () => clock,
    setTimer(callback, ms) {
      const timer = { at: clock + ms, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...overrides,
  };
  const store = createUpdateStore(deps);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Advances the fake clock, firing due timers in order. */
  async function advance(ms: number) {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      clock = due.at;
      due.callback();
      await settle(); await settle();
    }
    clock = end;
    await settle();
  }
  return {
    store, calls, advance, settle,
    setHealth: (value: Health | null) => { health = value; },
    setUpdate: (value: PendingUpdate | null) => { update = value; },
    autoCheck: () => autoCheck,
  };
}

test("checks ~10s after launch, downloads in background, then every 6h; never installs on its own", async () => {
  const h = harness();
  h.store.start();
  h.store.start(); // idempotent
  await h.advance(CHECK_DELAY_MS - 1);
  assert.equal(h.calls.check, 0);
  await h.advance(1);
  assert.equal(h.calls.check, 1);
  const state = h.store.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.version, "1.2.0");
  assert.equal(state.notes, "notes");
  assert.deepEqual(state.progress, { downloaded: 10, total: 10 });
  assert.equal(state.currentVersion, "1.0.0");
  assert.equal(bannerContent(state), "update");
  // A downloaded update is kept: a later check finding the same version keeps it, and nothing installs by itself.
  await h.advance(CHECK_INTERVAL_MS);
  assert.equal(h.calls.check, 2);
  assert.equal(h.store.getState().phase, "ready");
  assert.equal(h.store.getState().version, "1.2.0");
  assert.equal(h.calls.install + h.calls.relaunch, 0);
});

test("a check while an update is ready picks up a newer release, and keeps the old one if that download fails", async () => {
  const h = harness();
  await h.store.checkNow();
  assert.equal(h.store.getState().phase, "ready");
  let downloads = 0;
  h.setUpdate({ version: "1.3.0", body: "newer", async download() { downloads += 1; throw new Error("offline"); }, async install() {} });
  await h.store.checkNow();
  assert.equal(downloads, 1);
  assert.equal(h.store.getState().phase, "ready");
  assert.equal(h.store.getState().version, "1.2.0", "falls back to the downloaded update");
  h.setUpdate({ version: "1.3.0", body: "newer", async download() { downloads += 1; }, async install() {} });
  await h.store.checkNow();
  assert.equal(h.store.getState().phase, "ready");
  assert.equal(h.store.getState().version, "1.3.0");
  assert.equal(h.store.getState().notes, "newer");
});

test("a double click on restart installs once", async () => {
  const h = harness();
  await h.store.checkNow();
  await Promise.all([h.store.restart(), h.store.restart(), h.store.restartAnyway()]);
  assert.equal(h.calls.install, 1);
  assert.equal(h.calls.relaunch, 1);
});

test("auto-check off: no scheduled check, manual check still works; preference persisted", async () => {
  const h = harness({ readAutoCheck: () => false });
  h.store.start();
  await h.advance(CHECK_INTERVAL_MS);
  assert.equal(h.calls.check, 0);
  h.setUpdate(null);
  await h.store.checkNow();
  assert.equal(h.store.getState().phase, "upToDate");
  h.store.setAutoCheck(true);
  assert.equal(h.autoCheck(), true);
  await h.advance(CHECK_DELAY_MS);
  assert.equal(h.calls.check, 2);
});

test("restart installs + relaunches immediately when no session runs", async () => {
  const h = harness();
  await h.store.checkNow();
  await h.store.restart();
  assert.equal(h.calls.install, 1);
  assert.equal(h.calls.relaunch, 1);
});

test("running sessions: asks first, then restarts only once they finish", async () => {
  const h = harness();
  await h.store.checkNow();
  h.setHealth({ running: 2, version: "srv" });
  await h.store.restart();
  assert.equal(h.store.getState().phase, "confirmSessions");
  assert.equal(h.store.getState().running, 2);
  assert.equal(h.calls.install, 0);

  h.store.restartWhenIdle();
  h.setHealth({ running: 1, version: "srv" });
  await h.advance(SESSION_POLL_MS);
  assert.equal(h.store.getState().phase, "waitingForSessions");
  assert.equal(h.store.getState().running, 1);
  assert.equal(h.calls.install, 0);

  h.setHealth({ running: 0, version: "srv" });
  await h.advance(SESSION_POLL_MS);
  assert.equal(h.calls.install, 1);
  assert.equal(h.calls.relaunch, 1);
});

test("cancelling a deferred restart stops polling and returns to ready", async () => {
  const h = harness();
  await h.store.checkNow();
  h.setHealth({ running: 1, version: "srv" });
  await h.store.restart();
  h.store.restartWhenIdle();
  h.store.cancelRestart();
  h.setHealth({ running: 0, version: "srv" });
  await h.advance(SESSION_POLL_MS * 3);
  assert.equal(h.store.getState().phase, "ready");
  assert.equal(h.calls.install, 0);
});

test("install failure is reported and can be retried", async () => {
  let fail = true;
  const h = harness();
  h.setUpdate({ version: "1.2.0", async download() {}, async install() { if (fail) throw new Error("disk full"); } });
  await h.store.checkNow();
  await h.store.restart();
  assert.equal(h.store.getState().phase, "installFailed");
  assert.equal(h.store.getState().error, "disk full");
  fail = false;
  await h.store.restart();
  assert.equal(h.calls.relaunch, 1);
});

test("background download failures stay quiet; manual ones show in the banner", async () => {
  const h = harness();
  h.setUpdate({ version: "1.2.0", async download() { throw new Error("offline"); }, async install() {} });
  h.store.start();
  await h.advance(CHECK_DELAY_MS);
  assert.equal(h.store.getState().phase, "downloadFailed");
  assert.equal(bannerContent(h.store.getState()), null);
  await h.store.checkNow();
  assert.equal(bannerContent(h.store.getState()), "update");
});

test("closing a failed install hides it until the restart is retried", async () => {
  let fail = true;
  const h = harness();
  h.setUpdate({ version: "1.2.0", async download() {}, async install() { if (fail) throw new Error("disk full"); } });
  await h.store.checkNow();
  await h.store.restart();
  assert.equal(bannerContent(h.store.getState()), "update");
  h.store.dismiss();
  assert.equal(h.store.getState().phase, "installFailed");
  assert.equal(bannerContent(h.store.getState()), null);
  await h.store.restart();
  assert.equal(bannerContent(h.store.getState()), "update", "a failed retry shows again");
  fail = false;
  await h.store.restart();
  assert.equal(h.calls.relaunch, 1);
});

test("dismiss hides the banner for that version only", async () => {
  const h = harness();
  await h.store.checkNow();
  h.store.dismiss();
  assert.equal(bannerContent(h.store.getState()), null);
  assert.equal(h.store.getState().phase, "ready", "still installable from settings");
});

test("server version mismatch: pending while sessions run, stale only after it persists idle", async () => {
  const h = harness({ serverVersions: async () => ({ bundled: "new", installed: "old" }) });
  h.setUpdate(null);
  h.setHealth({ running: 1, version: "old" });
  h.store.start();
  await h.advance(SERVER_FIRST_CHECK_MS);
  assert.deepEqual(h.store.getState().server, { kind: "pending", running: 1 });
  assert.equal(bannerContent(h.store.getState()), "server");
  h.setHealth({ running: 0, version: "old" });
  for (let i = 1; i < STALE_AFTER; i += 1) await h.store.recheckServer();
  assert.equal(h.store.getState().server.kind, "pending");
  await h.store.recheckServer();
  assert.equal(h.store.getState().server.kind, "stale");
  h.store.dismiss();
  assert.equal(bannerContent(h.store.getState()), null);
  h.setHealth({ running: 0, version: "new" });
  await h.store.recheckServer();
  assert.equal(h.store.getState().server.kind, "ok");
});

test("outside Tauri nothing runs", async () => {
  const h = harness({ supported: false });
  h.store.start();
  await h.advance(CHECK_INTERVAL_MS);
  await h.store.checkNow();
  assert.equal(h.calls.check, 0);
  assert.equal(bannerContent(h.store.getState()), null);
});

test("update strings: en has exactly the ko keys", () => {
  assert.deepEqual(Object.keys(updateDictionaries.en).sort(), Object.keys(updateDictionaries.ko).sort());
});

test("a closed server notice stays closed while only the running count changes", async () => {
  const h = harness({ serverVersions: async () => ({ bundled: "new", installed: "old" }) });
  h.setUpdate(null);
  h.setHealth({ running: 2, version: "old" });
  await h.store.recheckServer();
  assert.equal(bannerContent(h.store.getState()), "server");
  h.store.dismiss();
  h.setHealth({ running: 1, version: "old" });
  await h.store.recheckServer();
  assert.deepEqual(h.store.getState().server, { kind: "pending", running: 1 });
  assert.equal(bannerContent(h.store.getState()), null);
});
