import type { Express } from "express";
import { bootedDevices, defaultExec, type Exec } from "./sim-tool.js";

/**
 * Simulators as the app sees them: the device list (the `list_simulators` tool) and the header
 * button, which brings up Apple's own Simulator window. Sinawi does not mirror the screen itself;
 * agents drive a simulator with `ao-sim` (sim-tool.ts).
 */

/** Available simulators: booted ones first. */
async function listDevices(exec: Exec) {
  const out = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"], 20_000);
  if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim().slice(0, 300) || "시뮬레이터 목록을 읽지 못했습니다.");
  const parsed = JSON.parse(out.stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  const list = Object.entries(parsed.devices).flatMap(([runtime, devices]) => devices.map((device) => ({ udid: device.udid, name: device.name, runtime: (runtime.split(".").pop() ?? runtime).replace(/-/gu, " ").replace(/ (\d+) (\d+)$/u, " $1.$2"), booted: device.state === "Booted" })));
  return list.sort((a, b) => Number(b.booted) - Number(a.booted));
}

export function registerSimViewRoutes(app: Express, exec: Exec = defaultExec) {
  app.get("/api/sim-view/devices", async (_req, res) => {
    try { res.json({ devices: await listDevices(exec), booted: (await bootedDevices(exec)).map((device) => device.udid) }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  // The header's simulator button: Apple's Simulator app, in front, showing whatever is booted.
  app.post("/api/sim-view/open", async (_req, res) => {
    const out = await exec("open", ["-a", "Simulator"], 20_000);
    if (out.code !== 0) { res.status(422).json({ error: "Simulator 앱을 열지 못했습니다. Xcode가 설치되어 있는지 확인하세요." }); return; }
    res.json({ ok: true });
  });
}
