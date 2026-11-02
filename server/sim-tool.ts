import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { computerDir, resolveComputerDir, resolveComputerToken } from "./computer-tokens.js";
import { watchRequestQueue, type ServeOut } from "./serve-tool.js";

/**
 * `ao-sim`: agents drive the iOS Simulator without macOS screen control. Launching, URLs and
 * screenshots go through `simctl`; touches, typing and the accessibility tree go through AXe
 * (https://github.com/cameroncooke/AXe), which injects input into the simulated device itself, so
 * no Simulator window, Screen Recording or Accessibility grant is needed and the user's mouse is
 * never moved. The simulator is a sandboxed device, so this is not gated like computer use.
 */
export const SIM_OPS = ["devices", "screenshot", "launch", "terminate", "openurl", "tap", "swipe", "type", "ui"] as const;
type SimOp = (typeof SIM_OPS)[number];

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const TOKEN_MESSAGE = "ao-sim은 Sinawi가 실행한 세션 안에서만 쓸 수 있습니다 (SINAWI_COMPUTER_TOKEN).";
export const AXE_MISSING = "탭·입력·화면 구조(ui)에는 AXe가 필요한데 이 Mac에 없습니다. 사용자에게 설치를 요청하고 멈추세요: brew install cameroncooke/axe/axe (실행·스크린샷·openurl은 AXe 없이 됩니다)";

export const defaultExec: Exec = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? Number((error as { code?: number }).code) : 127) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === 127 ? error.message : "")) });
  });
});

type Device = { udid: string; name: string; runtime: string };

export async function bootedDevices(exec: Exec): Promise<Device[]> {
  const out = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"], 20_000);
  if (out.code !== 0) throw new Error(`simctl을 실행하지 못했습니다: ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
  const parsed = JSON.parse(out.stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  return Object.entries(parsed.devices).flatMap(([runtime, list]) => list.filter((device) => device.state === "Booted").map((device) => ({ udid: device.udid, name: device.name, runtime: runtime.split(".").pop() ?? runtime })));
}

async function resolveDevice(exec: Exec, wanted: unknown): Promise<Device> {
  const devices = await bootedDevices(exec);
  const name = typeof wanted === "string" ? wanted.trim() : "";
  const device = name ? devices.find((item) => item.udid === name || item.name === name) : devices[0];
  if (!device) throw new Error(name ? `켜진 시뮬레이터 중 '${name}'이 없습니다. ao-sim devices로 확인하세요.` : "켜진 시뮬레이터가 없습니다. xcrun simctl boot \"<기기 이름>\"으로 먼저 켜세요.");
  return device;
}

const num = (value: unknown, label: string) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} 값이 숫자가 아닙니다.`);
  return String(Math.round(n));
};

/** A dev-client app opened with `--initialUrl` loads that bundle directly; `openurl` would stop at iOS's "Open in …?" alert. */
export function metroUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/u.test(text)) return `http://localhost:${text}`;
  if (/^https?:\/\//u.test(text)) return text;
  throw new Error("--metro는 포트(8081)나 http://localhost:8081 형식입니다.");
}

/** The launchd server's PATH may not include Homebrew, so look where brew puts it first. */
export function axeBinary(exists: (path: string) => boolean = existsSync): string {
  return ["/opt/homebrew/bin/axe", "/usr/local/bin/axe"].find(exists) ?? "axe";
}

async function axe(exec: Exec, args: string[], udid: string, timeoutMs = 30_000): Promise<ServeOut> {
  const out = await exec(axeBinary(), [...args, "--udid", udid], timeoutMs);
  if (out.code === 127 || /ENOENT/u.test(out.stderr)) return { ok: false, error: AXE_MISSING };
  if (out.code !== 0) return { ok: false, error: (out.stderr || out.stdout).trim().slice(0, 1500) || `axe ${args[0]} 실패` };
  return { ok: true, result: out.stdout.trim() || `${args[0]} 완료` };
}

export async function handleSim(op: string, body: Record<string, unknown>, options: { exec?: Exec; shotDir?: string; now?: () => number; onLaunch?: (udid: string) => void } = {}): Promise<ServeOut> {
  if (!(SIM_OPS as readonly string[]).includes(op)) return { ok: false, error: `알 수 없는 명령: ${op}` };
  if (!resolveComputerToken(body.token)) return { ok: false, error: TOKEN_MESSAGE };
  const exec = options.exec ?? defaultExec;
  try {
    if (op === "devices") return { ok: true, result: await bootedDevices(exec) };
    const device = await resolveDevice(exec, body.device);
    const simctl = async (args: string[], timeoutMs = 60_000): Promise<ServeOut> => {
      const out = await exec("xcrun", ["simctl", ...args], timeoutMs);
      return out.code === 0 ? { ok: true, result: out.stdout.trim() || "완료" } : { ok: false, error: (out.stderr || out.stdout).trim().slice(0, 1500) || `simctl ${args[0]} 실패` };
    };
    switch (op as SimOp) {
      case "screenshot": {
        const dir = options.shotDir ?? join(computerDir(), "sim-shots");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = typeof body.out === "string" && body.out ? body.out : join(dir, `sim-${(options.now ?? Date.now)()}.png`);
        const shot = await simctl(["io", device.udid, "screenshot", path], 30_000);
        return shot.ok ? { ok: true, result: { path, device: device.name, hint: "이 파일을 읽어 화면을 확인하세요. 탭 좌표는 ao-sim ui의 frame(포인트) 기준입니다." } } : shot;
      }
      case "launch": {
        const bundle = typeof body.bundle === "string" ? body.bundle.trim() : "";
        if (!bundle) return { ok: false, error: "번들 id가 필요합니다. 예: ao-sim launch com.example.app --metro 8081" };
        const url = metroUrl(body.metro);
        const launched = await simctl(["launch", "--terminate-running-process", device.udid, bundle, ...(url ? ["--initialUrl", url] : [])]);
        // The app opens its simulator panel so the user watches what the agent does.
        if (launched.ok) options.onLaunch?.(device.udid);
        return launched;
      }
      case "terminate": return simctl(["terminate", device.udid, String(body.bundle ?? "")]);
      case "openurl": return simctl(["openurl", device.udid, String(body.url ?? "")]);
      // AXe's own `tap`/`swipe`/`button` report success without reaching the app on some
      // Xcode/runtime pairs (seen on Xcode 27 + iOS 18.6); a held touch and a drag of explicit
      // touch-move events always land, so labels are resolved here and touched by point.
      case "tap": {
        let x = body.x, y = body.y;
        const target = typeof body.label === "string" && body.label ? { label: body.label } : typeof body.id === "string" && body.id ? { id: body.id } : undefined;
        if (target) {
          const tree = await axe(exec, ["describe-ui"], device.udid);
          if (!tree.ok) return tree;
          const found = findElement(String(tree.result), target);
          if ("error" in found) return { ok: false, error: found.error };
          ({ x, y } = found);
        }
        const out = await axe(exec, ["touch", "-x", num(x, "x"), "-y", num(y, "y"), "--down", "--up", "--delay", "0.1"], device.udid);
        return out.ok ? { ok: true, result: `(${num(x, "x")}, ${num(y, "y")}) 탭. 결과는 ao-sim screenshot이나 ui로 확인하세요.` } : out;
      }
      case "swipe": return axe(exec, ["drag", "--start-x", num(body.x1, "x1"), "--start-y", num(body.y1, "y1"), "--end-x", num(body.x2, "x2"), "--end-y", num(body.y2, "y2"), "--duration", "0.5"], device.udid);
      case "type": return axe(exec, ["type", String(body.text ?? "")], device.udid);
      case "ui": {
        const out = await axe(exec, ["describe-ui"], device.udid);
        return out.ok && typeof out.result === "string" ? { ok: true, result: compactUi(out.result) } : out;
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, error: `알 수 없는 명령: ${op}` };
}

type UiNode = { role?: string; AXLabel?: string | null; AXValue?: string | null; AXUniqueId?: string | null; frame?: { x: number; y: number; width: number; height: number }; children?: UiNode[] };

/**
 * AXe's describe-ui is ~100KB of pretty JSON for one screen; an agent needs what it can see and
 * where to tap. One line per labelled or input element, with the tap point in device points.
 */
export function compactUi(raw: string): string {
  let roots: UiNode[];
  try { roots = JSON.parse(raw) as UiNode[]; } catch { return raw; }
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (node: UiNode) => {
    const role = (node.role ?? "").replace(/^AX/u, "");
    const label = node.AXLabel?.trim();
    const value = node.AXValue?.trim();
    const input = /TextField|TextArea|SearchField/u.test(role);
    if ((label || value || input) && node.frame && role !== "Application") {
      const { x, y, width, height } = node.frame;
      const line = `${role}${label ? ` "${label}"` : ""}${value ? ` 값="${value.slice(0, 80)}"` : ""}${node.AXUniqueId ? ` id=${node.AXUniqueId}` : ""} 탭 ${Math.round(x + width / 2)} ${Math.round(y + height / 2)}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
    for (const child of node.children ?? []) walk(child);
  };
  roots.forEach(walk);
  const app = roots.find((node) => node.role === "AXApplication");
  const size = app?.frame ? `화면 ${Math.round(app.frame.width)}×${Math.round(app.frame.height)}pt` : "";
  return [`${app?.AXLabel ?? "앱"} ${size}`.trim(), ...(lines.length ? lines : ["(라벨 있는 요소 없음. ao-sim screenshot으로 보고 좌표로 탭하세요)"])].join("\n");
}

/** The tap point of the one element whose label (or accessibility id) matches exactly. */
export function findElement(raw: string, target: { label?: string; id?: string }): { x: number; y: number } | { error: string } {
  let roots: UiNode[];
  try { roots = JSON.parse(raw) as UiNode[]; } catch { return { error: "화면 구조를 읽지 못했습니다. 좌표로 탭하세요." }; }
  const points = new Map<string, { x: number; y: number }>();
  const walk = (node: UiNode) => {
    const hit = target.id ? node.AXUniqueId === target.id : node.AXLabel?.trim() === target.label?.trim();
    if (hit && node.frame && node.role !== "AXApplication") {
      const point = { x: Math.round(node.frame.x + node.frame.width / 2), y: Math.round(node.frame.y + node.frame.height / 2) };
      points.set(`${point.x},${point.y}`, point);
    }
    for (const child of node.children ?? []) walk(child);
  };
  roots.forEach(walk);
  const what = target.id ? `id '${target.id}'` : `라벨 '${target.label}'`;
  if (!points.size) return { error: `${what} 요소가 화면에 없습니다. ao-sim ui로 지금 화면의 라벨을 확인하세요.` };
  if (points.size > 1) return { error: `${what} 요소가 ${points.size}개입니다: ${[...points.values()].map((p) => `(${p.x}, ${p.y})`).join(", ")}. 좌표로 탭하세요.` };
  return [...points.values()][0];
}

export function registerSimRoutes(app: Express, options: Parameters<typeof handleSim>[2] = {}) {
  app.post("/api/sim/:op", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const out = await handleSim(String(req.params.op), body, options).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    res.status(out.ok ? 200 : 422).json(out);
  });
}

export const simQueueDir = () => join(computerDir(), "sim");

export function watchSimQueue(options: Parameters<typeof handleSim>[2] = {}, dir = simQueueDir()) {
  return watchRequestQueue(dir, (raw) => handleSim(String(raw.op), raw, options), "ao-sim");
}

/** Parses the ao-sim command line into an op and its request body. */
export function parseSimArgv(argv: string[]): { op?: string; body: Record<string, unknown>; error?: string } {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--") && arg.length > 2) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[arg.slice(2)] = next; index++; } else flags[arg.slice(2)] = true;
    } else pos.push(arg);
  }
  const [op, ...rest] = pos;
  if (!op) return { body: {}, error: "명령이 필요합니다" };
  const body: Record<string, unknown> = {};
  if (typeof flags.device === "string") body.device = flags.device;
  switch (op) {
    case "devices": case "ui": break;
    case "screenshot": if (typeof flags.out === "string") body.out = flags.out; break;
    case "launch":
      if (!rest[0]) return { body: {}, error: "번들 id가 필요합니다" };
      body.bundle = rest[0];
      if (typeof flags.metro === "string") body.metro = flags.metro;
      break;
    case "terminate": if (!rest[0]) return { body: {}, error: "번들 id가 필요합니다" }; body.bundle = rest[0]; break;
    case "openurl": if (!rest[0]) return { body: {}, error: "URL이 필요합니다" }; body.url = rest[0]; break;
    case "tap":
      if (typeof flags.label === "string") body.label = flags.label;
      else if (typeof flags.id === "string") body.id = flags.id;
      else if (rest.length >= 2) { body.x = Number(rest[0]); body.y = Number(rest[1]); }
      else return { body: {}, error: "좌표(x y)나 --label <텍스트>가 필요합니다" };
      break;
    case "swipe":
      if (rest.length < 4) return { body: {}, error: "x1 y1 x2 y2가 필요합니다" };
      [body.x1, body.y1, body.x2, body.y2] = rest.slice(0, 4).map(Number);
      break;
    case "type": if (!rest.length) return { body: {}, error: "입력할 텍스트가 필요합니다" }; body.text = rest.join(" "); break;
    default: return { body: {}, error: `알 수 없는 명령: ${op}` };
  }
  return { op, body };
}

const USAGE = `사용법: ao-sim <명령> [--device <이름|UDID>]   (iOS 시뮬레이터 조작. 화면 조작 허용 없이 됩니다)
  devices                                켜진 시뮬레이터
  launch <번들 id> [--metro 8081]       앱 실행. --metro를 주면 개발 빌드가 확인 창 없이 Metro에 바로 연결
  terminate <번들 id> / openurl <URL>
  screenshot [--out <경로>]              화면 PNG (경로를 출력, 파일을 읽어서 확인)
  ui                                     화면 요소 트리(라벨·frame, 포인트 단위)
  tap <x> <y> | tap --label <텍스트>     탭 (좌표는 포인트)
  swipe <x1> <y1> <x2> <y2>              스와이프·스크롤
  type <텍스트>                          포커스된 입력칸에 입력 (비밀번호는 입력하지 않는다)
예: ao-sim launch com.example.app --metro 8081 && ao-sim screenshot`;

export const SIM_CLI_SOURCE = `#!/usr/bin/env node
// ao-sim — iOS 시뮬레이터 조작. (자동 생성 파일)
const fs = require("fs"), path = require("path"), os = require("os");
const port = process.env.SINAWI_PORT || process.env.AGENT_ORCHESTRA_PORT || "3001";
const usage = ${JSON.stringify(USAGE)};
const __name = (fn) => fn;
const parse = ${parseSimArgv.toString()};
const resolveDir = ${resolveComputerDir.toString()};
const userTmp = () => { try { return require("child_process").execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2000 }).trim() || undefined; } catch { return undefined; } };
const QUEUE = path.join(resolveDir(process.env, process.platform, process.getuid ? process.getuid() : 0, os.tmpdir(), userTmp), "sim");
async function viaHttp(op, body) {
  const res = await fetch("http://127.0.0.1:" + port + "/api/sim/" + op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 404) throw new Error("no route");
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
    if (Date.now() - start > 4000 && fs.existsSync(req)) { fs.rmSync(req, { force: true }); return { ok: false, error: "Sinawi 서버가 ao-sim을 받지 않습니다. Sinawi를 최신 버전으로 업데이트해야 합니다." }; }
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
  const body = { ...parsed.body, token };
  if (body.out && !path.isAbsolute(body.out)) body.out = path.resolve(body.out);
  let out;
  try { out = await viaHttp(parsed.op, body); }
  catch { try { out = await viaQueue(parsed.op, body); } catch (e) { out = { ok: false, error: String(e.message || e) }; } }
  if (!out || !out.ok) { console.error("오류: " + ((out && out.error) || "실패")); process.exit(1); }
  const r = out.result;
  console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2));
})();
`;

/** Installs `ao-sim` next to the other ao-* tools (~/.local/bin). */
export async function installSimTooling(home = homedir()) {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const target = join(bin, "ao-sim");
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== SIM_CLI_SOURCE) { await writeFile(target, SIM_CLI_SOURCE); await chmod(target, 0o755); }
}
