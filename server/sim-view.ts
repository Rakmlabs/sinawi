import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Express } from "express";
import { computerDir } from "./computer-tokens.js";
import { AXE_MISSING, axeBinary, bootedDevices, defaultExec, type Exec } from "./sim-tool.js";
import { SimTouch } from "./sim-hid.js";

/**
 * The simulator panel: the app shows a booted simulator's screen and forwards the user's clicks
 * and typing to it. Frames come from AXe's MJPEG stream (one per device, started on demand and
 * stopped once nobody has asked for a frame for a while). The panel long-polls: a request waits
 * for the next frame, so every frame is shown as it is captured with no polling delay. Touches go
 * through one long-lived helper per device (sim-hid.ts), so a drag follows the pointer while it is
 * still down; without the helper they fall back to one `axe` process per gesture, the held touch
 * and drag that ao-sim uses, replayed on release.
 */
type Frame = { seq: number; jpeg: Buffer };
type Stream = { child: ChildProcess; buffer: Buffer; frame?: Frame; seq: number; lastAsked: number; error?: string; waiters: Set<() => void> };

/** AXe captures by screenshot and tops out near 19 fps on an M-series Mac; asking for 30 gets all it can give. */
const STREAM_FPS = "30";
/** How long a frame request waits for a newer frame before answering "nothing new". */
const FRAME_WAIT_MS = 1_000;

/** How long a tap holds the finger down through the helper. */
const TAP_HOLD_MS = 60;
/** After the helper failed to start for a device, how long input stays on AXe before trying again. */
const TOUCH_RETRY_MS = 30_000;

const HEADER_END = Buffer.from("\r\n\r\n");
const LENGTH = /Content-Length:\s*(\d+)/iu;

/** Pulls complete JPEG parts out of AXe's multipart stream; returns the rest for the next chunk. */
export function takeFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf(HEADER_END);
    if (end < 0) break;
    const header = rest.subarray(0, end).toString("latin1");
    const match = LENGTH.exec(header);
    if (!match) { rest = rest.subarray(end + HEADER_END.length); continue; }
    const length = Number(match[1]);
    const start = end + HEADER_END.length;
    if (rest.length < start + length) break;
    frames.push(Buffer.from(rest.subarray(start, start + length)));
    rest = rest.subarray(start + length);
  }
  return { frames, rest };
}

export class SimScreen {
  private streams = new Map<string, Stream>();
  private sizes = new Map<string, { width: number; height: number }>();
  private sweeper: ReturnType<typeof setInterval>;
  private touches = new Map<string, Promise<SimTouch | undefined>>();
  private touchFailed = new Map<string, number>();
  /** The drag in progress per device: where it started, and whether the helper is holding the finger down. */
  private drags = new Map<string, { x: number; y: number; t: number; live: boolean }>();

  /** `spawnHid` starts the touch helper for a device (sim-hid.ts); without it every touch goes through AXe. */
  constructor(private opts: { spawnAxe?: (args: string[]) => ChildProcess; spawnHid?: (udid: string) => Promise<ChildProcess | undefined>; exec?: Exec; idleMs?: number; now?: () => number; tapHoldMs?: number } = {}) {
    this.sweeper = setInterval(() => this.sweep(), 2_000);
    this.sweeper.unref();
  }

  private get now() { return this.opts.now ?? Date.now; }
  private get exec() { return this.opts.exec ?? defaultExec; }

  /** The newest frame for `udid`, starting its stream if needed (undefined until the first frame). */
  frame(udid: string): Frame | { error: string } | undefined {
    let stream = this.streams.get(udid);
    if (!stream) stream = this.start(udid);
    stream.lastAsked = this.now();
    if (stream.error && !stream.frame) return { error: stream.error };
    return stream.frame;
  }

  /**
   * The frame after `after` (a sequence number), waiting up to `waitMs` for one to be captured.
   * Undefined when nothing newer came in time: the caller asks again.
   */
  async nextFrame(udid: string, after: string | undefined, waitMs = FRAME_WAIT_MS): Promise<Frame | { error: string } | undefined> {
    const current = this.frame(udid);
    if (current && ("error" in current || String(current.seq) !== after)) return current;
    const stream = this.streams.get(udid);
    if (!stream || waitMs <= 0) return undefined;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); stream.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      stream.waiters.add(done);
    });
    stream.lastAsked = this.now();
    if (stream.error && !stream.frame) return { error: stream.error };
    return stream.frame && String(stream.frame.seq) !== after ? stream.frame : undefined;
  }

  private start(udid: string): Stream {
    const args = ["stream-video", "--udid", udid, "--format", "mjpeg", "--fps", STREAM_FPS, "--scale", "0.5", "--quality", "70"];
    const child = this.opts.spawnAxe ? this.opts.spawnAxe(args) : spawn(axeBinary(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const stream: Stream = { child, buffer: Buffer.alloc(0), seq: 0, lastAsked: this.now(), waiters: new Set() };
    const wake = () => { for (const waiter of [...stream.waiters]) waiter(); };
    // The first tap needs the screen size; asking now keeps that wait out of the tap.
    // Only for a real stream: a fake one in tests has no simulator to ask.
    if (!this.opts.spawnAxe && !this.sizes.has(udid)) void this.pointSize(udid).catch(() => undefined);
    // The helper takes about a second to connect; do that while the first frames load, not on the first touch.
    if (!this.opts.spawnAxe) void this.touch(udid);
    this.streams.set(udid, stream);
    child.stdout?.on("data", (chunk: Buffer) => {
      const { frames, rest } = takeFrames(Buffer.concat([stream.buffer, chunk]));
      stream.buffer = rest.length > 4_000_000 ? Buffer.alloc(0) : rest;
      const last = frames.at(-1);
      if (last) { stream.frame = { seq: ++stream.seq, jpeg: last }; wake(); }
    });
    child.on("error", (error: NodeJS.ErrnoException) => { stream.error = error.code === "ENOENT" ? AXE_MISSING : error.message; wake(); });
    child.on("exit", () => {
      if (this.streams.get(udid) === stream) this.streams.delete(udid);
      if (!stream.frame && !stream.error) stream.error = "시뮬레이터 화면을 받지 못했습니다. 기기가 켜져 있는지 확인하세요.";
      wake();
    });
    return stream;
  }

  private sweep() {
    // Reopening the panel within half a minute shows the screen at once instead of restarting the capture.
    const idle = this.opts.idleMs ?? 30_000;
    for (const [udid, stream] of this.streams) {
      if (this.now() - stream.lastAsked > idle) { stream.child.kill("SIGTERM"); this.streams.delete(udid); this.dropTouch(udid); }
    }
  }

  /** The device's touch helper, started on first use; undefined when it is unavailable (input then uses AXe). */
  private touch(udid: string): Promise<SimTouch | undefined> {
    const spawnHid = this.opts.spawnHid;
    if (!spawnHid) return Promise.resolve(undefined);
    const known = this.touches.get(udid);
    if (known) return known;
    if (this.now() - (this.touchFailed.get(udid) ?? -Infinity) < TOUCH_RETRY_MS) return Promise.resolve(undefined);
    const opening = (async () => {
      const child = await spawnHid(udid).catch(() => undefined);
      if (!child) return undefined;
      const touch = new SimTouch(child, () => { if (this.touches.get(udid) === opening) this.touches.delete(udid); });
      return (await touch.whenReady()) ? touch : undefined;
    })().then((touch) => {
      if (!touch) { this.touchFailed.set(udid, this.now()); if (this.touches.get(udid) === opening) this.touches.delete(udid); }
      return touch;
    });
    this.touches.set(udid, opening);
    return opening;
  }

  private dropTouch(udid: string) {
    const opening = this.touches.get(udid);
    this.touches.delete(udid);
    this.drags.delete(udid);
    void opening?.then((touch) => touch?.close());
  }

  stopAll() {
    clearInterval(this.sweeper);
    for (const stream of this.streams.values()) stream.child.kill("SIGTERM");
    this.streams.clear();
    for (const udid of [...this.touches.keys()]) this.dropTouch(udid);
  }

  /** Screen size in points, from the accessibility tree's root frame (iPhone 16 Pro: 402×874). */
  async pointSize(udid: string): Promise<{ width: number; height: number }> {
    const known = this.sizes.get(udid);
    if (known) return known;
    const out = await this.exec(axeBinary(), ["describe-ui", "--udid", udid], 20_000);
    if (out.code !== 0) throw new Error(out.code === 127 ? AXE_MISSING : (out.stderr || out.stdout).trim().slice(0, 300) || "화면 크기를 알 수 없습니다.");
    const roots = JSON.parse(out.stdout) as Array<{ frame?: { width: number; height: number } }>;
    const frame = roots.find((node) => node.frame && node.frame.width > 0)?.frame;
    if (!frame) throw new Error("화면 크기를 알 수 없습니다.");
    const size = { width: frame.width, height: frame.height };
    this.sizes.set(udid, size);
    return size;
  }

  /** Clicks arrive as fractions of the shown frame; the device takes points. */
  async input(udid: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const run = async (args: string[]) => {
      const out = await this.exec(axeBinary(), [...args, "--udid", udid], 30_000);
      return out.code === 0 ? { ok: true } : { ok: false, error: out.code === 127 ? AXE_MISSING : (out.stderr || out.stdout).trim().slice(0, 300) || "입력 실패" };
    };
    const fraction = (value: unknown) => Math.min(1, Math.max(0, Number(value) || 0));
    const ack = (result: { ok: boolean; error?: string }) => (result.ok ? { ok: true } : { ok: false, error: result.error });
    const point = async (fx: unknown, fy: unknown) => {
      const size = await this.pointSize(udid);
      return [String(Math.round(fraction(fx) * size.width)), String(Math.round(fraction(fy) * size.height))];
    };
    switch (body.kind) {
      case "tap": {
        const touch = await this.touch(udid);
        if (touch && (await touch.send("down", fraction(body.x), fraction(body.y))).ok) {
          await new Promise((resolve) => setTimeout(resolve, this.opts.tapHoldMs ?? TAP_HOLD_MS));
          return ack(await touch.send("up", fraction(body.x), fraction(body.y)));
        }
        const [x, y] = await point(body.x, body.y);
        return run(["touch", "-x", x, "-y", y, "--down", "--up", "--delay", "0.1"]);
      }
      // A live drag: the finger goes down, follows each move and lifts on up. Without the helper
      // the moves are skipped and the whole drag is replayed by AXe when the pointer is released.
      case "down": {
        const x = fraction(body.x), y = fraction(body.y);
        const touch = await this.touch(udid);
        const live = touch ? (await touch.send("down", x, y)).ok : false;
        this.drags.set(udid, { x, y, t: this.now(), live });
        return { ok: true };
      }
      case "move": {
        const drag = this.drags.get(udid);
        if (!drag) return { ok: false, error: "누르지 않은 상태에서는 끌 수 없습니다." };
        if (!drag.live) return { ok: true };
        const touch = await this.touch(udid);
        return touch ? ack(await touch.send("move", fraction(body.x), fraction(body.y))) : { ok: false, error: "입력 실패" };
      }
      case "up": {
        const drag = this.drags.get(udid);
        this.drags.delete(udid);
        if (!drag) return { ok: false, error: "누르지 않은 상태에서는 뗄 수 없습니다." };
        if (drag.live) {
          const touch = await this.touch(udid);
          return touch ? ack(await touch.send("up", fraction(body.x), fraction(body.y))) : { ok: false, error: "입력 실패" };
        }
        const [x1, y1] = await point(drag.x, drag.y);
        const [x2, y2] = await point(body.x, body.y);
        return run(["drag", "--start-x", x1, "--start-y", y1, "--end-x", x2, "--end-y", y2, "--duration", String(Math.min(2, Math.max(0.1, (this.now() - drag.t) / 1000)))]);
      }
      case "drag": {
        const [x1, y1] = await point(body.x1, body.y1);
        const [x2, y2] = await point(body.x2, body.y2);
        return run(["drag", "--start-x", x1, "--start-y", y1, "--end-x", x2, "--end-y", y2, "--duration", String(Math.min(2, Math.max(0.1, Number(body.duration) || 0.3)))]);
      }
      case "type": return typeof body.text === "string" && body.text ? run(["type", body.text]) : { ok: false, error: "입력할 글자가 없습니다." };
      case "key": {
        const codes: Record<string, string> = { enter: "40", backspace: "42", tab: "43" };
        const code = codes[String(body.key)];
        return code ? run(["key", code]) : { ok: false, error: `지원하지 않는 키: ${String(body.key)}` };
      }
      default: return { ok: false, error: "알 수 없는 입력입니다." };
    }
  }
}

/** Available simulators for the panel's picker: booted ones first. */
async function listDevices(exec: Exec) {
  const out = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"], 20_000);
  if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim().slice(0, 300) || "시뮬레이터 목록을 읽지 못했습니다.");
  const parsed = JSON.parse(out.stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  const list = Object.entries(parsed.devices).flatMap(([runtime, devices]) => devices.map((device) => ({ udid: device.udid, name: device.name, runtime: (runtime.split(".").pop() ?? runtime).replace(/-/gu, " ").replace(/ (\d+) (\d+)$/u, " $1.$2"), booted: device.state === "Booted" })));
  return list.sort((a, b) => Number(b.booted) - Number(a.booted));
}

export function registerSimViewRoutes(app: Express, screen: SimScreen, exec: Exec = defaultExec) {
  const udidOf = (value: unknown) => (typeof value === "string" && /^[A-F0-9-]{36}$/iu.test(value) ? value : undefined);
  app.get("/api/sim-view/devices", async (_req, res) => {
    try { res.json({ devices: await listDevices(exec), booted: (await bootedDevices(exec)).map((device) => device.udid) }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/sim-view/boot", async (req, res) => {
    const udid = udidOf(req.body?.udid);
    if (!udid) { res.status(400).json({ error: "기기 UDID가 필요합니다." }); return; }
    const out = await exec("xcrun", ["simctl", "boot", udid], 120_000);
    if (out.code !== 0 && !/current state: Booted/u.test(out.stderr)) { res.status(422).json({ error: out.stderr.trim().slice(0, 300) || "부팅하지 못했습니다." }); return; }
    res.json({ ok: true });
  });
  app.get("/api/sim-view/frame", async (req, res) => {
    const udid = udidOf(req.query.udid);
    if (!udid) { res.status(400).json({ error: "기기 UDID가 필요합니다." }); return; }
    // Long poll: answers as soon as a frame newer than `after` exists (204 after a second without one).
    const frame = await screen.nextFrame(udid, typeof req.query.after === "string" ? req.query.after : undefined);
    if (!frame) { res.status(204).end(); return; }
    if ("error" in frame) { res.status(422).json({ error: frame.error }); return; }
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Frame-Seq": String(frame.seq) }).send(frame.jpeg);
  });
  // Full-resolution screenshot for a chat attachment (the agent opens the file).
  app.post("/api/sim-view/capture", async (req, res) => {
    const udid = udidOf(req.body?.udid);
    if (!udid) { res.status(400).json({ error: "기기 UDID가 필요합니다." }); return; }
    const dir = join(computerDir(), "sim-shots");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `panel-${Date.now()}.png`);
    const out = await exec("xcrun", ["simctl", "io", udid, "screenshot", path], 30_000);
    if (out.code !== 0) { res.status(422).json({ error: out.stderr.trim().slice(0, 300) || "스크린샷 실패" }); return; }
    res.json({ path });
  });
  app.post("/api/sim-view/input", async (req, res) => {
    const udid = udidOf(req.body?.udid);
    if (!udid) { res.status(400).json({ error: "기기 UDID가 필요합니다." }); return; }
    try {
      const out = await screen.input(udid, req.body as Record<string, unknown>);
      res.status(out.ok ? 200 : 422).json(out);
    } catch (error) { res.status(422).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
}
