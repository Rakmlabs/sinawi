import { spawn } from "node:child_process";

const names = ["server", "vite"];
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

for (const [i, child] of children.entries()) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("close", (code, signal) => {
    pending.delete(child);
    if (!closing) {
      const info = signal ? `signal ${signal}` : `exit code ${code ?? "null"}`;
      console.error(`[dev] ${names[i]} stopped (${info})`);
      stop(signal ? 1 : (code ?? 1));
    }
    if (!pending.size) clearTimeout(forceExit);
  });
}
process.on("SIGINT", () => { console.error("[dev] received SIGINT"); stop(); });
process.on("SIGTERM", () => { console.error("[dev] received SIGTERM"); stop(); });
