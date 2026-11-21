import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// The app window's key for this run (server/app-key.ts): the server checks it, Vite puts it in the page.
const env = { ...process.env, SINAWI_APP_KEY: randomBytes(32).toString("base64url") };

const names = ["server", "vite"];
const children = [
  spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    stdio: "inherit", env,
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit", env,
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
