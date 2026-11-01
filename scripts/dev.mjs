import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
const pending = new Set(children);
let closing = false;
let forceExit;

function stop(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  for (const child of pending) child.kill("SIGTERM");
  forceExit = setTimeout(() => {
    for (const child of pending) child.kill("SIGKILL");
    process.exit(code || 1);
  }, 4000);
  forceExit.unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("close", (code, signal) => {
    pending.delete(child);
    if (!closing) stop(signal ? 1 : (code ?? 1));
    if (!pending.size) clearTimeout(forceExit);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
