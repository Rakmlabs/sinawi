import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import test from "node:test";
import { computerDir } from "./computer-tokens.js";
import { QUEUE_DIR } from "./browser-bridge.js";
import { dataDirFor } from "./runtime.js";

// PR #8 review P8-2: `npm test` loads server/test-guard.ts first, so no test reaches the owner's app,
// its queues or its data. This file fails when run without it.
test("tests run with every app path in a temporary folder and port 3001 closed to them", async () => {
  const root = process.env.SINAWI_TEST_GUARD;
  assert.ok(root, "npm test loads server/test-guard.ts");
  for (const path of [tmpdir(), homedir(), QUEUE_DIR, computerDir(), dataDirFor()]) assert.ok(path.startsWith(root), path);
  // A child given its own env, without these, still gets them.
  const child = execFileSync(process.execPath, ["-e", "process.stdout.write([process.env.TMPDIR, process.env.SINAWI_COMPUTER_DIR, process.env.HOME, process.env.SINAWI_PORT].join('\\n'))"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  const [childTmp, childComputer, childHome, childPort] = child.split("\n");
  for (const path of [childTmp!, childComputer!, childHome!]) assert.ok(path.startsWith(root), path);
  assert.equal(childPort, "9", "a CLI without a port dials nothing");
  assert.throws(() => execFileSync(process.execPath, ["-e", "1"], { env: { ...process.env, SINAWI_PORT: "3001" } }), /port 3001/u);
  assert.throws(() => request({ host: "127.0.0.1", port: 3001 }).end(), /port 3001/u);
});
