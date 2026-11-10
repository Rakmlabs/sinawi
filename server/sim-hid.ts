import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDirFor, envVar } from "./runtime.js";
import { defaultExec, type Exec } from "./sim-tool.js";

/**
 * A held finger on a simulator's screen: one long-lived `sim-hid` helper per device
 * (native/sim-hid/sim-hid.m) takes down / move / up as JSON lines and answers each once the
 * simulator has the event, in well under a millisecond. Starting a process per event, as the AXe
 * path does, costs about 0.2 s each, which is why a drag could only be replayed after release.
 */
export type TouchKind = "down" | "move" | "up";
export type TouchResult = { ok: boolean; error?: string; dropped?: boolean };

const READY_MS = 8_000;
const ACK_MS = 2_000;

export class SimTouch {
  private waiting = new Map<number, (result: TouchResult) => void>();
  private nextId = 0;
  private buffer = "";
  private dead?: string;
  private ready: Promise<boolean>;
  /** The move on its way to the helper, and the newest one waiting behind it. */
  private moving = false;
  private queued?: { x: number; y: number; resolve: (result: TouchResult) => void };

  constructor(private child: ChildProcess, private onDead: () => void = () => undefined) {
    this.ready = new Promise<boolean>((resolveReady) => {
      const timer = setTimeout(() => { this.fail("시뮬레이터 입력 도우미가 응답하지 않습니다."); resolveReady(false); }, READY_MS);
      timer.unref?.();
      const settle = (ok: boolean) => { clearTimeout(timer); resolveReady(ok); };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.buffer += String(chunk);
        for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          let message: { ready?: boolean; error?: string; id?: number; ok?: boolean };
          try { message = JSON.parse(line) as typeof message; } catch { continue; }
          if (message.ready) settle(true);
          else if (message.id === undefined) { this.fail(message.error || "시뮬레이터 입력 도우미를 시작하지 못했습니다."); settle(false); }
          else {
            const done = this.waiting.get(message.id);
            this.waiting.delete(message.id);
            done?.(message.ok ? { ok: true } : { ok: false, error: message.error || "입력 실패" });
          }
        }
      });
      child.on("error", (error) => { this.fail(error.message); settle(false); });
      child.on("exit", () => { this.fail("시뮬레이터 입력 도우미가 종료됐습니다."); settle(false); });
      // A write to a helper that just exited must not take the server down with EPIPE.
      child.stdin?.on("error", () => undefined);
    });
  }

  /** True once the helper holds the device's HID connection; false when it could not. */
  whenReady() { return this.ready; }

  private fail(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    for (const done of this.waiting.values()) done({ ok: false, error: reason });
    this.waiting.clear();
    this.queued?.resolve({ ok: false, error: reason });
    this.queued = undefined;
    this.child.kill("SIGTERM");
    this.onDead();
  }

  private write(t: TouchKind, x: number, y: number): Promise<TouchResult> {
    if (this.dead) return Promise.resolve({ ok: false, error: this.dead });
    const id = ++this.nextId;
    return new Promise<TouchResult>((resolveResult) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolveResult({ ok: false, error: "시뮬레이터가 입력에 응답하지 않습니다." }); }, ACK_MS);
      timer.unref?.();
      this.waiting.set(id, (result) => { clearTimeout(timer); resolveResult(result); });
      this.child.stdin?.write(`${JSON.stringify({ id, t, x, y })}\n`);
    });
  }

  /**
   * Sends one event. Moves are coalesced: while one is on its way, only the newest position waits
   * behind it, so a slow simulator is never fed a backlog of places the finger has already left.
   * A dropped move answers `{ ok: true, dropped: true }`.
   */
  async send(t: TouchKind, x: number, y: number): Promise<TouchResult> {
    if (!(await this.ready)) return { ok: false, error: this.dead || "입력 실패" };
    if (t !== "move") {
      // The down or up carries its own position; a move still waiting is already stale.
      this.queued?.resolve({ ok: true, dropped: true });
      this.queued = undefined;
      return this.write(t, x, y);
    }
    if (this.moving) {
      this.queued?.resolve({ ok: true, dropped: true });
      return new Promise<TouchResult>((resolveResult) => { this.queued = { x, y, resolve: resolveResult }; });
    }
    this.moving = true;
    const result = await this.write("move", x, y);
    this.moving = false;
    const next = this.queued;
    if (next) { this.queued = undefined; void this.send("move", next.x, next.y).then(next.resolve); }
    return result;
  }

  close() {
    if (this.dead) return;
    this.dead = "닫힘";
    for (const done of this.waiting.values()) done({ ok: false, error: this.dead });
    this.waiting.clear();
    // Closing stdin lets the helper lift a finger that is still down before it exits.
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1_500);
    timer.unref?.();
  }
}

/** clang arguments for the helper; scripts/build-server.mjs builds the bundled copy with the same ones plus both architectures. */
const CLANG_ARGS = ["-fobjc-arc", "-O2", "-mmacosx-version-min=11.0", "-framework", "Foundation", "-framework", "CoreGraphics"];

/**
 * Where the helper binary is: the app bundle ships it next to server.cjs; a source checkout
 * (`npm run dev`) compiles native/sim-hid/sim-hid.m into the data folder the first time.
 */
export async function simHidBinary(exec: Exec = defaultExec, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const override = envVar("SIM_HID", env);
  if (override) return existsSync(override) ? override : undefined;
  const bundled = process.argv[1] ? join(dirname(resolve(process.argv[1])), "sim-hid") : "";
  if (bundled && existsSync(bundled)) return bundled;
  const source = resolve(process.cwd(), "native/sim-hid/sim-hid.m");
  if (!existsSync(source)) return undefined;
  const out = join(dataDirFor(undefined, env), "bin", "sim-hid");
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs) return out;
  mkdirSync(dirname(out), { recursive: true });
  const built = await exec("xcrun", ["clang", ...CLANG_ARGS, source, "-o", out], 120_000);
  return built.code === 0 && existsSync(out) ? out : undefined;
}

let developerDir: Promise<string | undefined> | undefined;

/** Starts the helper for a device, or undefined when it cannot run here (no binary, no Xcode). */
export async function spawnSimHid(udid: string, exec: Exec = defaultExec): Promise<ChildProcess | undefined> {
  const binary = await simHidBinary(exec);
  if (!binary) return undefined;
  developerDir ??= exec("xcode-select", ["-p"], 10_000).then((out) => (out.code === 0 ? out.stdout.trim() || undefined : undefined));
  const dir = await developerDir;
  if (!dir) { developerDir = undefined; return undefined; }
  return spawn(binary, [udid, dir], { stdio: ["pipe", "pipe", "ignore"] });
}
