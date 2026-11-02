import { randomUUID } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Express, Request } from "express";
import { computerUseBlockedMessage } from "./workspace-policy.js";
import { computerQueueDir, computerShotDir, resolveComputerDir } from "./computer-tokens.js";

/**
 * Computer use: `ao-computer` (agents) → this bridge (policy gate, serial queue, timeouts, log)
 * → the app window → Tauri `computer_exec` (native, holds the TCC grants).
 *
 * Nothing here is a security boundary: agents run as the same macOS user and can rewrite this
 * server and the page the app loads. The boundary is the native approval alert `computer_exec`
 * shows for a session without a grant. This bridge attributes requests (per-run token), keeps
 * the activity trail and refuses obviously bad input; its "approved" sessions are display only.
 */
export const COMPUTER_ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "apps", "windows", "activate", "ax", "ax_click", "ax_set_value", "cursor", "wait", "status"] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];
export const isComputerAction = (value: string): value is ComputerAction => (COMPUTER_ACTIONS as readonly string[]).includes(value);

/** `grant` is what the native alert just granted ("once"/"session"), relayed for display. */
export type ComputerResult = { ok: boolean; result?: unknown; error?: string; grant?: "once" | "session" };
/** Facts the native approval alert shows (display only; they come from this server). */
export type ComputerDialogContext = { agent?: string; workspace?: string; title?: string; summary: string };
/** Sent to app windows; each connection gets its own `nonce`, which its result must echo. */
export type ComputerCommand = { type: "computer-command"; id: string; key: string; action: ComputerAction; args: Record<string, unknown>; context: ComputerDialogContext };
/** Who is asking, resolved from the run token. `key` scopes the native grant. */
export type ComputerContext = { key: string; workspaceId: string; sessionId?: string; agent?: string; title?: string; workspaceName?: string };
export type ComputerHint = { token?: string };
export type ComputerActivity = { id: string; time: string; key: string; sessionId?: string; workspaceId: string; agent?: string; action: ComputerAction; summary: string; ok: boolean; error?: string; image?: { name: string; width?: number; height?: number } };
type Shot = { rect: { x: number; y: number; w: number; h: number }; scale: number };

export const SHOT_DIR = computerShotDir();
export const QUEUE_DIR = computerQueueDir();
export const COMPUTER_LOG = join(homedir(), "Library", "Logs", "Sinawi", "computer.log");
export const STOPPED_MESSAGE = "사용자가 컴퓨터 조작을 중지했습니다. 같은 명령을 다시 보내지 말고 막힘으로 보고하세요.";
/** Error prefixes from the native side (`computer_exec`). */
export const NATIVE_DENIED = "[denied] ";
export const NATIVE_APPROVAL_TIMEOUT = "[approval-timeout] ";
export const DENIED_MESSAGE = "사용자가 이 세션의 컴퓨터 조작을 거부했습니다. 다시 시도하지 말고 다른 방법(앱 브라우저, 파일, CLI)을 쓰거나 막힘으로 보고하세요.";
export const APPROVAL_TIMEOUT_MESSAGE = "사용자가 2분 안에 컴퓨터 조작 요청에 답하지 않았습니다. 같은 요청을 반복하지 말고 막힘으로 보고하세요.";
export const TOKEN_MESSAGE = "컴퓨터 조작 토큰이 없거나 만료되었습니다. ao-computer는 Sinawi가 실행한 에이전트 세션 안에서만 쓸 수 있습니다 (SINAWI_COMPUTER_TOKEN). 막힘으로 보고하세요.";

/** Creates `dir` as a private (0700) directory owned by this user; refuses symlinks and foreign owners. */
export async function ensurePrivateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`컴퓨터 조작 폴더가 디렉터리가 아닙니다: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`컴퓨터 조작 폴더의 소유자가 다릅니다: ${dir}`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

// ---------- argv parsing (embedded verbatim into the CLI; keep self-contained) ----------

/** Parses `ao-computer <action> …` argv into [action, args]. Self-contained: it is shipped inside the CLI. */
export function parseComputerArgv(argv: string[]): { action?: string; args: Record<string, unknown>; error?: string } {
  const flags: Record<string, unknown> = {};
  const pos: string[] = [];
  const valued = ["display", "window", "region", "app", "max", "repeat", "depth", "steps", "amount"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      if (name === "at") { flags.at = [argv[i + 1], argv[i + 2]]; i += 2; continue; }
      if (valued.includes(name)) { flags[name] = inline !== undefined ? inline : argv[++i]; continue; }
      flags[name] = true;
      continue;
    }
    pos.push(a);
  }
  const raw = (pos.shift() || "").toLowerCase().replace(/-/g, "_");
  const alias: Record<string, string> = { shot: "screenshot", screen: "screenshot", doubleclick: "double_click", dblclick: "double_click", rightclick: "right_click", press: "key", hotkey: "key", app: "activate", open: "activate", focus: "activate", tree: "ax", axclick: "ax_click", ax_press: "ax_click", ax_set: "ax_set_value", ax_fill: "ax_set_value", sleep: "wait", mouse: "cursor" };
  const action = alias[raw] || raw;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const common: Record<string, unknown> = {};
  if (flags.self) common.allowSelf = true;
  if (flags.pixels) common.space = "pixels";
  const point = (x: unknown, y: unknown) => ({ x: num(x), y: num(y) });
  switch (action) {
    case "": return { args: {} };
    case "screenshot": {
      const args: Record<string, unknown> = {};
      if (flags.display !== undefined) args.display = num(flags.display);
      if (flags.window !== undefined) args.window = num(flags.window);
      if (flags.app !== undefined) args.app = String(flags.app);
      if (flags.region !== undefined) { const [x, y, w, h] = String(flags.region).split(/[ ,x]+/).map(Number); args.region = { x, y, w, h }; }
      if (flags.retina) args.retina = true;
      if (flags.max !== undefined) args.max = num(flags.max);
      return { action, args };
    }
    case "click": case "double_click": case "right_click": case "move":
      return { action, args: { ...point(pos[0], pos[1]), ...common } };
    case "drag":
      return { action, args: { ...point(pos[0], pos[1]), x2: num(pos[2]), y2: num(pos[3]), ...(flags.steps !== undefined ? { steps: num(flags.steps) } : {}), ...common } };
    case "type": return { action, args: { text: pos.join(" "), ...common } };
    case "key": return { action, args: { key: pos.join("+").replace(/\s+/g, ""), ...(flags.repeat !== undefined ? { repeat: num(flags.repeat) } : {}), ...common } };
    case "scroll": {
      const direction = (pos[0] || "down").toLowerCase();
      const at = Array.isArray(flags.at) ? point(flags.at[0], flags.at[1]) : {};
      return { action, args: { direction, amount: num(pos[1] ?? flags.amount), ...at, ...common } };
    }
    case "windows": return { action, args: { ...(pos[0] || flags.app ? { app: String(pos[0] || flags.app) } : {}), ...(flags.all ? { all: true } : {}) } };
    case "activate": return { action, args: { app: pos.join(" ") || String(flags.app || "") } };
    case "ax": {
      const args: Record<string, unknown> = {};
      if (pos[0] || flags.app) args.app = String(pos[0] || flags.app);
      if (flags.window !== undefined) args.window = num(flags.window);
      if (flags.depth !== undefined) args.depth = num(flags.depth);
      if (flags.max !== undefined) args.max = num(flags.max);
      return { action, args };
    }
    case "ax_click": return { action, args: { ref: pos[0], ...common } };
    case "ax_set_value": return { action, args: { ref: pos[0], text: pos.slice(1).join(" "), ...common } };
    case "wait": return { action, args: { ms: num(pos[0] ?? 1000) } };
    case "apps": case "cursor": case "status": return { action, args: {} };
    default: return { action, args: {}, error: "알 수 없는 명령: " + action };
  }
}

// ---------- validation & coordinates (pure) ----------

const finite = (value: unknown, label: string, min = -100_000, max = 100_000): number => {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) throw new Error(`${label} 값이 필요합니다 (숫자).`);
  if (n < min || n > max) throw new Error(`${label} 값이 범위를 벗어났습니다: ${n}`);
  return n;
};
const optional = (value: unknown, label: string, min?: number, max?: number) => value === undefined || value === null || value === "" ? undefined : finite(value, label, min, max);

/** Normalizes and checks one action's args. Throws a user-facing Error. */
export function validateComputerArgs(action: ComputerAction, raw: Record<string, unknown>): Record<string, unknown> {
  const args = raw && typeof raw === "object" ? raw : {};
  const common: Record<string, unknown> = {};
  if (args.allowSelf === true) common.allowSelf = true;
  if (args.space === "pixels") common.space = "pixels";
  switch (action) {
    case "screenshot": {
      const out: Record<string, unknown> = {};
      const display = optional(args.display, "display", 0, 15); if (display !== undefined) out.display = Math.trunc(display);
      const window = optional(args.window, "window", 1, 2 ** 32); if (window !== undefined) out.window = Math.trunc(window);
      if (typeof args.app === "string" && args.app.trim()) out.app = args.app.trim().slice(0, 200);
      if (args.region !== undefined) {
        const r = args.region as Record<string, unknown>;
        out.region = { x: finite(r?.x, "region x"), y: finite(r?.y, "region y"), w: finite(r?.w, "region 너비", 1), h: finite(r?.h, "region 높이", 1) };
      }
      if ([out.display, out.window, out.app, out.region].filter((v) => v !== undefined).length > 1) throw new Error("screenshot 대상은 --display, --window, --app, --region 중 하나만 지정하세요.");
      if (args.retina === true) out.retina = true;
      const max = optional(args.max, "max", 64, 10_000); if (max !== undefined) out.max = Math.trunc(max);
      return out;
    }
    case "click": case "double_click": case "right_click": case "move":
      return { x: finite(args.x, "x"), y: finite(args.y, "y"), ...common };
    case "drag": {
      const steps = optional(args.steps, "steps", 2, 120);
      return { x: finite(args.x, "x"), y: finite(args.y, "y"), x2: finite(args.x2, "x2"), y2: finite(args.y2, "y2"), ...(steps !== undefined ? { steps } : {}), ...common };
    }
    case "type": {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) throw new Error("입력할 글자가 필요합니다. 예: ao-computer type \"안녕하세요\"");
      if (text.length > 5_000) throw new Error("한 번에 5000자까지 입력할 수 있습니다.");
      return { text, ...common };
    }
    case "key": {
      const key = typeof args.key === "string" ? args.key.trim() : "";
      if (!key || key.length > 60) throw new Error("키 조합이 필요합니다. 예: ao-computer key cmd+c, ao-computer key return");
      const repeat = optional(args.repeat, "repeat", 1, 50);
      return { key, ...(repeat !== undefined ? { repeat: Math.trunc(repeat) } : {}), ...common };
    }
    case "scroll": {
      const direction = String(args.direction ?? "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("scroll 방향은 up, down, left, right 중 하나입니다.");
      const amount = optional(args.amount, "amount", 1, 5_000);
      const at = args.x !== undefined || args.y !== undefined ? { x: finite(args.x, "x"), y: finite(args.y, "y") } : {};
      return { direction, ...(amount !== undefined ? { amount } : {}), ...at, ...common };
    }
    case "windows": return { ...(typeof args.app === "string" && args.app.trim() ? { app: args.app.trim().slice(0, 200) } : {}), ...(args.all === true ? { all: true } : {}) };
    case "activate": {
      const app = typeof args.app === "string" ? args.app.trim() : "";
      if (!app || app.length > 200) throw new Error("앱 이름이 필요합니다. 예: ao-computer activate TextEdit");
      return { app };
    }
    case "ax": {
      const out: Record<string, unknown> = {};
      if (typeof args.app === "string" && args.app.trim()) out.app = args.app.trim().slice(0, 200);
      const window = optional(args.window, "window", 0, 100); if (window !== undefined) out.window = Math.trunc(window);
      const depth = optional(args.depth, "depth", 1, 60); if (depth !== undefined) out.depth = Math.trunc(depth);
      const max = optional(args.max, "max", 10, 2_000); if (max !== undefined) out.max = Math.trunc(max);
      return out;
    }
    case "ax_click": case "ax_set_value": {
      const ref = String(args.ref ?? "");
      if (!/^a\d{1,5}$/.test(ref)) throw new Error("ax ref가 필요합니다 (예: a12). 먼저 ao-computer ax로 트리를 보세요.");
      if (action === "ax_click") return { ref, ...common };
      const text = typeof args.text === "string" ? args.text : "";
      if (text.length > 5_000) throw new Error("값은 5000자까지입니다.");
      return { ref, text, ...common };
    }
    case "wait": return { ms: finite(args.ms ?? 1000, "ms", 0, 30_000) };
    case "apps": case "cursor": case "status": return {};
  }
}

/** Screenshot image pixels → global screen points, using that screenshot's rect and scale. */
export function pixelsToPoints(shot: Shot, x: number, y: number): { x: number; y: number } {
  const scale = shot.scale > 0 ? shot.scale : 1;
  return { x: Math.round((shot.rect.x + x / scale) * 100) / 100, y: Math.round((shot.rect.y + y / scale) * 100) / 100 };
}

export function commandTimeout(action: ComputerAction, args: Record<string, unknown>): number {
  if (action === "type") return Math.min(120_000, 10_000 + String(args.text ?? "").length * 20);
  if (action === "screenshot" || action === "ax") return 25_000;
  if (action === "activate") return 15_000;
  return 10_000;
}

/** One-line description for the log, the approval dialog and the chat entry. Never echoes typed text. */
export function describeAction(action: ComputerAction, args: Record<string, unknown>): string {
  const at = (x: unknown, y: unknown) => `(${Math.round(Number(x))}, ${Math.round(Number(y))})`;
  switch (action) {
    case "screenshot": return args.window ? `창 ${args.window} 스크린샷` : args.app ? `${args.app} 창 스크린샷` : args.region ? "영역 스크린샷" : `화면 ${args.display ?? 0} 스크린샷`;
    case "click": return `클릭 ${at(args.x, args.y)}`;
    case "double_click": return `더블 클릭 ${at(args.x, args.y)}`;
    case "right_click": return `오른쪽 클릭 ${at(args.x, args.y)}`;
    case "move": return `포인터 이동 ${at(args.x, args.y)}`;
    case "drag": return `드래그 ${at(args.x, args.y)} → ${at(args.x2, args.y2)}`;
    case "type": return `글자 입력 (${String(args.text ?? "").length}자)`;
    case "key": return `키 ${args.key}${Number(args.repeat) > 1 ? ` ×${args.repeat}` : ""}`;
    case "scroll": return `스크롤 ${args.direction}${args.amount ? ` ${args.amount}` : ""}`;
    case "apps": return "실행 중인 앱 목록";
    case "windows": return args.app ? `${args.app} 창 목록` : "창 목록";
    case "activate": return `${args.app} 앞으로`;
    case "ax": return `${args.app ?? "맨 앞 앱"} 접근성 트리`;
    case "ax_click": return `요소 누르기 ${args.ref}`;
    case "ax_set_value": return `요소 값 설정 ${args.ref} (${String(args.text ?? "").length}자)`;
    case "cursor": return "포인터 위치";
    case "wait": return `${args.ms}ms 대기`;
    case "status": return "상태 확인";
  }
}

// ---------- bridge ----------

export type ComputerBridgeOptions = {
  /**
   * Sends a command to the app windows, asking `nonce()` for a fresh nonce per connection
   * (each connection gets its own); returns how many received it.
   */
  send: (command: ComputerCommand, nonce: () => string) => number;
  /** Pushes UI messages (state, activity, revocations) to every window. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Number of connected app windows. */
  windows: () => number;
  /** Per-workspace setting `computerUse` (off by default). */
  isAllowed: (workspaceId: string) => boolean;
  /** Resolves the caller from its run token; undefined = unknown/expired token (request refused). */
  resolveContext: (hint: ComputerHint) => ComputerContext | undefined;
  /** False once a session no longer exists (its display entry is dropped). */
  keyAlive?: (key: string) => boolean;
  launchApp?: () => Promise<boolean>;
  logFile?: string;
  shotDir?: string;
  /** Extra time the app gets when it may have to show the native approval alert first. */
  approvalTimeoutMs?: number;
  /** How long new commands are refused after a stop. */
  stopCooldownMs?: number;
  idleRevokeMs?: number;
  maxQueue?: number;
  /** Overrides the per-action app timeout (tests). */
  timeoutMs?: number;
  now?: () => number;
};

/** Display-only: a session the native alert approved "for this session". */
type Grant = { ctx: ComputerContext; since: number; last: number };
type Pending = { workspaceId: string; key: string; nonces: Set<string>; finish: (r: ComputerResult) => void };

export class ComputerBridge {
  private pending = new Map<string, Pending>();
  private grants = new Map<string, Grant>();
  private denied = new Map<string, number>();
  /** Per session: when the user last denied computer use, and when it last asked (for global stops). */
  private userDenied = new Map<string, number>();
  private lastRequest = new Map<string, number>();
  private lastStop = 0;
  private shots = new Map<string, Shot>();
  private activity: ComputerActivity[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private epoch = 0;
  private stoppedUntil = 0;
  private launching?: Promise<boolean>;
  private sweeper?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private opts: ComputerBridgeOptions) {
    this.now = opts.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref?.();
  }

  dispose() { if (this.sweeper) clearInterval(this.sweeper); }

  /** Drops display entries whose session is gone or that sat idle too long (and revokes them natively). */
  sweep() {
    const idle = this.opts.idleRevokeMs ?? 30 * 60_000;
    let changed = false;
    for (const [key, grant] of this.grants) {
      if ((this.opts.keyAlive && !this.opts.keyAlive(key)) || this.now() - grant.last > idle) { this.grants.delete(key); this.opts.broadcast({ type: "computer-revoked", key }); changed = true; }
    }
    if (changed) this.publishState();
  }

  state() {
    return {
      active: this.grants.size > 0,
      stopped: this.now() < this.stoppedUntil,
      sessions: [...this.grants.entries()].map(([key, g]) => ({ key, agent: g.ctx.agent, title: g.ctx.title, sessionId: g.ctx.sessionId, workspaceId: g.ctx.workspaceId, since: new Date(g.since).toISOString(), last: new Date(g.last).toISOString() })),
      busy: this.queued,
    };
  }

  activityFor(sessionId?: string, workspaceId?: string) {
    return this.activity.filter((a) => (!sessionId || a.sessionId === sessionId) && (!workspaceId || a.workspaceId === workspaceId));
  }

  private publishState() { this.opts.broadcast({ type: "computer-state", state: this.state() }); }

  private logChain: Promise<void> = Promise.resolve();
  /** Appends one line to computer.log (serialized; never throws). */
  private log(ctx: ComputerContext | undefined, action: string, summary: string, outcome: string) {
    const file = this.opts.logFile ?? COMPUTER_LOG;
    const line = `${new Date(this.now()).toISOString()} agent=${ctx?.agent ?? "?"} session=${ctx?.sessionId ?? "-"} workspace=${ctx?.workspaceId ?? "-"} ${action} "${summary.replace(/"/g, "'")}" -> ${outcome.replace(/\s+/g, " ").slice(0, 300)}\n`;
    this.logChain = this.logChain.then(async () => { await mkdir(join(file, ".."), { recursive: true }); await appendFile(file, line); }).catch(() => undefined);
    return this.logChain;
  }

  flushLog() { return this.logChain; }

  /**
   * Whether the user said no to computer use for this session since `since` (a deny in the native
   * alert, or a global stop while the session was using the computer). The run should end then,
   * not go on looking for another way.
   */
  userHalt(sessionId: string, since: number): "denied" | "stopped" | undefined {
    if ((this.userDenied.get(sessionId) ?? -Infinity) >= since) return "denied";
    if (this.lastStop >= since && (this.lastRequest.get(sessionId) ?? -Infinity) >= since) return "stopped";
    return undefined;
  }

  /** User-initiated stop: revoke every approval, reject queued and in-flight commands. */
  stop(reason = "user") {
    this.epoch++;
    this.lastStop = this.now();
    this.stoppedUntil = this.now() + (this.opts.stopCooldownMs ?? 60_000);
    this.grants.clear();
    for (const entry of [...this.pending.values()]) entry.finish({ ok: false, error: STOPPED_MESSAGE });
    void this.log(undefined, "stop", reason, "every approval revoked");
    this.opts.broadcast({ type: "computer-revoked", reason });
    this.publishState();
  }

  /** Revokes one session's approval (from the banner) without the global cooldown. */
  revoke(key: string) {
    this.opts.broadcast({ type: "computer-revoked", key });
    const ctx = this.grants.get(key)?.ctx;
    if (this.grants.delete(key)) { void this.log(ctx, "revoke", key, "approval revoked"); this.publishState(); }
  }

  /**
   * The workspace's `computerUse` setting was turned off: drop its sessions (here and, via
   * `computer-revoked`, natively) and fail its in-flight commands right away. Queued ones are
   * refused when their turn comes (`run` re-checks the gate).
   */
  revokeWorkspace(workspaceId: string) {
    const keys = new Set<string>();
    for (const [key, grant] of this.grants) if (grant.ctx.workspaceId === workspaceId) { this.grants.delete(key); keys.add(key); }
    for (const entry of [...this.pending.values()]) if (entry.workspaceId === workspaceId) { entry.finish({ ok: false, error: computerUseBlockedMessage }); keys.add(entry.key); }
    if (!keys.size) return;
    for (const key of keys) this.opts.broadcast({ type: "computer-revoked", key });
    void this.log({ key: "-", workspaceId }, "revoke", "workspace setting off", `${keys.size} session(s) revoked`);
    this.publishState();
  }

  private windowCount() { return this.opts.windows(); }

  private launch(): Promise<boolean> {
    if (!this.opts.launchApp) return Promise.resolve(false);
    this.launching ??= this.opts.launchApp().catch(() => false).finally(() => { setTimeout(() => { this.launching = undefined; }, 1_000); });
    return this.launching;
  }

  /** Sends one command to the app and waits for its result (launching the app when no window is open). */
  private dispatch(ctx: ComputerContext, action: ComputerAction, args: Record<string, unknown>, summary: string, timeoutMs: number): Promise<ComputerResult> {
    const id = randomUUID();
    const command: ComputerCommand = { type: "computer-command", id, key: ctx.key, action, args, context: { agent: ctx.agent, workspace: ctx.workspaceName ?? ctx.workspaceId, title: ctx.title, summary } };
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ComputerResult) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const entry: Pending = { workspaceId: ctx.workspaceId, key: ctx.key, nonces: new Set(), finish };
      const issue = () => { const nonce = randomUUID(); entry.nonces.add(nonce); return nonce; };
      this.pending.set(id, entry);
      const arm = () => { timer = setTimeout(() => finish({ ok: false, error: `Sinawi 앱이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다. 화면이 잠겨 있으면 실행할 수 없습니다.` }), timeoutMs); };
      if (this.opts.send(command, issue)) { arm(); return; }
      const missing = () => finish({ ok: false, error: "Sinawi 앱 창이 열려 있지 않습니다. 앱을 실행한 뒤 다시 시도하세요." });
      if (!this.opts.launchApp) { missing(); return; }
      void this.launch().then(async (launched) => {
        if (!launched) { missing(); return; }
        const deadline = this.now() + 15_000;
        while (this.now() < deadline && this.pending.has(id)) {
          await new Promise((r) => setTimeout(r, 500));
          if (this.opts.send(command, issue)) { arm(); return; }
        }
        missing();
      }, missing);
    });
  }

  /**
   * A result from an app window. Accepted only for a command that was dispatched and not yet
   * answered, carrying a nonce that was sent with it (so a bare HTTP caller cannot answer).
   */
  resolve(id: string, nonce: string, result: ComputerResult): boolean {
    const entry = this.pending.get(id);
    if (!entry || !nonce || !entry.nonces.has(nonce)) return false;
    const grant = result.grant === "once" || result.grant === "session" ? result.grant : undefined;
    entry.finish({ ok: Boolean(result.ok), result: result.result, error: result.error ? String(result.error) : undefined, ...(grant ? { grant } : {}) });
    return true;
  }

  get size() { return this.pending.size; }

  private record(ctx: ComputerContext, action: ComputerAction, summary: string, result: ComputerResult) {
    const value = result.result as { path?: string; width?: number; height?: number } | undefined;
    const name = result.ok && action === "screenshot" && typeof value?.path === "string" ? value.path.split("/").pop() : undefined;
    const entry: ComputerActivity = { id: randomUUID(), time: new Date(this.now()).toISOString(), key: ctx.key, sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, agent: ctx.agent, action, summary, ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(name ? { image: { name, width: value?.width, height: value?.height } } : {}) };
    this.activity.push(entry);
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
    this.opts.broadcast({ type: "computer-activity", activity: entry });
    void this.log(ctx, action, summary, result.ok ? "ok" : `error: ${result.error}`);
  }

  async request(actionName: string, rawArgs: Record<string, unknown> = {}, hint: ComputerHint = {}): Promise<ComputerResult> {
    if (!isComputerAction(actionName)) return { ok: false, error: `알 수 없는 컴퓨터 명령: ${actionName}. ao-computer --help를 보세요.` };
    const action = actionName;
    let args: Record<string, unknown>;
    try { args = validateComputerArgs(action, rawArgs); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    const ctx = this.opts.resolveContext(hint);
    const summary = describeAction(action, args);
    if (!ctx) { void this.log(undefined, action, summary, "refused: no valid run token"); return { ok: false, error: TOKEN_MESSAGE }; }
    const allowed = this.opts.isAllowed(ctx.workspaceId);
    if (action === "status") return this.status(ctx, allowed);
    if (!allowed) { void this.log(ctx, action, summary, "blocked by workspace setting"); return { ok: false, error: computerUseBlockedMessage }; }
    if (ctx.sessionId) this.lastRequest.set(ctx.sessionId, this.now());
    if (this.now() < this.stoppedUntil) return { ok: false, error: STOPPED_MESSAGE };
    if ((this.denied.get(ctx.key) ?? 0) > this.now()) { if (ctx.sessionId) this.userDenied.set(ctx.sessionId, this.now()); return { ok: false, error: DENIED_MESSAGE }; }

    const epoch = this.epoch;
    if (args.space === "pixels") {
      const shot = this.shots.get(ctx.key);
      if (!shot) return { ok: false, error: "--pixels는 이 세션에서 먼저 찍은 screenshot 기준입니다. 먼저 ao-computer screenshot을 실행하세요." };
      const { space: _space, ...rest } = args;
      args = { ...rest, ...pixelsToPoints(shot, Number(args.x), Number(args.y)) };
      if (action === "drag") { const end = pixelsToPoints(shot, Number(rest.x2), Number(rest.y2)); args.x2 = end.x; args.y2 = end.y; }
      if (action === "scroll" && rest.x === undefined) { delete args.x; delete args.y; }
    }
    const shotDir = this.opts.shotDir ?? SHOT_DIR;
    if (action === "screenshot") args.out = join(shotDir, `shot-${this.now()}-${randomUUID().slice(0, 6)}.png`);

    if (this.queued >= (this.opts.maxQueue ?? 16)) return { ok: false, error: "컴퓨터 조작 명령이 너무 많이 대기 중입니다. 앞 명령이 끝난 뒤 보내세요." };
    this.queued++;
    const run = async (): Promise<ComputerResult> => {
      if (epoch !== this.epoch) return { ok: false, error: STOPPED_MESSAGE };
      if (!this.opts.isAllowed(ctx.workspaceId)) return { ok: false, error: computerUseBlockedMessage };
      const grant = this.grants.get(ctx.key);
      if (grant) grant.last = this.now();
      if (action === "wait") {
        const ms = Number(args.ms);
        const deadline = this.now() + ms;
        while (this.now() < deadline) { if (epoch !== this.epoch) return { ok: false, error: STOPPED_MESSAGE }; await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - this.now())))); }
        return { ok: true, result: { waited: ms } };
      }
      if (action === "screenshot") {
        try { await ensurePrivateDir(shotDir); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      // Without a (displayed) session approval the app may show its native alert first.
      const timeout = this.opts.timeoutMs ?? commandTimeout(action, args);
      return this.dispatch(ctx, action, args, summary, grant ? timeout : timeout + (this.opts.approvalTimeoutMs ?? 125_000));
    };
    const task = this.chain.then(run, run);
    this.chain = task.catch(() => undefined);
    let result: ComputerResult;
    try { result = await task; } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; } finally { this.queued--; }
    result = this.afterNative(ctx, result);
    if (action === "screenshot" && result.ok) {
      const value = result.result as Shot | undefined;
      if (value?.rect && Number(value.scale) > 0) this.shots.set(ctx.key, { rect: value.rect, scale: Number(value.scale) });
      void pruneShots(shotDir);
    }
    this.record(ctx, action, summary, result);
    return result;
  }

  /** Mirrors the native decision for display and maps native error prefixes to agent-facing messages. */
  private afterNative(ctx: ComputerContext, result: ComputerResult): ComputerResult {
    if (result.ok) {
      const existing = this.grants.get(ctx.key);
      if (result.grant === "session" && !existing) { this.grants.set(ctx.key, { ctx, since: this.now(), last: this.now() }); this.publishState(); }
      else if (existing) existing.last = this.now();
      if (result.grant === "once" || result.grant === "session") void this.log(ctx, "approval", "native alert", result.grant);
      return result;
    }
    const error = result.error ?? "";
    if (error.startsWith(NATIVE_DENIED)) {
      this.denied.set(ctx.key, this.now() + 10 * 60_000);
      if (ctx.sessionId) this.userDenied.set(ctx.sessionId, this.now());
      if (this.grants.delete(ctx.key)) this.publishState();
      void this.log(ctx, "approval", "native alert", "deny");
      return { ok: false, error: DENIED_MESSAGE };
    }
    if (error.startsWith(NATIVE_APPROVAL_TIMEOUT)) return { ok: false, error: APPROVAL_TIMEOUT_MESSAGE };
    // No answer in time: the app may have lost its grant (restart) and be asking; allow the long timeout next time.
    if (/응답하지 않았습니다/.test(error) && this.grants.delete(ctx.key)) this.publishState();
    return result;
  }

  private async status(ctx: ComputerContext, allowed: boolean): Promise<ComputerResult> {
    const base = { allowed, approved: this.grants.has(ctx.key), stopped: this.now() < this.stoppedUntil, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, agent: ctx.agent, ...(allowed ? {} : { hint: computerUseBlockedMessage }) };
    const app = this.windowCount() ? await this.dispatch(ctx, "status", {}, describeAction("status", {}), 4_000) : { ok: false, error: "Sinawi 앱 창이 열려 있지 않습니다." };
    return { ok: true, result: { ...base, app: app.ok ? app.result : { error: app.error } } };
  }
}

/** Keeps the newest 200 screenshots. */
export async function pruneShots(dir = SHOT_DIR, keep = 200) {
  try {
    const names = (await readdir(dir)).filter((n) => /^shot-\d+-[\w]+\.png$/.test(n)).sort();
    await Promise.all(names.slice(0, Math.max(0, names.length - keep)).map((n) => rm(join(dir, n), { force: true })));
  } catch { /* ignore */ }
}

/** Only the run token identifies the caller; a client-sent session id is ignored. */
const hintFrom = (req: Request): ComputerHint => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  return { token: typeof body.token === "string" && body.token ? body.token : undefined };
};

export function registerComputerRoutes(app: Express, bridge: ComputerBridge, shotDir = SHOT_DIR) {
  // Results must name a dispatched, unanswered command and echo the nonce sent with it.
  app.post("/api/computer/result", (req, res) => {
    const grant = req.body?.grant === "once" || req.body?.grant === "session" ? req.body.grant as "once" | "session" : undefined;
    const ok = bridge.resolve(String(req.body?.id ?? ""), String(req.body?.nonce ?? ""), { ok: Boolean(req.body?.ok), result: req.body?.result, error: req.body?.error, grant });
    res.status(ok ? 200 : 409).json({ ok });
  });
  // Stop/revoke only take permissions away, so they need no proof of origin.
  app.post("/api/computer/stop", (req, res) => { bridge.stop(String(req.body?.reason ?? "user").slice(0, 60)); res.json({ ok: true }); });
  app.post("/api/computer/revoke", (req, res) => { bridge.revoke(String(req.body?.key ?? "")); res.json({ ok: true }); });
  app.get("/api/computer/state", (_req, res) => { res.json(bridge.state()); });
  app.get("/api/computer/activity", (req, res) => {
    res.json(bridge.activityFor(typeof req.query.session === "string" ? req.query.session : undefined, typeof req.query.workspace === "string" ? req.query.workspace : undefined));
  });
  app.get("/api/computer/image/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!/^shot-\d+-[\w]+\.png$/.test(name)) { res.status(400).end(); return; }
    try { const data = await readFile(join(shotDir, name)); res.type("png").set("cache-control", "private, max-age=3600").send(data); } catch { res.status(404).end(); }
  });
  app.post("/api/computer/:action", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const args = body.args && typeof body.args === "object" ? body.args as Record<string, unknown> : {};
    const result = await bridge.request(String(req.params.action), args, hintFrom(req));
    res.status(result.ok ? 200 : 422).json(result);
  });
}

/** File-queue fallback for sandboxes without loopback network (Codex workspace-write). */
export function watchComputerQueue(bridge: ComputerBridge, dir = QUEUE_DIR, intervalMs = 150) {
  const busy = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (stopped) return;
    try {
      await ensurePrivateDir(dir);
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".req.json") || busy.has(name)) continue;
        busy.add(name);
        const base = name.slice(0, -".req.json".length);
        void (async () => {
          let out: ComputerResult;
          try {
            const raw = JSON.parse(await readFile(join(dir, name), "utf8"));
            await rm(join(dir, name), { force: true });
            out = await bridge.request(String(raw.action), raw.args ?? {}, { token: typeof raw.token === "string" ? raw.token : undefined });
          } catch (error) { out = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          await writeFile(join(dir, `${base}.res.tmp`), JSON.stringify(out));
          await rename(join(dir, `${base}.res.tmp`), join(dir, `${base}.res.json`));
        })().catch((error) => console.error("ao-computer 응답 저장 실패:", error instanceof Error ? error.message : error)).finally(() => busy.delete(name));
      }
    } catch { /* ignore */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

const USAGE = `사용법: ao-computer <명령> [인자]   (좌표는 화면 포인트, 주 화면 왼쪽 위 = 0,0)
  status                         권한·허용 상태
  screenshot [--display N | --window ID | --app 이름 | --region x,y,w,h] [--retina] [--max 1600]
                                 PNG 경로·크기·scale·rect(포인트)를 JSON으로
  apps | windows [앱] [--all]    실행 중인 앱 / 창(id, 위치·크기)
  activate <앱 이름|번들 id>       앱을 앞으로 (없으면 실행)
  ax [앱] [--window N] [--depth N] 접근성 트리 (ref a1, a2 …)
  ax_click <ref> | ax_set_value <ref> <텍스트>
  click|double_click|right_click|move <x> <y> [--pixels]
  drag <x1> <y1> <x2> <y2> [--pixels]
  scroll <up|down|left|right> [양] [--at x y]
  type <텍스트>                    유니코드 입력 (한글 가능, 비밀번호 칸은 거부)
  key <조합> [--repeat N]          예: cmd+c, return, escape, cmd+shift+t
  cursor | wait <ms>
  --pixels: 마지막 screenshot 이미지의 픽셀 좌표로 해석   --self: Sinawi 창을 일부러 조작`;

export const CLI_SOURCE = `#!/usr/bin/env node
// ao-computer — Sinawi를 통해 macOS 화면을 보고 마우스·키보드를 조작합니다. (자동 생성 파일)
const fs = require("fs"), path = require("path"), os = require("os");
const port = process.env.SINAWI_PORT || process.env.AGENT_ORCHESTRA_PORT || "3001";
const usage = ${JSON.stringify(USAGE)};
const tokenMessage = ${JSON.stringify(TOKEN_MESSAGE)};
// The parser and the shared-folder resolver are the unit-tested server functions, embedded as source (__name: esbuild keepNames helper).
const __name = (fn) => fn;
const parse = ${parseComputerArgv.toString()};
const resolveDir = ${resolveComputerDir.toString()};
const userTmp = () => { try { return require("child_process").execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2000 }).trim() || undefined; } catch { return undefined; } };
const QUEUE = path.join(resolveDir(process.env, process.platform, process.getuid ? process.getuid() : 0, os.tmpdir(), userTmp), "queue");
async function viaHttp(action, body) {
  const res = await fetch("http://127.0.0.1:" + port + "/api/computer/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
async function viaQueue(action, body) {
  const dir = QUEUE;
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.accessSync(dir, fs.constants.W_OK); } catch { throw new Error("큐 폴더에 쓸 수 없습니다: " + dir); }
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(path.join(dir, id + ".req.tmp"), JSON.stringify({ action, ...body }));
  fs.renameSync(path.join(dir, id + ".req.tmp"), path.join(dir, id + ".req.json"));
  const res = path.join(dir, id + ".res.json"), req = path.join(dir, id + ".req.json"), start = Date.now();
  while (Date.now() - start < 180000) {
    if (fs.existsSync(res)) { const out = JSON.parse(fs.readFileSync(res, "utf8")); fs.rmSync(res, { force: true }); return out; }
    if (Date.now() - start > 4000 && fs.existsSync(req)) { fs.rmSync(req, { force: true }); return { ok: false, error: "Sinawi 서버가 실행 중이 아닙니다." }; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, error: "응답 시간 초과" };
}
function print(out) {
  if (!out || !out.ok) { console.error("오류: " + ((out && out.error) || "실패")); process.exit(1); }
  const r = out.result;
  if (r && typeof r.tree === "string") { console.log((r.app ? r.app + " · " : "") + r.count + "개 요소" + (r.truncated ? " (잘림: --depth/--max로 좁히세요)" : "")); console.log(r.tree); return; }
  console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2));
}
(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { console.log(usage); process.exit(0); }
  const parsed = parse(argv);
  if (parsed.error || !parsed.action) { console.error((parsed.error || "명령이 필요합니다") + "\\n\\n" + usage); process.exit(2); }
  const token = process.env.SINAWI_COMPUTER_TOKEN || "";
  if (!token) { console.error("오류: " + tokenMessage); process.exit(1); }
  const body = { args: parsed.args, token };
  let out;
  try { out = await viaHttp(parsed.action, body); }
  catch { try { out = await viaQueue(parsed.action, body); } catch (e) { out = { ok: false, error: String(e.message || e) }; } }
  print(out);
})();
`;

export const SKILL_MD = `---
name: orchestra-computer
description: Sinawi를 통해 macOS 화면을 스크린샷으로 보고, 다른 네이티브 앱(TextEdit, Finder, 시스템 앱 등)을 마우스·키보드·접근성 트리로 조작한다. 웹 페이지는 이 스킬 대신 orchestra-browser를 쓴다.
---

# orchestra-computer

사용자 화면을 보고 조작한다. 명령은 셸에서 \`ao-computer\` (없으면 \`node ~/.local/bin/ao-computer\`).
작업 공간 설정 "컴퓨터 조작 허용"이 켜져 있어야 하고, 첫 명령 때 macOS 확인 창에서 사용자가 허용해야 한다 (최대 2분 기다림). Sinawi가 실행한 세션 안에서만 동작한다(\`SINAWI_COMPUTER_TOKEN\`).

## 먼저 고를 것
- **웹 페이지·localhost 개발 서버는 \`ao-browser\`(orchestra-browser)** 를 쓴다. 컴퓨터 조작은 브라우저로 안 되는 네이티브 앱용이다.
- 파일·셸·CLI로 되는 일은 그쪽으로 한다. 화면 조작은 마지막 수단이다.

## 기본 흐름: 보고 → 하고 → 다시 본다
1. \`ao-computer status\` — 권한·허용 상태. 권한이 없으면 오류에 나온 시스템 설정 화면을 사용자에게 알리고 멈춘다.
2. \`ao-computer activate TextEdit\` — 대상 앱을 앞으로. **Sinawi가 맨 앞이면 type/key가 거부된다.**
3. \`ao-computer screenshot --app TextEdit\` (또는 \`screenshot\` = 주 화면) — JSON의 \`path\` PNG를 읽어 화면을 확인한다.
4. **ax ref를 좌표보다 먼저 쓴다:** \`ao-computer ax TextEdit\` → \`[a12] AXButton "저장"\` → \`ao-computer ax_click a12\`, 입력칸은 \`ao-computer ax_set_value a7 "내용"\`.
5. ref가 없을 때만 좌표: \`click 640 300\` (화면 포인트) 또는 스크린샷 픽셀 그대로 \`click 812 433 --pixels\`.
6. 입력: \`type "안녕하세요"\` (한글 가능), 단축키: \`key cmd+s\`, \`key return\`, 스크롤: \`scroll down 400 --at 600 400\`.
7. 바뀐 결과를 다시 \`screenshot\`(또는 \`ax\`)으로 확인한 뒤 보고한다.

## 좌표
- 모든 좌표는 **전역 화면 포인트**(주 화면 왼쪽 위 = 0,0, 보조 화면은 음수일 수 있음). Retina 픽셀이 아니다.
- screenshot 결과: \`rect\`(찍은 영역, 포인트), \`scale\`(이미지 픽셀 ÷ 포인트). 기본 이미지는 1픽셀=1포인트, \`--retina\`면 2배.
- 이미지 픽셀 (px, py) → 포인트 = (rect.x + px/scale, rect.y + py/scale). \`--pixels\`가 이 계산을 대신 한다(이 세션의 마지막 screenshot 기준).

## 규칙
- 같은 오류가 3번 나면 멈추고 막힘으로 보고한다. 좌표를 조금씩 바꿔 가며 계속 누르지 않는다.
- 비밀번호 칸에는 입력이 거부된다. 비밀번호·결제·인증은 사용자에게 맡긴다.
- "사용자가 컴퓨터 조작을 중지했습니다"/"거부했습니다"가 나오면 즉시 멈추고 보고한다. 우회(osascript, cliclick 등)하지 않는다.
- Sinawi 자신의 창은 기본으로 조작되지 않는다. 삭제·전송·결제 같은 되돌릴 수 없는 버튼은 사용자 확인 없이 누르지 않는다.
- 스크린샷 PNG는 임시 폴더다. 보여 줄 그림은 작업 폴더로 복사해 마크다운 경로로 보고한다.
- 전문: 이 저장소의 \`docs/orchestration/prompts/computer-use.md\`, \`ao-computer --help\`.
`;

async function pathExists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function onPath(binary: string, pathEnv: string) {
  for (const dir of pathEnv.split(delimiter)) if (dir && await pathExists(join(dir, binary))) return true;
  return false;
}

/**
 * Installs `ao-computer` next to ao-browser (~/.local/bin) and the skill for the agent CLIs that
 * are actually installed (config dir exists or the binary is on PATH); never creates ~/.codex etc.
 */
export async function installComputerTooling(home = homedir(), pathEnv = process.env.PATH ?? "") {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const target = join(bin, "ao-computer");
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== CLI_SOURCE) { await writeFile(target, CLI_SOURCE); await chmod(target, 0o755); }
  const installed: string[] = [];
  for (const agent of [".codex", ".claude", ".grok"]) {
    if (!(await pathExists(join(home, agent))) && !(await onPath(agent.slice(1), pathEnv))) continue;
    const dir = join(home, agent, "skills", "orchestra-computer");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), SKILL_MD);
    installed.push(agent.slice(1));
  }
  return { cli: (await stat(target)).isFile(), skills: installed };
}
