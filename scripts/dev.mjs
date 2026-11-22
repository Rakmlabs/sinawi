import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

// The app window's key for this run (server/app-key.ts). The server gets it on an inherited pipe (fd 3),
// never in its environment, where `ps -E` would show it; Vite never sees it. The developer gets it as a
// link whose #fragment carries it (src/app-key.ts). Under `tauri dev` (npm run app:dev) the dev window
// collects it like the installed app, from the key socket, checked by the debug binary.
const key = randomBytes(32).toString("base64url");
const underTauri = Boolean(process.env.TAURI_ENV_PLATFORM);
const serverEnv = { ...process.env, SINAWI_APP_KEY_FD: "3", ...(underTauri ? { SINAWI_APP_EXE: resolve("src-tauri/target/debug/sinawi") } : {}) };
delete serverEnv.SINAWI_APP_KEY;

const names = ["server", "vite"];
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { stdio: ["inherit", "inherit", "inherit", "pipe"], env: serverEnv });
server.stdio[3].end(`${key}\n`);
const children = [
  server,
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
if (!underTauri) {
  const page = `http://127.0.0.1:${process.env.SINAWI_UI_PORT || 5188}/#sinawi-app-key=${key}`;
  // Printed once, for the developer: anyone who can read this terminal can act as the app window.
  setTimeout(() => console.log(`\n[dev] 앱 창으로 열기 (승인·설정·터미널 포함) / open as the app window:\n      ${page}\n`), 1500);
}
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
