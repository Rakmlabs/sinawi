import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Express } from "express";
import { computerDir } from "./computer-tokens.js";
import { AXE_MISSING, axeBinary, bootedDevices, defaultExec, type Exec } from "./sim-tool.js";

/**
 * The simulator panel: the app shows a booted simulator's screen and forwards the user's clicks
 * and typing to it. Frames come from AXe's MJPEG stream (one per device, started on demand and
 * stopped once nobody has asked for a frame for a while); input uses the same held touch and
 * drag that ao-sim uses, so what the user does and what an agent does land the same way.
 */
type Frame = { seq: number; jpeg: Buffer };
type Stream = { child: ChildProcess; buffer: Buffer; frame?: Frame; seq: number; lastAsked: number; error?: string };

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

  constructor(private opts: { spawnAxe?: (args: string[]) => ChildProcess; exec?: Exec; idleMs?: number; now?: () => number } = {}) {
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

  private start(udid: string): Stream {
    const args = ["stream-video", "--udid", udid, "--format", "mjpeg", "--fps", "12", "--scale", "0.5", "--quality", "70"];
    const child = this.opts.spawnAxe ? this.opts.spawnAxe(args) : spawn(axeBinary(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const stream: Stream = { child, buffer: Buffer.alloc(0), seq: 0, lastAsked: this.now() };
    this.streams.set(udid, stream);
    child.stdout?.on("data", (chunk: Buffer) => {
      const { frames, rest } = takeFrames(Buffer.concat([stream.buffer, chunk]));
      stream.buffer = rest.length > 4_000_000 ? Buffer.alloc(0) : rest;
      const last = frames.at(-1);
      if (last) stream.frame = { seq: ++stream.seq, jpeg: last };
    });
    child.on("error", (error: NodeJS.ErrnoException) => { stream.error = error.code === "ENOENT" ? AXE_MISSING : error.message; });
    child.on("exit", () => {
      if (this.streams.get(udid) === stream) this.streams.delete(udid);
      if (!stream.frame && !stream.error) stream.error = "시뮬레이터 화면을 받지 못했습니다. 기기가 켜져 있는지 확인하세요.";
    });
    return stream;
  }

  private sweep() {
    const idle = this.opts.idleMs ?? 8_000;
    for (const [udid, stream] of this.streams) {
      if (this.now() - stream.lastAsked > idle) { stream.child.kill("SIGTERM"); this.streams.delete(udid); }
    }
  }

  stopAll() {
    clearInterval(this.sweeper);
    for (const stream of this.streams.values()) stream.child.kill("SIGTERM");
    this.streams.clear();
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
    const fraction = (value: unknown) => Math.min(1, Math.max(0, Number(value)));
    const point = async (fx: unknown, fy: unknown) => {
      const size = await this.pointSize(udid);
      return [String(Math.round(fraction(fx) * size.width)), String(Math.round(fraction(fy) * size.height))];
    };
    switch (body.kind) {
      case "tap": {
        const [x, y] = await point(body.x, body.y);
        return run(["touch", "-x", x, "-y", y, "--down", "--up", "--delay", "0.1"]);
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
  app.get("/api/sim-view/frame", (req, res) => {
    const udid = udidOf(req.query.udid);
    if (!udid) { res.status(400).json({ error: "기기 UDID가 필요합니다." }); return; }
    const frame = screen.frame(udid);
    if (!frame) { res.status(204).end(); return; }
    if ("error" in frame) { res.status(422).json({ error: frame.error }); return; }
    if (String(frame.seq) === req.query.after) { res.status(204).end(); return; }
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
