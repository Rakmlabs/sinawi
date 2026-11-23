// H2: an approval card for a command that runs code links to the workspace setting that pre-approves it.
import assert from "node:assert/strict";
import test from "node:test";
import { canSwitchChatToFull, isRuntimeCommand, newChatPermissionMode, permissionAnswerBody } from "./PermissionPrompts";

test("commands that run code get the link to the workspace setting; others do not", () => {
  for (const detail of ["node -e 1", "Bash(npx tsx a.ts)", "python3 x.py", "npm run build", "pnpm install", "yarn dlx x", "find . -exec rm {} ;", "ao-serve start web -- pnpm dev"]) assert.equal(isRuntimeCommand(detail), true, detail);
  for (const detail of ["git status", "ao-serve list", "rg --files", "nodemon", "finder"]) assert.equal(isRuntimeCommand(detail), false, detail);
});

test("a new chat starts in full access where the workspace allows it, auto otherwise", () => {
  assert.equal(newChatPermissionMode(true), "full");
  assert.equal(newChatPermissionMode(false), "auto");
});

test("the card offers switching to full access only for an auto chat in a workspace that allows it", () => {
  assert.equal(canSwitchChatToFull(true, "auto"), true);
  assert.equal(canSwitchChatToFull(true, undefined), true, "a chat from before modes runs in auto here");
  assert.equal(canSwitchChatToFull(true, "full"), false);
  assert.equal(canSwitchChatToFull(true, "plan"), false, "plan mode is never lifted from a card");
  assert.equal(canSwitchChatToFull(false, "auto"), false);
});

test("the card's answers: allow, deny, and allow plus full access", () => {
  assert.deepEqual(permissionAnswerBody("allow"), { allow: true });
  assert.deepEqual(permissionAnswerBody("deny"), { allow: false });
  assert.deepEqual(permissionAnswerBody("full"), { allow: true, fullAccess: true });
});
