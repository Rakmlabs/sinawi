import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { clearComputerTokens, issueComputerToken } from "./computer-tokens.js";
import { AXE_MISSING, axeBinary, compactUi, findElement, handleSim, metroUrl, parseSimArgv, registerSimRoutes, SIM_CLI_SOURCE, type Exec } from "./sim-tool.js";

const BOOTED = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "UDID-1", name: "iPhone 16 Pro", state: "Booted" }], "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [{ udid: "UDID-2", name: "iPhone 15", state: "Shutdown" }] } });

function fakeExec(responses: (file: string, args: string[]) => { code: number; stdout?: string; stderr?: string } | undefined = () => undefined) {
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    if (file === "xcrun" && args.slice(0, 3).join(" ") === "simctl list devices") return { code: 0, stdout: BOOTED, stderr: "" };
    const out = responses(file, args) ?? { code: 0 };
    return { code: out.code, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { exec, calls };
}

test("a dev-client app launches straight into Metro with --initialUrl instead of openurl's confirm alert", async () => {
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "personal", agent: "claude" });
  try {
    const { exec, calls } = fakeExec();
    const out = await handleSim("launch", { token, bundle: "kr.example.app", metro: "8081" }, { exec });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(calls.at(-1), ["xcrun", ["simctl", "launch", "--terminate-running-process", "UDID-1", "kr.example.app", "--initialUrl", "http://localhost:8081"]]);
    assert.equal(metroUrl("http://localhost:19000"), "http://localhost:19000");
    assert.throws(() => metroUrl("exp://x"));
    assert.deepEqual((await handleSim("devices", { token }, { exec })).result, [{ udid: "UDID-1", name: "iPhone 16 Pro", runtime: "iOS-18-6" }], "only booted devices");
    const missing = await handleSim("launch", { token, bundle: "x", device: "iPad" }, { exec });
    assert.match(missing.error ?? "", /'iPad'이 없습니다/);
  } finally { clearComputerTokens(); }
});

test("screenshots land in the shot folder; touches go to AXe on the booted device, and a missing AXe says how to install it", async () => {
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "personal", agent: "codex" });
  try {
    const { exec, calls } = fakeExec((file) => (file.endsWith("axe") ? { code: 0, stdout: "Tap completed" } : undefined));
    const shot = await handleSim("screenshot", { token }, { exec, shotDir: tmpdir(), now: () => 42 });
    assert.equal((shot.result as { path: string }).path, join(tmpdir(), "sim-42.png"));
    assert.deepEqual(calls.at(-1)?.[1], ["simctl", "io", "UDID-1", "screenshot", join(tmpdir(), "sim-42.png")]);
    await handleSim("tap", { token, x: 120.4, y: 300 }, { exec });
    assert.deepEqual(calls.at(-1)?.[1], ["touch", "-x", "120", "-y", "300", "--down", "--up", "--delay", "0.1", "--udid", "UDID-1"], "a held touch, not axe tap");
    await handleSim("swipe", { token, x1: 200, y1: 700, x2: 200, y2: 200 }, { exec });
    assert.equal(calls.at(-1)?.[1][0], "drag", "explicit touch moves, not axe swipe");
    const tree = JSON.stringify([{ role: "AXApplication", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ role: "AXButton", AXLabel: "휴대폰 번호로 로그인", frame: { x: 20, y: 576, width: 362, height: 52 } }] }]);
    const byLabel = fakeExec((file, args) => (file.endsWith("axe") && args[0] === "describe-ui" ? { code: 0, stdout: tree } : undefined));
    const tapped = await handleSim("tap", { token, label: "휴대폰 번호로 로그인" }, { exec: byLabel.exec });
    assert.equal(tapped.ok, true, tapped.error);
    assert.deepEqual(byLabel.calls.at(-1)?.[1].slice(0, 5), ["touch", "-x", "201", "-y", "602"]);
    assert.equal((await handleSim("tap", { token, x: "a", y: 1 }, { exec })).ok, false);
    const noAxe = fakeExec((file) => (file.endsWith("axe") ? { code: 127, stderr: "spawn axe ENOENT" } : undefined));
    assert.equal((await handleSim("ui", { token }, { exec: noAxe.exec })).error, AXE_MISSING);
    assert.equal((await handleSim("tap", { x: 1, y: 1 }, { exec })).ok, false, "a run token is required");
  } finally { clearComputerTokens(); }
});

test("AXe is found in Homebrew's folders even when the server's PATH lacks them", () => {
  assert.equal(axeBinary((path) => path === "/usr/local/bin/axe"), "/usr/local/bin/axe");
  assert.equal(axeBinary(() => false), "axe");
});

test("ao-sim arguments", () => {
  assert.deepEqual(parseSimArgv(["launch", "kr.app", "--metro", "8081"]), { op: "launch", body: { bundle: "kr.app", metro: "8081" } });
  assert.deepEqual(parseSimArgv(["tap", "--label", "로그인"]), { op: "tap", body: { label: "로그인" } });
  assert.deepEqual(parseSimArgv(["tap", "10", "20", "--device", "iPhone 16 Pro"]), { op: "tap", body: { device: "iPhone 16 Pro", x: 10, y: 20 } });
  assert.deepEqual(parseSimArgv(["swipe", "200", "600", "200", "200"]).body, { x1: 200, y1: 600, x2: 200, y2: 200 });
  assert.deepEqual(parseSimArgv(["type", "안녕", "하세요"]).body, { text: "안녕 하세요" });
  assert.match(parseSimArgv(["tap"]).error ?? "", /좌표/);
  assert.match(parseSimArgv(["erase"]).error ?? "", /알 수 없는 명령/);
});

test("the generated ao-sim script reaches the app with the run token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-sim-"));
  const { exec } = fakeExec();
  const app = express();
  app.use(express.json());
  registerSimRoutes(app, { exec });
  const http = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const appPort = (http.address() as { port: number }).port;
  const script = join(dir, "ao-sim");
  await writeFile(script, SIM_CLI_SOURCE);
  await chmod(script, 0o755);
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "personal", agent: "claude" });
  const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, SINAWI_PORT: String(appPort), SINAWI_COMPUTER_TOKEN: token }, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
  try {
    const listed = await run(["devices"]);
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /iPhone 16 Pro/);
    const bad = await run(["tap"]);
    assert.equal(bad.code, 2);
  } finally {
    http.close();
    clearComputerTokens();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the screen tree comes back as one line per element with its tap point", () => {
  const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const tree = JSON.stringify([{ role: "AXApplication", AXLabel: "SIOT 회의실", frame: frame(0, 0, 402, 874), children: [
    { role: "AXGroup", frame: frame(0, 0, 402, 874), children: [
      { role: "AXButton", AXLabel: "휴대폰 번호로 로그인", frame: frame(20, 576.3, 362, 52) },
      { role: "AXStaticText", AXLabel: "또는", frame: frame(189, 542, 23.6, 18.3) },
      { role: "AXStaticText", AXLabel: "또는", frame: frame(189, 542, 23.6, 18.3) },
      { role: "AXTextField", AXValue: "", AXUniqueId: "phone", frame: frame(20, 200, 362, 48) },
    ] },
  ] }]);
  assert.equal(compactUi(tree), [
    "SIOT 회의실 화면 402×874pt",
    "Button \"휴대폰 번호로 로그인\" 탭 201 602",
    "StaticText \"또는\" 탭 201 551",
    "TextField id=phone 탭 201 224",
  ].join("\n"));
  assert.equal(compactUi("not json"), "not json");
});

test("a label taps only when exactly one element carries it", () => {
  const node = (label: string, y: number, id?: string) => ({ role: "AXButton", AXLabel: label, AXUniqueId: id ?? null, frame: { x: 0, y, width: 100, height: 20 } });
  const tree = JSON.stringify([{ role: "AXApplication", AXLabel: "정보", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [node("정보", 100), node("정보", 300), node("다음", 500, "next"), node("다음", 500)] }]);
  assert.match((findElement(tree, { label: "정보" }) as { error: string }).error, /2개입니다: \(50, 110\), \(50, 310\)/);
  assert.deepEqual(findElement(tree, { label: "다음" }), { x: 50, y: 510 }, "the same element reported twice is one");
  assert.deepEqual(findElement(tree, { id: "next" }), { x: 50, y: 510 });
  assert.match((findElement(tree, { label: "없음" }) as { error: string }).error, /화면에 없습니다/);
});
