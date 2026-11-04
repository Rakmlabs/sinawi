#!/usr/bin/env node
// npx @rakmlabs/sinawi        install or update Sinawi.app (macOS) from the latest GitHub release
// npx @rakmlabs/sinawi mcp    the stdio MCP bridge to a running Sinawi app
import { readFileSync } from "node:fs";
import { HELP, install, parseArgs } from "../lib/install.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  process.stderr.write(`sinawi: ${args.error}\n\n${HELP}\n`);
  process.exit(2);
}
if (args.command === "mcp") {
  // stdout belongs to the MCP client from here on.
  await import("../lib/mcp.mjs");
} else if (args.command === "help") {
  process.stdout.write(`${HELP}\n`);
} else if (args.command === "version") {
  process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}\n`);
} else {
  try {
    const result = await install(args);
    if (result.status === "cancelled") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`sinawi: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
