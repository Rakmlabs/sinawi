import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, extname, join } from "node:path";
import type { Express } from "express";
import { envVar } from "./runtime.js";
import { resolveComputerToken } from "./computer-tokens.js";

/** Actions an agent may run against the user's visible in-app browser tab. */
export const BROWSER_ACTIONS = ["goto", "snapshot", "click", "type", "fill", "press", "scroll", "wait", "text", "console", "screenshot", "back", "forward", "reload", "tabs", "status", "viewport", "network", "dialog", "upload", "hover", "keyboard", "tab", "select", "downloads"] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export const isBrowserAction = (value: string): value is BrowserAction => (BROWSER_ACTIONS as readonly string[]).includes(value);

/** `workspaceId`: the workspace of the agent run that sent it; the app runs it only in that workspace's browser. */
export type BrowserCommand = { type: "browser-command"; id: string; action: BrowserAction; args: Record<string, unknown>; workspaceId?: string };
export type BrowserResult = { ok: boolean; result?: unknown; error?: string };

export const QUEUE_DIR = join(tmpdir(), "sinawi-browser");

/** True when ao-browser would open the app server itself (nested WebSocket, no picker, then timeout). */
export function isOwnAppUrl(raw: string, appPort = Number(envVar("PORT") || 3001)): boolean {
  const value = String(raw ?? "").trim();
  if (/^\d{2,5}$/.test(value)) return Number(value) === appPort;
  try { const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`); return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") && Number(url.port || 80) === appPort; } catch { return false; }
}

export function defaultTimeout(action: BrowserAction, args: Record<string, unknown>): number {
  const requested = Number(args.timeout);
  const base = action === "goto" || action === "wait" ? 45_000 : action === "screenshot" ? (args.full ? 30_000 : 15_000) : 10_000;
  return Math.min(60_000, Math.max(1_000, Number.isFinite(requested) && requested > 0 ? requested + 3_000 : base));
}

export class BrowserBridge {
  private pending = new Map<string, { resolve: (value: BrowserResult) => void; timer: ReturnType<typeof setTimeout>; pulse?: ReturnType<typeof setInterval> }>();
  private launching?: Promise<boolean>;
  /** launchApp: optional hook that starts the app window when no window is connected (launchd split: server outlives the app). */
  constructor(private send: (command: BrowserCommand) => number, private launchApp?: () => Promise<boolean>, private launchWaitMs = 15_000) {}

  /** Starts the app (once, shared by concurrent callers) and waits until a window connects. */
  private async ensureWindow(probe: () => number): Promise<number> {
    if (!this.launchApp) return 0;
    this.launching ??= this.launchApp().catch(() => false).finally(() => { setTimeout(() => { this.launching = undefined; }, 1_000); });
    if (!(await this.launching)) return 0;
    const deadline = Date.now() + this.launchWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const n = probe();
      if (n) return n;
    }
    return 0;
  }

  request(action: BrowserAction, args: Record<string, unknown> = {}, timeoutMs = defaultTimeout(action, args), workspaceId?: string): Promise<BrowserResult> {
    if ((action === "goto" || (action === "tab" && String(args.op ?? "") === "new")) && isOwnAppUrl(String(args.url ?? ""))) return Promise.resolve({ ok: false, error: "Sinawi 자체 주소는 열 수 없습니다. 개발 서버나 다른 사이트 주소를 여세요." });
    const id = randomUUID();
    return new Promise((resolve) => {
      const command: BrowserCommand = { type: "browser-command", id, action, args, ...(workspaceId ? { workspaceId } : {}) };
      const finish = (result: BrowserResult) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer); if (entry.pulse) clearInterval(entry.pulse); this.pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `앱 브라우저가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다. 앱 창이 최소화됐거나 화면이 잠겨 있으면 응답하지 못합니다.` }), timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(value), timer });
      const fail = () => finish({ ok: false, error: "Sinawi 앱 창이 열려 있지 않습니다. 앱을 실행한 뒤 다시 시도하세요." });
      const replay = action === "viewport" || action === "status" || action === "tabs";
      const pulse = () => { if (!replay) return; const entry = this.pending.get(id); if (entry && !entry.pulse) entry.pulse = setInterval(() => { if (this.pending.has(id)) this.send(command); }, 400); };
      if (this.send(command)) { pulse(); return; }
      if (!this.launchApp) { fail(); return; }
      // Window not connected: launch the app and retry instead of failing immediately.
      clearTimeout(timer);
      void this.ensureWindow(() => this.send(command)).then((n) => {
        if (!n) { fail(); return; }
        const entry = this.pending.get(id);
        if (!entry) return;
        entry.timer = setTimeout(() => finish({ ok: false, error: `앱 브라우저가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다.` }), timeoutMs);
        pulse();
      }, fail); // a failed app launch must answer the request, not leave it pending with no timer
    });
  }

  resolve(id: string, result: BrowserResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.resolve({ ok: Boolean(result.ok), result: result.result, error: result.error ? String(result.error) : undefined });
    return true;
  }

  get size() { return this.pending.size; }
}

/** Screenshots arrive as data URLs; agents get a file path instead. */
export async function materialize(result: BrowserResult, dir = QUEUE_DIR): Promise<BrowserResult> {
  const value = result.result as { image?: string } | undefined;
  if (!result.ok || !value || typeof value.image !== "string" || !value.image.startsWith("data:image/png;base64,")) return result;
  await mkdir(dir, { recursive: true });
  const path = join(dir, `shot-${Date.now()}-${randomUUID().slice(0, 6)}.png`);
  await writeFile(path, Buffer.from(value.image.slice("data:image/png;base64,".length), "base64"));
  const { image: _image, ...rest } = value as Record<string, unknown>;
  return { ok: true, result: { ...rest, path } };
}

const UPLOAD_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json", ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mp4": "video/mp4", ".zip": "application/zip",
};

/** Reads an upload path on the server. The page cannot see the user's disk. */
export async function prepareBrowserArgs(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action !== "upload") return args;
  const filePath = String(args.path ?? "").trim();
  if (!filePath) throw new Error("파일 경로가 필요합니다. 예: ao-browser upload e3 /절대/경로.png");
  let info;
  try { info = await stat(filePath); } catch { throw new Error(`파일을 찾을 수 없습니다: ${filePath}`); }
  if (!info.isFile()) throw new Error(`파일이 아닙니다: ${filePath}`);
  if (info.size > 20 * 1024 * 1024) throw new Error(`파일이 20MB를 넘습니다: ${filePath}`);
  const data = await readFile(filePath);
  const name = basename(filePath);
  return { ...args, file: { name, type: UPLOAD_MIME[extname(name).toLowerCase()] ?? "application/octet-stream", base64: data.toString("base64"), size: data.length } };
}

export function registerBrowserRoutes(app: Express, bridge: BrowserBridge) {
  app.post("/api/browser/result", (req, res) => {
    const id = String(req.body?.id ?? "");
    res.json({ ok: bridge.resolve(id, { ok: Boolean(req.body?.ok), result: req.body?.result, error: req.body?.error }) });
  });
  app.post("/api/browser/:action", async (req, res) => {
    const action = String(req.params.action);
    if (!isBrowserAction(action)) { res.status(404).json({ ok: false, error: `알 수 없는 브라우저 명령: ${action}` }); return; }
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    let args: Record<string, unknown>;
    try { args = await prepareBrowserArgs(action, body); } catch (error) { res.status(422).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); return; }
    const result = await materialize(await bridge.request(action, args, undefined, resolveComputerToken(req.get("x-sinawi-token"))?.workspaceId));
    res.status(result.ok ? 200 : 422).json(result);
  });
}

/** File-queue fallback for sandboxes without loopback network (Codex workspace-write). */
export function watchQueue(bridge: BrowserBridge, dir = QUEUE_DIR, intervalMs = 150) {
  const busy = new Set<string>();
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await mkdir(dir, { recursive: true });
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".req.json") || busy.has(name)) continue;
        busy.add(name);
        const base = name.slice(0, -".req.json".length);
        void (async () => {
          let out: BrowserResult;
          try {
            const raw = JSON.parse(await readFile(join(dir, name), "utf8"));
            await rm(join(dir, name), { force: true });
            const action = String(raw.action);
            const args = isBrowserAction(action) ? await prepareBrowserArgs(action, raw.args ?? {}) : {};
            out = isBrowserAction(action) ? await materialize(await bridge.request(action, args, undefined, resolveComputerToken(raw.token)?.workspaceId), dir) : { ok: false, error: `알 수 없는 브라우저 명령: ${action}` };
          } catch (error) { out = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          await writeFile(join(dir, `${base}.res.tmp`), JSON.stringify(out));
          const { rename } = await import("node:fs/promises");
          await rename(join(dir, `${base}.res.tmp`), join(dir, `${base}.res.json`));
        })().catch((error) => {
          // The queue dir can vanish (tmp cleanup) between request and response; never crash the server.
          console.error("ao-browser 응답 저장 실패:", error instanceof Error ? error.message : error);
        }).finally(() => busy.delete(name));
      }
    } catch { /* ignore */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

export const CLI_SOURCE = String.raw`#!/usr/bin/env node
// ao-browser — Sinawi 앱 안 브라우저 탭을 조작합니다. (자동 생성 파일)
const fs = require("fs"), path = require("path"), os = require("os");
const port = process.env.SINAWI_PORT || process.env.AGENT_ORCHESTRA_PORT || "3001";
const QUEUE = path.join(os.tmpdir(), "sinawi-browser");
const QUEUES = [...new Set([QUEUE, "/tmp/sinawi-browser", path.join(process.env.TMPDIR || "/tmp", "sinawi-browser")])];
const usage = "사용법: ao-browser <명령> [인자]\n" +
  "  goto <url|포트>               페이지 열기 (https 외부 사이트도 가능, 탭이 없으면 패널을 염). 로딩과 네트워크 idle을 기다림\n" +
  "  snapshot                      ref가 붙은 접근성 트리\n" +
  "  click <ref|selector> [--trusted]  클릭. 바뀐 snapshot을 돌려줌 (--trusted: 실제 마우스 이벤트, isTrusted=true)\n" +
  "  fill <ref|selector> <텍스트>  입력칸 값 바꾸기 (type은 이어서 타이핑)\n" +
  "  press <키> [ref]              예: Enter, Tab, Escape, Control+A\n" +
  "  keyboard <키|글자> [ref]      키 조합 또는 글자 입력\n" +
  "  hover <ref|selector>          가리키기\n" +
  "  select <ref|selector> <값>    드롭다운 선택\n" +
  "  scroll <up|down|top|bottom|ref> [px]\n" +
  "  upload <ref|selector> <파일>  파일 입력\n" +
  "  dialog [accept|dismiss] [문구]\n" +
  "  wait <selector|text:문구|idle> [ms]\n" +
  "  text [ref|selector]           보이는 텍스트\n" +
  "  console                       콘솔 오류/경고와 네트워크 오류\n" +
  "  network [all]                 네트워크 오류 (all은 최근 요청)\n" +
  "  screenshot [ref] [--full]     뷰포트 또는 요소 PNG (--full: 페이지 전체, 최대 16000px)\n" +
  "  downloads [cancel <id>]       다운로드 목록·진행률 (~/Downloads)\n" +
  "  viewport <iphone|tablet|desktop|WxH>\n" +
  "  tab <new|select|close> [url|번호]\n" +
  "  back | forward | reload | tabs | status";
function parse(argv) {
  const flags = { full: argv.includes("--full"), trusted: argv.includes("--trusted") };
  const [action, ...rest] = argv.filter((v) => v !== "--full" && v !== "--trusted");
  const out = parseAction(action, rest);
  if (out[0] === "screenshot" && flags.full) out[1].full = true;
  if (flags.trusted && ["click", "fill", "type", "press"].includes(out[0])) out[1].trusted = true;
  return out;
}
function parseAction(action, rest) {
  const target = (v) => (v && /^e\d+$/.test(v) ? { ref: v } : v ? { selector: v } : {});
  switch (action) {
    case "goto": case "open": case "navigate": return ["goto", { url: rest[0] }];
    case "click": return ["click", target(rest[0])];
    case "type": case "fill": return [action, { ...target(rest[0]), text: rest.slice(1).join(" ") }];
    case "press": return ["press", { key: rest[0], ...target(rest[1]) }];
    case "keyboard": return rest.length >= 2 ? ["keyboard", { ...target(rest[0]), key: rest.slice(1).join(" ") }] : ["keyboard", { key: rest[0] || "" }];
    case "hover": return ["hover", target(rest[0])];
    case "select": return ["select", { ...target(rest[0]), value: rest.slice(1).join(" ") }];
    case "upload": return ["upload", { ...target(rest[0]), path: rest.slice(1).join(" ") }];
    case "dialog": {
      const op = (rest[0] || "").toLowerCase();
      if (!op) return ["dialog", {}];
      if (op === "accept" || op === "ok") return ["dialog", { accept: true, promptText: rest.slice(1).join(" ") }];
      if (op === "dismiss" || op === "cancel") return ["dialog", { accept: false }];
      return ["dialog", { invalid: rest[0] }];
    }
    case "scroll": {
      const dir = /^(up|down|top|bottom)$/;
      if (!rest[0] || dir.test(rest[0])) return ["scroll", { direction: rest[0] || "down", amount: Number(rest[1]) || undefined }];
      const tgt = target(rest[0]);
      if (rest[1] && dir.test(rest[1])) return ["scroll", { ...tgt, direction: rest[1], amount: Number(rest[2]) || undefined }];
      return ["scroll", tgt];
    }
    case "wait": {
      const v = rest[0] || "";
      if (v === "idle" || v === "network") return ["wait", { idle: true, timeout: Number(rest[1]) || undefined }];
      return ["wait", { ...(v.startsWith("text:") ? { text: v.slice(5) } : { selector: v }), timeout: Number(rest[1]) || undefined }];
    }
    case "text": case "screenshot": case "shot": return [action === "shot" ? "screenshot" : action, target(rest[0])];
    case "network": return ["network", { all: rest[0] === "all" }];
    case "viewport": case "device": return ["viewport", { preset: rest.join("") }];
    case "tab": {
      const op = (rest[0] || "list").toLowerCase();
      if (op === "new") return ["tab", { op: "new", url: rest.slice(1).join(" ") }];
      if (op === "select" || op === "close") return ["tab", { op, index: Number(rest[1]) }];
      return ["tabs", {}];
    }
    case "downloads": case "download": return ["downloads", rest[0] === "cancel" && rest[1] ? { cancel: rest[1] } : {}];
    case "snapshot": case "console": case "back": case "forward": case "reload": case "tabs": case "status": return [action, {}];
    default: return [undefined, {}];
  }
}
async function viaHttp(action, args) {
  const res = await fetch("http://127.0.0.1:" + port + "/api/browser/" + action, { method: "POST", headers: { "content-type": "application/json", "x-sinawi-token": process.env.SINAWI_COMPUTER_TOKEN || "" }, body: JSON.stringify(args) });
  return res.json();
}
async function viaQueue(action, args) {
  const dir = QUEUES.find((d) => { try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } });
  if (!dir) throw new Error("큐 폴더에 쓸 수 없습니다");
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(path.join(dir, id + ".req.tmp"), JSON.stringify({ action, args, token: process.env.SINAWI_COMPUTER_TOKEN || "" }));
  fs.renameSync(path.join(dir, id + ".req.tmp"), path.join(dir, id + ".req.json"));
  const res = path.join(dir, id + ".res.json"), req = path.join(dir, id + ".req.json"), start = Date.now();
  while (Date.now() - start < 75000) {
    if (fs.existsSync(res)) { const out = JSON.parse(fs.readFileSync(res, "utf8")); fs.rmSync(res, { force: true }); return out; }
    if (Date.now() - start > 4000 && fs.existsSync(req)) { fs.rmSync(req, { force: true }); return { ok: false, error: "Sinawi 앱이 실행 중이 아닙니다." }; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, error: "응답 시간 초과" };
}
function print(out) {
  if (!out.ok) { console.error("오류: " + (out.error || "실패")); process.exit(1); }
  const r = out.result;
  if (r && r.path) { console.log(JSON.stringify(r, null, 2)); return; }
  if (r && typeof r.snapshot === "string") {
    const note = [];
    if (r.clicked) note.push("클릭 " + r.clicked);
    if (r.filled) note.push("입력 " + r.filled + (r.value != null ? "=" + JSON.stringify(r.value) : ""));
    if (r.pressed) note.push("키 " + r.pressed);
    if (r.hovered) note.push("가리킴 " + r.hovered);
    if (r.uploaded) note.push("업로드 " + r.uploaded);
    if (r.selected) note.push("선택 " + r.selected);
    if (typeof r.scrollY === "number" && !r.clicked && !r.filled) note.push("스크롤 " + r.scrollY);
    if (r.armed) note.push("대화상자 " + r.armed);
    if (r.note) note.push(String(r.note));
    if (r.networkIdle === false) note.push("네트워크 진행 중" + (r.pending ? " " + r.pending : ""));
    if (note.length) console.log(note.join(" · "));
    console.log(r.snapshot);
    return;
  }
  if (r && typeof r.text === "string" && !r.tabs) { console.log(r.text); return; }
  console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2));
}
(async () => {
  const [action, args] = parse(process.argv.slice(2));
  if (!action) { console.log(usage); process.exit(process.argv[2] ? 2 : 0); }
  let out;
  try { out = await viaHttp(action, args); }
  catch { try { out = await viaQueue(action, args); } catch (e) { out = { ok: false, error: String(e.message || e) }; } }
  print(out);
})();
`;

export const SKILL_MD = `---
name: orchestra-browser
description: Sinawi 앱 안 브라우저 탭(사용자가 보고 있는 화면)을 직접 조작한다. localhost 개발 서버나 외부 https 페이지를 열고, 요소를 클릭/입력하고, 스냅샷·스크린샷·콘솔 오류로 UI 작업 결과를 확인할 때 사용.
---

# orchestra-browser

사용자가 Sinawi 앱 오른쪽 브라우저 패널에서 **같은 탭을 보면서** 네가 조작하는 걸 지켜본다.
명령은 셸에서 \`ao-browser\` (없으면 \`node ~/.local/bin/ao-browser\`) 로 실행한다.

## 핵심 규칙 (먼저 읽기)
- 결과물·목업·디자인 시안·UI 확인은 이 앱 브라우저로만 연다. 외부 Chrome, Playwright, \`open\` 으로 브라우저나 결과 파일을 띄우지 않는다.
- **snapshot 먼저.** goto와 click/fill/press 등은 ref가 붙은 접근성 트리 snapshot을 돌려준다. 거기 나온 ref(e12 등)로만 조작한다. 화면이 바뀌면 다시 snapshot. 증거는 \`ao-browser screenshot e12\`(요소) 또는 \`ao-browser screenshot\`(뷰포트).
- CSS 선택자를 짐작해서 여러 개 연달아 시도하지 않는다. "요소를 찾을 수 없습니다"가 나오면 선택자를 바꾸지 말고 snapshot을 다시 본다. 같은 오류 3번이면 멈추고 막힘으로 보고한다.
- 사용자가 \`orchestra-attachments\`로 보낸 selector는 ref가 아니다. 메모가 요청이고, 소스(file:line)가 고칠 파일이다. snapshot에서 같은 글자를 찾거나, 그 selector를 한 번만 쓴다.
- 데스크톱 앱에서는 http/https 페이지가 모두 조작된다(localhost 개발 서버와 외부 https 사이트). 정적 파일은 \`python3 -m http.server 8765 --directory <상대 경로>\` 로 띄운 뒤 \`ao-browser goto 8765\` 또는 \`ao-browser goto localhost:8765/index.html\`. file:// 는 열지 않는다. 앱 서버 포트(보통 3001)와 이미 쓰이는 포트는 쓰지 않고, 띄운 서버를 kill 하지 않는다.
- "앱 창이 열려 있지 않습니다"면 같은 명령을 한 번만 다시 보낸다. 서버가 앱을 띄우고 최대 15초 기다린다. 그래도 같거나 사용자가 중지했으면 막힘으로 보고한다.
- 속성(data-*, src) 확인이 필요하면 \`ao-browser text\`로 보이는 글자를, 스크린샷으로 화면을 확인하고, 구조는 소스 파일을 읽어 확인한다. screenshot PNG는 임시 폴더라 채팅 뷰어가 열지 못한다. 보여 줄 그림은 작업 폴더에 두고 마크다운 경로로 보고한다.
- 사용법은 \`ao-browser --help\`. Sinawi 소스나 문서를 찾아 읽지 않는다.

## 기본 흐름
1. \`ao-browser goto 5173\` — 포트 번호, http://localhost:... 또는 https://... 주소. 탭이 없으면 패널이 자동으로 열린다.
2. \`ao-browser snapshot\` — 클릭 가능한 요소가 \`[e12] button "저장"\` 처럼 나온다.
3. \`ao-browser click e12\`, \`ao-browser fill e3 "hello"\`, \`ao-browser press Enter\`
4. 화면이 바뀌면 다시 \`snapshot\` (ref는 같은 요소면 유지되지만 새 요소는 새 번호).
5. 검증: \`ao-browser text\`, \`ao-browser console\`, \`ao-browser screenshot\`. PNG 경로가 JSON의 \`path\`로 나온다. \`open\`으로 열지 말고, 그 파일을 읽어 확인하고 보여 줄 것은 작업 폴더로 복사한다.

## 그 밖의 명령
- \`wait <css선택자>\`, \`wait text:완료\`, \`wait idle\` [ms]. goto/reload/back/forward는 로딩 뒤 네트워크가 조용해질 때까지 기다린다.
- \`scroll down|up|top|bottom [px]\`, \`scroll e7\`, \`scroll e7 down 200\`
- \`keyboard Enter\`, \`keyboard "Control+A"\`, \`keyboard e3 "안녕"\`. \`press\`도 같은 키 조합을 받는다.
- \`hover e4\`, \`select e5 "서울"\`, \`upload e6 /절대/경로.png\`, \`dialog accept\` 또는 \`dialog dismiss\` (confirm/prompt를 띄우기 전에)
- \`network\`, \`console\` (콘솔 뒤에 네트워크 오류가 있으면 같이 나온다), \`tab new\`, \`tab select 2\`, \`tab close 2\`
- 페이지의 alert/confirm/prompt는 앱 화면에 대화상자 막대로 뜨고, 그동안 페이지는 멈춘다. 명령 결과에 "대화상자가 열려 있습니다"가 나오면 \`dialog accept [문구]\` 또는 \`dialog dismiss\`로 답한다. 미리 \`dialog accept\`를 해 두면 다음 대화상자에 자동으로 답한다.
- 링크·버튼이 새 창(target=_blank, window.open)을 열면 새 탭으로 열린다(OAuth 팝업의 window.opener 유지). \`tabs\`로 확인하고 \`tab select\`로 옮긴다.
- 파일 다운로드는 ~/Downloads에 저장된다. \`downloads\`로 이름·진행률·경로를 본다. \`downloads cancel d3\`로 취소.
- snapshot에는 같은 출처 iframe 안의 요소도 ref로 나오고 그대로 click/fill 된다. 교차 출처 iframe은 url만 나온다.
- \`screenshot --full\`은 페이지 전체(최대 16000px)를 찍는다. \`click e3 --trusted\`, \`fill e4 "값" --trusted\`, \`press Enter --trusted\`는 실제 마우스·키 이벤트(isTrusted)로 보낸다. 기본 DOM 방식이 안 먹힐 때만 쓴다.
- \`viewport iphone\`, \`viewport tablet\`, \`viewport desktop\`, \`viewport 390x844\`. iphone·tablet과 그 크기 이하는 모바일 user-agent와 터치를 켠다.
- \`type e3 "abc"\` (기존 값 뒤에 이어 입력), \`back\`, \`forward\`, \`reload\`, \`tabs\`, \`status\`
- ref 대신 CSS 선택자도 된다: \`click "button.primary"\`

## 규칙
- 응답이나 \`ao-browser tabs\`에 \`controllable: false\`가 나오면(브라우저 개발 모드의 외부 사이트) 그 탭은 조작되지 않는다. Playwright로 우회하지 말고 그 사실을 보고한다.
- screenshot은 데스크톱 앱에서 WebKit이 그린 실제 픽셀이다(canvas·video·WebGL 포함). 브라우저 패널이 보일 때 찍힌다.
- 외부 사이트에서 로그인·글쓰기·구매처럼 사용자 계정에 남는 동작은 사용자 확인 없이 하지 않는다.
- 사용자가 Esc 또는 "중지"를 누르면 이후 명령이 "사용자가 AI 조작을 중지했습니다"로 실패하고 약 1분 동안 막힌다. 멈추고 막힘으로 보고한다.
- 결제·삭제·외부 전송 같은 되돌릴 수 없는 버튼은 사용자 확인 없이 누르지 마라.
`;

async function pathExists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function onPath(binary: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && await pathExists(join(dir, binary))) return true;
  }
  return false;
}

/** Installs the CLI to ~/.local/bin and the skill into Codex/Claude/Grok skill folders. */
export async function installBrowserTooling(home = homedir()) {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ao-browser"), CLI_SOURCE);
  await chmod(join(bin, "ao-browser"), 0o755);
  for (const agent of [".codex", ".claude", ".grok"]) {
    // Only for CLIs that are actually installed: a config dir exists or the binary is on PATH.
    if (!(await pathExists(join(home, agent))) && !(await onPath(agent.slice(1)))) continue;
    const dir = join(home, agent, "skills", "orchestra-browser");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), SKILL_MD);
  }
}
