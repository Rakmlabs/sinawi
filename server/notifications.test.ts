import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationStore } from "./notifications.js";

test("notifications persist, dedupe by workspace key, mark read, resolve and clear independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifications-"));
  try {
    const store = new NotificationStore(dir);
    const first = await store.add({ workspaceId: "personal", key: "auth:grok", type: "auth", title: "로그인 필요", body: "grok" });
    await store.read("personal", [first.id]);
    assert.equal((await store.list("personal"))[0].read, true);
    const same = await store.add({ workspaceId: "personal", key: "auth:grok", type: "auth", title: "로그인 필요", body: "grok" });
    assert.equal(same.id, first.id);
    assert.equal(same.read, true);
    await store.add({ workspaceId: "company", key: "auth:grok", type: "auth", title: "회사", body: "grok" });
    assert.equal((await new NotificationStore(dir).list("personal")).length, 1);
    await store.clear("personal");
    assert.equal((await store.list("personal")).length, 0);
    assert.equal((await store.list("company")).length, 1);
    await store.resolve("company", "auth:grok");
    assert.equal((await store.list("company")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("notifications serialize concurrent writes and retain newest 200 per workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifications-"));
  try {
    const store = new NotificationStore(dir);
    await Promise.all(Array.from({ length: 205 }, (_, i) => store.add({ workspaceId: "personal", key: String(i), type: "info", title: String(i), body: "" })));
    const list = await store.list("personal");
    assert.equal(list.length, 200);
    assert.equal(list[0].key, "204");
    await store.read("personal", "all");
    assert.ok((await store.list("personal")).every((n) => n.read));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
