import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import test from "node:test";
import { registerSimViewRoutes } from "./sim-view.js";
import type { Exec } from "./sim-tool.js";

async function serve(exec: Exec): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json());
  registerSimViewRoutes(app, exec);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("the device list puts booted simulators first", async (t) => {
  const listing = { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
    { udid: "A", name: "iPhone 17", state: "Shutdown", isAvailable: true },
    { udid: "B", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
  ] } };
  const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify(listing), stderr: "" });
  const { url, server } = await serve(exec);
  t.after(() => server.close());
  const data = await (await fetch(`${url}/api/sim-view/devices`)).json() as { devices: Array<{ udid: string; runtime: string; booted: boolean }> };
  assert.deepEqual(data.devices.map((device) => device.udid), ["B", "A"]);
  assert.equal(data.devices[0].runtime, "iOS 26.5");
});

test("the simulator button opens Apple's Simulator app and says so when it cannot", async (t) => {
  const calls: string[][] = [];
  let code = 0;
  const exec: Exec = async (file, args) => { calls.push([file, ...args]); return { code, stdout: "", stderr: "" }; };
  const { url, server } = await serve(exec);
  t.after(() => server.close());
  assert.equal((await fetch(`${url}/api/sim-view/open`, { method: "POST" })).status, 200);
  assert.deepEqual(calls.at(-1), ["open", "-a", "Simulator"]);
  code = 1;
  const failed = await fetch(`${url}/api/sim-view/open`, { method: "POST" });
  assert.equal(failed.status, 422);
  assert.match((await failed.json() as { error: string }).error, /Simulator/u);
});
