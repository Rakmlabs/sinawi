import { createServer } from "./server.js";
import { accessSync } from "node:fs";
import { resolve } from "node:path";
import { envVar, runtimeOptions } from "./runtime.js";
import { installBrowserTooling } from "./browser-bridge.js";
import { installComputerTooling } from "./computer-bridge.js";
import { installServeTooling } from "./serve-tool.js";
import { installSimTooling } from "./sim-tool.js";
import { killCliProcessGroups } from "./cli.js";

const port = Number(envVar("PORT") ?? 3001);
const options = runtimeOptions();
if (options.staticDir) accessSync(resolve(options.staticDir, "index.html"));
const { httpServer, websocket, orchestra, terminal, flushSessions } = createServer({ ...options, browserQueue: true, worktrees: true, appMcp: true });
void installBrowserTooling().catch((error) => console.error("ao-browser 설치 실패:", error.message));
void installComputerTooling().catch((error) => console.error("ao-computer 설치 실패:", error.message));
void installServeTooling().catch((error) => console.error("ao-serve 설치 실패:", error.message));
void installSimTooling().catch((error) => console.error("ao-sim 설치 실패:", error.message));

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `포트 ${port}이 이미 사용 중입니다 (port ${port} is already in use).\n` +
      `설치된 Sinawi 앱이 이 포트를 사용 중일 수 있습니다 — the installed Sinawi app may be running on it.\n` +
      `독립 개발 서버를 실행하려면 (to run an isolated dev copy):\n` +
      `  SINAWI_PORT=3011 SINAWI_UI_PORT=5198 SINAWI_DATA_DIR="$(mktemp -d)" npm run dev`
    );
  } else if (error.code === "EPERM") {
    console.error(`127.0.0.1:${port}에서 서버를 열 권한이 없습니다.`);
  } else {
    console.error("Sinawi 서버 시작 실패:", error.message);
  }
  process.exitCode = 1;
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Sinawi API: http://127.0.0.1:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  terminal.close();

  for (const session of orchestra.list()) {
    if (session.status === "running") orchestra.stop(session.id);
  }
  // Runs not tied to a session controller (live status answers) still own process groups.
  killCliProcessGroups("SIGTERM");
  for (const client of websocket.clients) client.close(1001, "서버를 종료합니다");

  let finishing = false;
  const finish = () => {
    if (finishing) return;
    finishing = true;
    // Let child-process close handlers and their bounded kill timers finish,
    // then write any session changes still waiting in the coalesced saver.
    httpServer.close(() => {
      flushSessions().then(() => { process.exitCode = 0; }, (error) => {
        console.error("세션 저장 실패:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    });
  };
  const force = setTimeout(() => {
    for (const client of websocket.clients) client.terminate();
    websocket.close();
    finish();
  }, 1_500);
  force.unref();
  websocket.close(() => {
    clearTimeout(force);
    finish();
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.on("unhandledRejection", (reason) => {
  console.error("[sinawi] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[sinawi] uncaughtException:", error);
});
