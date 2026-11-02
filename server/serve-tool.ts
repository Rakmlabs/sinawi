import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { computerDir, resolveComputerDir, resolveComputerToken } from "./computer-tokens.js";
import type { DevServerManager, DevServerView } from "./dev-servers.js";

/** `ao-serve`: agents ask the app to run their dev servers (see dev-servers.ts). */
export const SERVE_OPS = ["start", "list", "logs", "stop"] as const;
type ServeOp = (typeof SERVE_OPS)[number];
type ServeOut = { ok: boolean; error?: string; result?: unknown };

const TOKEN_MESSAGE = "ao-serve는 Sinawi가 실행한 세션 안에서만 쓸 수 있습니다 (SINAWI_COMPUTER_TOKEN).";

const brief = (server: DevServerView) => ({ name: server.name, alive: server.alive, port: server.port, command: server.command, cwd: server.cwd, log: server.log, startedAt: server.startedAt });

export async function handleServe(manager: DevServerManager, op: string, body: Record<string, unknown>): Promise<ServeOut> {
  if (!(SERVE_OPS as readonly string[]).includes(op)) return { ok: false, error: `알 수 없는 명령: ${op}` };
  const run = resolveComputerToken(body.token);
  if (!run) return { ok: false, error: TOKEN_MESSAGE };
  const name = typeof body.name === "string" ? body.name : "";
  switch (op as ServeOp) {
    case "start": {
      const port = Number(body.port);
      const result = await manager.start(run.sessionId, {
        name,
        command: typeof body.command === "string" ? body.command : "",
        cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd(),
        port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined,
        restart: body.restart === true,
      });
      if (!result.ok) return { ok: false, error: result.tail ? `${result.error}\n--- 로그 ---\n${result.tail}` : result.error };
      return { ok: true, result: { ...brief(result.server), reused: result.reused, ready: result.ready, tail: result.tail } };
    }
    case "list": return { ok: true, result: manager.list(run.sessionId).map(brief) };
    case "logs": {
      const text = await manager.logs(run.sessionId, name, Number(body.lines) || 80);
      return text === undefined ? { ok: false, error: `이 세션에 '${name}' 서버가 없습니다. ao-serve list로 확인하세요.` } : { ok: true, result: text };
    }
    case "stop": return (await manager.stop(run.sessionId, name)) ? { ok: true, result: `${name} 서버를 멈췄습니다.` } : { ok: false, error: `이 세션에 '${name}' 서버가 없습니다.` };
  }
}

export function registerServeRoutes(app: Express, manager: DevServerManager) {
  app.post("/api/serve/:op", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const out = await handleServe(manager, String(req.params.op), body).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    res.status(out.ok ? 200 : 422).json(out);
  });
}

export const serveQueueDir = () => join(computerDir(), "serve");

/** File-queue fallback for sandboxes without loopback network (Codex workspace-write). */
export function watchServeQueue(manager: DevServerManager, dir = serveQueueDir(), intervalMs = 150) {
  const busy = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (stopped) return;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".req.json") || busy.has(name)) continue;
        busy.add(name);
        const base = name.slice(0, -".req.json".length);
        void (async () => {
          let out: ServeOut;
          try {
            const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>;
            await rm(join(dir, name), { force: true });
            out = await handleServe(manager, String(raw.op), raw);
          } catch (error) { out = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          await writeFile(join(dir, `${base}.res.tmp`), JSON.stringify(out));
          await rename(join(dir, `${base}.res.tmp`), join(dir, `${base}.res.json`));
        })().catch((error) => console.error("ao-serve 응답 저장 실패:", error instanceof Error ? error.message : error)).finally(() => busy.delete(name));
      }
    } catch { /* ignore */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

/** Parses `start <name> [--port N] [--restart] [--] <command...>`, `list`, `logs <name> [--lines N]`, `stop <name>`. */
export function parseServeArgv(argv: string[]): { op?: string; body: Record<string, unknown>; error?: string } {
  const [op, ...rest] = argv;
  if (!op) return { body: {}, error: "명령이 필요합니다" };
  if (op === "list") return { op, body: {} };
  if (op === "stop") return rest[0] ? { op, body: { name: rest[0] } } : { body: {}, error: "서버 이름이 필요합니다" };
  if (op === "logs") {
    const lines = rest.indexOf("--lines");
    return rest[0] ? { op, body: { name: rest[0], lines: lines >= 0 ? Number(rest[lines + 1]) : undefined } } : { body: {}, error: "서버 이름이 필요합니다" };
  }
  if (op !== "start") return { body: {}, error: `알 수 없는 명령: ${op}` };
  const [name, ...tailArgs] = rest;
  if (!name) return { body: {}, error: "서버 이름이 필요합니다" };
  const body: Record<string, unknown> = { name };
  const words: string[] = [];
  for (let index = 0; index < tailArgs.length; index++) {
    const arg = tailArgs[index];
    if (arg === "--") { words.push(...tailArgs.slice(index + 1)); break; }
    if (arg === "--port") { body.port = Number(tailArgs[++index]); continue; }
    if (arg === "--restart") { body.restart = true; continue; }
    words.push(...tailArgs.slice(index));
    break;
  }
  if (!words.length) return { body: {}, error: "실행할 명령이 필요합니다 (-- 뒤에)" };
  body.command = words.length === 1 ? words[0] : words.map((word) => /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`).join(" ");
  return { op, body };
}

const USAGE = `사용법: ao-serve <명령>   (개발 서버는 Sinawi가 띄우고 관리합니다. 워커가 끝나도 살아 있고, 세션을 지우면 멈춥니다)
  start <이름> [--port N] [--restart] -- <명령...>   서버 실행. --port를 주면 열릴 때까지 기다림 (같은 이름이 살아 있으면 그대로 재사용)
  list                                              이 세션의 서버 목록
  logs <이름> [--lines N]                           최근 로그
  stop <이름>                                       서버 멈춤
예: ao-serve start web --port 5173 -- npx pnpm@10.19.0 dev:web`;

export const SERVE_CLI_SOURCE = `#!/usr/bin/env node
// ao-serve — 개발 서버를 Sinawi가 띄우고 관리합니다. (자동 생성 파일)
const fs = require("fs"), path = require("path"), os = require("os");
const port = process.env.SINAWI_PORT || process.env.AGENT_ORCHESTRA_PORT || "3001";
const usage = ${JSON.stringify(USAGE)};
const __name = (fn) => fn;
const parse = ${parseServeArgv.toString()};
const resolveDir = ${resolveComputerDir.toString()};
const userTmp = () => { try { return require("child_process").execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2000 }).trim() || undefined; } catch { return undefined; } };
const QUEUE = path.join(resolveDir(process.env, process.platform, process.getuid ? process.getuid() : 0, os.tmpdir(), userTmp), "serve");
async function viaHttp(op, body) {
  const res = await fetch("http://127.0.0.1:" + port + "/api/serve/" + op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
async function viaQueue(op, body) {
  fs.mkdirSync(QUEUE, { recursive: true, mode: 0o700 });
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(path.join(QUEUE, id + ".req.tmp"), JSON.stringify({ op, ...body }));
  fs.renameSync(path.join(QUEUE, id + ".req.tmp"), path.join(QUEUE, id + ".req.json"));
  const res = path.join(QUEUE, id + ".res.json"), req = path.join(QUEUE, id + ".req.json"), start = Date.now();
  while (Date.now() - start < 120000) {
    if (fs.existsSync(res)) { const out = JSON.parse(fs.readFileSync(res, "utf8")); fs.rmSync(res, { force: true }); return out; }
    if (Date.now() - start > 4000 && fs.existsSync(req)) { fs.rmSync(req, { force: true }); return { ok: false, error: "Sinawi 서버가 실행 중이 아닙니다." }; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, error: "응답 시간 초과" };
}
(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { console.log(usage); process.exit(argv.length ? 0 : 2); }
  const parsed = parse(argv);
  if (parsed.error || !parsed.op) { console.error((parsed.error || "명령이 필요합니다") + "\\n\\n" + usage); process.exit(2); }
  const token = process.env.SINAWI_COMPUTER_TOKEN || "";
  if (!token) { console.error("오류: ${TOKEN_MESSAGE}"); process.exit(1); }
  const body = { ...parsed.body, token, cwd: process.cwd() };
  let out;
  try { out = await viaHttp(parsed.op, body); }
  catch { try { out = await viaQueue(parsed.op, body); } catch (e) { out = { ok: false, error: String(e.message || e) }; } }
  if (!out || !out.ok) { console.error("오류: " + ((out && out.error) || "실패")); process.exit(1); }
  const r = out.result;
  console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2));
})();
`;

/** Installs `ao-serve` next to ao-browser and ao-computer (~/.local/bin). */
export async function installServeTooling(home = homedir()) {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const target = join(bin, "ao-serve");
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== SERVE_CLI_SOURCE) { await writeFile(target, SERVE_CLI_SOURCE); await chmod(target, 0o755); }
}
