// The app window sends its key with its own /api requests only, and asks again once after a stale-key 403.
import assert from "node:assert/strict";
import test from "node:test";
import { appKeyProtocols, appKeyStatus, installAppKeyFetch, loadAppKey } from "./app-key";

test("only same-origin /api requests carry the key; a stale key is fetched again once", async () => {
  const seen: Array<{ url: string; key: string | null }> = [];
  let keys = ["old-key", "new-key"];
  let refuse = true;
  const win = {
    location: { origin: "http://127.0.0.1:3001" },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-sinawi-app");
      seen.push({ url: String(input), key });
      if (refuse && key === "old-key") return new Response("{}", { status: 403, headers: { "x-sinawi-app-key": "required" } });
      return new Response("{}", { status: 200 });
    },
    __TAURI_INTERNALS__: { invoke: async () => keys.shift() },
  } as unknown as Window & { __TAURI_INTERNALS__: unknown };
  await loadAppKey(true, win as never);
  installAppKeyFetch(win as never);
  assert.deepEqual(appKeyProtocols(), ["sinawi-app.old-key"]);
  const res = await win.fetch("/api/settings", { method: "PUT" });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((item) => item.key), ["old-key", "new-key"], "retried once with the new key");
  seen.length = 0;
  await win.fetch("https://example.com/api/x");
  await win.fetch("http://127.0.0.1:3001/assets/app.js");
  assert.deepEqual(seen.map((item) => item.key), [null, null], "nothing else gets the key");
  refuse = false; keys = [];
});

test("a dev link's key is kept for this tab only and taken out of the address bar", async () => {
  const stored = new Map<string, string>();
  let replaced: string | undefined;
  const key = "a".repeat(43);
  const win = {
    location: { hash: `#sinawi-app-key=${key}`, pathname: "/", search: "?x=1" },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { replaced = url; } },
    sessionStorage: { getItem: (name: string) => stored.get(name) ?? null, setItem: (name: string, value: string) => { stored.set(name, value); } },
  };
  assert.equal(await loadAppKey(true, win as never), key);
  assert.equal(replaced, "/?x=1", "the key leaves the address bar");
  win.location.hash = "";
  assert.equal(await loadAppKey(true, win as never), key, "a reload of the same tab keeps it");
  assert.equal(await loadAppKey(true, { location: { hash: "#sinawi-app-key=short", pathname: "/", search: "" } } as never), undefined, "a page opened any other way has none");
});

test("a window the server could not confirm is marked, so the sidebar says why it is cut off", async () => {
  await loadAppKey(true, { __TAURI_INTERNALS__: { invoke: async () => "k".repeat(43) } } as never);
  let calls = 0;
  const stop = appKeyStatus.subscribe(() => { calls++; });
  await loadAppKey(true, { __TAURI_INTERNALS__: { invoke: async () => { throw new Error("the server refused"); } } } as never);
  assert.equal(appKeyStatus.missing(), true);
  await loadAppKey(true, { __TAURI_INTERNALS__: { invoke: async () => "k".repeat(43) } } as never);
  assert.equal(appKeyStatus.missing(), false);
  stop();
  assert.equal(calls, 2);
});

// Fourth review R4-4: the key socket closes connections beyond its concurrent peer checks; the window
// asks again instead of staying without a key.
test("a refused key request is tried again a few times", async () => {
  let calls = 0;
  const win = { __TAURI_INTERNALS__: { invoke: async () => { calls += 1; if (calls < 3) throw new Error("the server refused"); return "fresh-key"; } } };
  assert.equal(await loadAppKey(true, win as never, [1, 1, 1]), "fresh-key");
  assert.equal(calls, 3);
  calls = -10;
  assert.equal(await loadAppKey(true, win as never, [1, 1]), undefined, "gives up after the last wait");
  assert.equal(calls, -7);
});
