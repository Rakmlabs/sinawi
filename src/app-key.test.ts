// The app window sends its key with its own /api requests only, and asks again once after a stale-key 403.
import assert from "node:assert/strict";
import test from "node:test";
import { appKeyProtocols, installAppKeyFetch, loadAppKey } from "./app-key";

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
