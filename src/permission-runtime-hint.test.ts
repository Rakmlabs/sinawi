// H2: an approval card for a command that runs code links to the workspace setting that pre-approves it.
import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeCommand } from "./PermissionPrompts";

test("commands that run code get the link to the workspace setting; others do not", () => {
  for (const detail of ["node -e 1", "Bash(npx tsx a.ts)", "python3 x.py", "npm run build", "pnpm install", "yarn dlx x", "find . -exec rm {} ;", "ao-serve start web -- pnpm dev"]) assert.equal(isRuntimeCommand(detail), true, detail);
  for (const detail of ["git status", "ao-serve list", "rg --files", "nodemon", "finder"]) assert.equal(isRuntimeCommand(detail), false, detail);
});
