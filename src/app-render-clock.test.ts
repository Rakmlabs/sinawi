import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The 1 s clock must live in leaf components (Elapsed, banners), never in the app containers.
test("app containers do not own a ticking clock", () => {
  for (const path of ["./main.tsx", "./app/App.tsx", "./app/WorkspaceApp.tsx", "./app/MessageList.tsx", "./app/Composer.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /setInterval|useNow\(|setNow\(/, path);
  }
  const sockets = readFileSync(new URL("./app/useAppSocket.ts", import.meta.url), "utf8");
  assert.match(sockets, /reconnectDelay\(attempt\+\+\)/);
  assert.match(sockets, /attempt = 0/);
  assert.match(sockets, /parseServerMessage\(event\.data\)/);
  const notifications = readFileSync(new URL("./NotificationsCenter.tsx", import.meta.url), "utf8");
  assert.match(notifications, /if \(connected\) \{/);
});
