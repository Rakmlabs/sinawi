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

test("auth alerts stay deduplicated per workspace and CLI until recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifications-auth-"));
  try {
    const store = new NotificationStore(dir);
    const personal = await store.add({
      workspaceId: "personal", key: "auth:claude", type: "auth", title: "Claude 로그인 필요", body: "first detail",
      action: { label: "로그인", command: "claude auth login" },
    });
    const company = await store.add({
      workspaceId: "company", key: "auth:claude", type: "auth", title: "Claude 로그인 필요", body: "company detail",
      action: { label: "로그인", command: "CLAUDE_CONFIG_DIR=/company claude auth login" },
    });
    await store.read("personal", [personal.id]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await store.add({
      workspaceId: "personal", key: "auth:claude", type: "auth", title: "Claude 로그인 필요", body: "new diagnostic detail",
      action: { label: "다시 로그인", command: "CLAUDE_CONFIG_DIR=/personal claude auth login" },
    });

    assert.equal(updated.id, personal.id);
    assert.equal(updated.updatedAt, personal.updatedAt);
    assert.equal(updated.read, true);
    assert.equal(updated.body, "new diagnostic detail");
    assert.equal((await store.list("company"))[0].id, company.id);
    assert.equal((await store.list("company"))[0].read, false);

    await store.resolve("personal", "auth:claude");
    assert.deepEqual(await store.list("personal"), []);
    const relapsed = await store.add({ workspaceId: "personal", key: "auth:claude", type: "auth", title: "Claude 로그인 필요", body: "failed again" });
    assert.notEqual(relapsed.id, personal.id);
    assert.equal(relapsed.read, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
