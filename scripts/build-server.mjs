import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// All runtime dependencies are included; the installed app only needs Node.
const resources = new URL("../src-tauri/resources/", import.meta.url);
await mkdir(resources, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../server/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("server.cjs", resources)),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ws uses these optional native addons only as performance accelerators.
  external: ["bufferutil", "utf-8-validate", "node-pty"],
});
await rm(new URL("dist/", resources), { recursive: true, force: true });
await cp(new URL("../dist/", import.meta.url), new URL("dist/", resources), { recursive: true });
const nodePtySource = new URL("../node_modules/node-pty/", import.meta.url);
const nodePtyTarget = new URL("node_modules/node-pty/", resources);
await rm(nodePtyTarget, { recursive: true, force: true });
await mkdir(nodePtyTarget, { recursive: true });
await Promise.all([
  cp(new URL("package.json", nodePtySource), new URL("package.json", nodePtyTarget)),
  cp(new URL("lib/", nodePtySource), new URL("lib/", nodePtyTarget), { recursive: true }),
  cp(new URL("prebuilds/darwin-arm64/", nodePtySource), new URL("prebuilds/darwin-arm64/", nodePtyTarget), { recursive: true }),
  cp(new URL("prebuilds/darwin-x64/", nodePtySource), new URL("prebuilds/darwin-x64/", nodePtyTarget), { recursive: true }),
]);
await Promise.all([
  chmod(new URL("prebuilds/darwin-arm64/spawn-helper", nodePtyTarget), 0o755),
  chmod(new URL("prebuilds/darwin-x64/spawn-helper", nodePtyTarget), 0o755),
]);
// Notarization rejects unsigned Mach-O files anywhere in the bundle, and Tauri signs only the app's
// own binaries, so a Developer ID build signs node-pty's prebuilds here, before they are bundled.
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (identity && process.platform === "darwin") {
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    for (const file of ["pty.node", "spawn-helper"]) {
      execFileSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, fileURLToPath(new URL(`prebuilds/${arch}/${file}`, nodePtyTarget))], { stdio: "inherit" });
    }
  }
}
const erudaTarget = new URL("node_modules/eruda/", resources);
await mkdir(erudaTarget, { recursive: true });
await cp(new URL("../node_modules/eruda/package.json", import.meta.url), new URL("package.json", erudaTarget));
await cp(new URL("../node_modules/eruda/eruda.js", import.meta.url), new URL("eruda.js", erudaTarget));
const h2iTarget = new URL("node_modules/html-to-image/", resources);
await rm(h2iTarget, { recursive: true, force: true });
await mkdir(new URL("dist/", h2iTarget), { recursive: true });
await cp(new URL("../node_modules/html-to-image/package.json", import.meta.url), new URL("package.json", h2iTarget));
await cp(new URL("../node_modules/html-to-image/dist/html-to-image.js", import.meta.url), new URL("dist/html-to-image.js", h2iTarget));
console.log("Desktop resources ready: server.cjs + dist/ + node-pty");
