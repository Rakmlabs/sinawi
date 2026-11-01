import assert from "node:assert/strict";
import test from "node:test";
import { appContentSecurityPolicy, isAllowedOrigin } from "./origin-policy.js";
import { isLocalOrigin } from "./server.js";

test("only the app and its dev servers are allowed browser origins", () => {
  for (const origin of ["http://127.0.0.1:3001", "http://localhost:3001", "http://127.0.0.1:5188", "http://LOCALHOST:5188", "http://127.0.0.1:5198", "tauri://localhost"]) {
    assert.equal(isAllowedOrigin(origin, 3001), true, origin);
  }
  for (const origin of ["http://127.0.0.1:4000", "http://localhost:8080", "https://127.0.0.1:3001", "http://127.0.0.1:3001.evil.example", "null", "https://evil.example"]) {
    assert.equal(isAllowedOrigin(origin, 3001), false, origin);
  }
  assert.equal(isAllowedOrigin("http://127.0.0.1:3011", 3011), true);
});

test("API and /ws accept non-browser clients but reject other loopback pages", () => {
  assert.equal(isLocalOrigin(undefined), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:3001"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:61234"), false);
  assert.equal(isLocalOrigin("http://localhost:3000"), false);
});

test("content security policy blocks foreign scripts and allows the app socket and Tauri IPC", () => {
  const policy = appContentSecurityPolicy(3001);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /connect-src [^;]*ws:\/\/127\.0\.0\.1:3001/);
  assert.match(policy, /connect-src [^;]*ipc:/);
});
