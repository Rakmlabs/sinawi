import test from "node:test";
import assert from "node:assert/strict";
import { canGo, emptyHistory, recordLocation, safeHref, traverse } from "./tab-history";

test("back on the first page of a tab does nothing (never escapes to the app window)", () => {
  const h = recordLocation(emptyHistory(), "http://127.0.0.1:4100/");
  assert.equal(traverse(h, -1), undefined);
  assert.equal(canGo(h, -1), false);
  assert.equal(traverse(emptyHistory(), -1), undefined);
});

test("back/forward walk the tab's own entries and branch on new navigation", () => {
  let h = emptyHistory();
  for (const p of ["a", "b", "c"]) h = recordLocation(h, `http://127.0.0.1:4100/${p}`);
  const back = traverse(h, -1)!;
  assert.equal(back.href, "http://127.0.0.1:4100/b");
  h = recordLocation(back.history, back.href);
  assert.equal(h.index, 1);
  assert.ok(canGo(h, 1));
  h = recordLocation(h, "http://127.0.0.1:4100/b"); // title update / reload
  assert.equal(h.entries.length, 3);
  h = recordLocation(h, "http://127.0.0.1:4100/d");
  assert.deepEqual(h.entries.map((e) => e.slice(-1)), ["a", "b", "d"]);
  assert.equal(canGo(h, 1), false);
});

test("unparsable or non-http locations are ignored instead of throwing", () => {
  for (const bad of ["", "::::", "not a url", "tauri://localhost/", "javascript:alert(1)", undefined, 42]) {
    assert.equal(safeHref(bad), undefined);
    assert.deepEqual(recordLocation(emptyHistory(), bad), emptyHistory());
  }
});
