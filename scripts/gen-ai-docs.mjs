// Rewrites the tool tables in docs/ai/for-ai.md and docs/ai/for-ai.ko.md from server/app-tools.ts.
// Only the part between <!-- tools:start --> and <!-- tools:end --> changes.
//
//   npm run docs:ai            write the docs
//   npm run docs:ai -- --check exit 1 if a doc is out of date
//
// Runs under tsx (`node --import tsx`) because the registry is TypeScript.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectedAiDocs } from "../server/ai-docs.ts";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const check = process.argv.includes("--check");
let stale = 0;
for (const doc of await expectedAiDocs(root)) {
  if (doc.current === doc.expected) { console.log(`up to date: ${doc.path.slice(root.length + 1)}`); continue; }
  if (check) { stale += 1; console.error(`out of date: ${doc.path.slice(root.length + 1)} (run npm run docs:ai)`); continue; }
  await writeFile(doc.path, doc.expected);
  console.log(`updated: ${doc.path.slice(root.length + 1)}`);
}
if (stale) process.exitCode = 1;
