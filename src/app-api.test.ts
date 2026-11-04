import test from "node:test";
import assert from "node:assert/strict";
import { accountScopeKey, scopedApi, workspacePath } from "./app/api";

test("workspace GET paths carry the caller's workspace explicitly", () => {
  assert.equal(workspacePath("/settings", "client work"), "/settings?workspace=client%20work");
  assert.equal(workspacePath("/bootstrap?cwd=%2Ftmp", "company"), "/bootstrap?cwd=%2Ftmp&workspace=company");
});

test("workspace model refresh POST includes workspaceId in its body", async () => {
  const previous = globalThis.fetch;
  let request: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { input: String(input), init };
    return { ok: true, status: 200, text: async () => "{}" } as Response;
  }) as typeof fetch;
  try {
    await scopedApi("company")("/settings/models/refresh", { reason: "focus" });
    assert.equal(request?.input, "/api/settings/models/refresh");
    assert.equal(request?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), { reason: "focus", workspaceId: "company" });
  } finally {
    globalThis.fetch = previous;
  }
});

test("account scope keys change only when a CLI account folder changes", () => {
  assert.equal(accountScopeKey(undefined), accountScopeKey({}));
  assert.equal(accountScopeKey({ codex: "/accounts/work" }), accountScopeKey({ codex: "/accounts/work" }));
  assert.notEqual(accountScopeKey({ codex: "/accounts/work" }), accountScopeKey({ codex: "/accounts/new" }));
  assert.notEqual(accountScopeKey({ codex: "/accounts/work" }), accountScopeKey({ codex: "/accounts/work", claude: "/accounts/claude" }));
});
