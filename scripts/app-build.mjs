#!/usr/bin/env node
// Wraps `tauri build`.  When TAURI_SIGNING_PRIVATE_KEY is not set, disables
// updater-artifact creation so a local build succeeds without a signing key.
// When the key IS set the build runs as-is — identical to `tauri build`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "node_modules", ".bin", "tauri");
const args = ["build"];

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log(
    "TAURI_SIGNING_PRIVATE_KEY not set — building without updater artifacts " +
    "(bundle.createUpdaterArtifacts disabled)."
  );
  args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

const child = spawn(tauri, args, { stdio: "inherit" });
child.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
child.on("close", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
