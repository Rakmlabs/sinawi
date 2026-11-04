import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
// @ts-expect-error plain .mjs without types: the package has no build step.
import { HELP, install, parseArgs, pickAsset } from "../packages/sinawi/lib/install.mjs";

// packages/sinawi: the npm package `@rakmlabs/sinawi`. `npx @rakmlabs/sinawi` installs the app, `npx @rakmlabs/sinawi mcp` is the
// stdio bridge Claude Desktop runs; lib/mcp.mjs is also the file bundled into the app as is.
const PACKAGE = join(process.cwd(), "packages", "sinawi");
const BIN = join(PACKAGE, "bin", "sinawi.mjs");
const BRIDGE = join(PACKAGE, "lib", "mcp.mjs");

type Seen = { headers: IncomingHttpHeaders; path?: string; body: string };

/** A stand-in for the app's POST /api/app-mcp: records each request and echoes the JSON-RPC id. */
async function stubApp(t: test.TestContext) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ headers: req.headers, path: req.url, body });
      const message = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer good-token") { res.statusCode = 401; res.end(JSON.stringify({ error: "bad token" })); return; }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  return { seen, port: (server.address() as { port: number }).port };
}

/** Runs the bin with `env`, writes `messages`, and waits for `expected` answers (notifications get none). */
async function bridge(env: Record<string, string>, messages: object[], expected = messages.length, argv = [BIN, "mcp"]): Promise<any[]> {
  const home = await mkdtemp(join(tmpdir(), "sinawi-mcp-home-"));
  try {
    // A HOME without the app's data folder: the default token path cannot leak in from this machine.
    const child = spawn(process.execPath, argv, { env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    const lines: any[] = [];
    const reader = createInterface({ input: child.stdout! });
    const done = new Promise<void>((resolve) => reader.on("line", (line) => { lines.push(JSON.parse(line)); if (lines.length === expected) resolve(); }));
    for (const message of messages) child.stdin!.write(`${JSON.stringify(message)}\n`);
    try {
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("no answer from sinawi-mcp")), 5_000))]);
    } finally { child.kill(); }
    return lines.sort((a, b) => a.id - b.id);
  } finally { await rm(home, { recursive: true, force: true }); }
}

const rpc = (id: number, method: string) => ({ jsonrpc: "2.0", id, method });

test("`sinawi mcp` forwards each JSON-RPC line to /api/app-mcp with the token as a Bearer header", async (t) => {
  const app = await stubApp(t);
  const answers = await bridge({ SINAWI_PORT: String(app.port), SINAWI_MCP_TOKEN: " good-token\n" }, [rpc(1, "initialize"), rpc(2, "tools/list")]);
  assert.deepEqual(answers.map((answer) => answer.result?.echoed), ["initialize", "tools/list"], "the app's answers come back unchanged");
  assert.equal(app.seen.length, 2);
  for (const request of app.seen) {
    assert.equal(request.path, "/api/app-mcp");
    assert.equal(request.headers.authorization, "Bearer good-token", "the token is trimmed and sent as Bearer");
    assert.equal(request.headers["content-type"], "application/json");
  }
  assert.deepEqual(app.seen.map((request) => JSON.parse(request.body).method).sort(), ["initialize", "tools/list"], "the message is forwarded as is");
});

test("`sinawi mcp` skips notifications, reports the app's refusals, and finds the token in the data folder", async (t) => {
  const app = await stubApp(t);
  const url = `http://127.0.0.1:${app.port}`;
  const [refused] = await bridge({ SINAWI_URL: url, SINAWI_MCP_TOKEN: "wrong" }, [{ jsonrpc: "2.0", method: "notifications/initialized" }, rpc(7, "tools/list")], 1);
  assert.equal(refused.id, 7);
  assert.equal(refused.error.message, "bad token", "the app's error text reaches the client");
  assert.equal(app.seen.length, 1, "a notification (no id) is not forwarded");

  const data = await mkdtemp(join(tmpdir(), "sinawi-mcp-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await writeFile(join(data, "app-mcp-token"), "good-token\n");
  const [fromDir] = await bridge({ SINAWI_URL: url, SINAWI_DATA_DIR: data }, [rpc(1, "tools/list")]);
  assert.equal(fromDir.result.echoed, "tools/list", "$SINAWI_DATA_DIR/app-mcp-token");
  await writeFile(join(data, "other-token"), "good-token");
  const [fromFile] = await bridge({ SINAWI_URL: url, SINAWI_DATA_DIR: join(data, "missing"), SINAWI_MCP_TOKEN_FILE: join(data, "other-token") }, [rpc(1, "tools/list")]);
  assert.equal(fromFile.result.echoed, "tools/list", "SINAWI_MCP_TOKEN_FILE comes before the data folder");
});

test("`sinawi mcp` says how to get a token when there is none, and when the app is not running", async (t) => {
  const app = await stubApp(t);
  const empty = await mkdtemp(join(tmpdir(), "sinawi-mcp-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const [missing] = await bridge({ SINAWI_PORT: String(app.port), SINAWI_DATA_DIR: empty }, [rpc(3, "tools/list")]);
  assert.equal(missing.id, 3);
  assert.equal(missing.error.code, -32603);
  assert.match(missing.error.message, /token missing: set SINAWI_MCP_TOKEN/u);
  assert.match(missing.error.message, /External AI connection/u);
  assert.equal(app.seen.length, 0, "nothing is sent without a token");

  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((done) => closed.close(() => done()));
  const [down] = await bridge({ SINAWI_PORT: String(port), SINAWI_MCP_TOKEN: "good-token" }, [rpc(4, "tools/list")]);
  assert.match(down.error.message, new RegExp(`not reachable at http://127\\.0\\.0\\.1:${port}`, "u"));
});


test("lib/mcp.mjs runs on its own, as the copy bundled into Sinawi.app does", async (t) => {
  const app = await stubApp(t);
  const [answer] = await bridge({ SINAWI_PORT: String(app.port), SINAWI_MCP_TOKEN: "good-token" }, [rpc(1, "tools/list")], 1, [BRIDGE]);
  assert.equal(answer.result.echoed, "tools/list");
  const source = await readFile(BRIDGE, "utf8");
  assert.doesNotMatch(source, /from "(?!node:)/u, "only node: built-ins, so the single file works anywhere");
  assert.doesNotMatch(source, /import\(/u, "no dynamic imports either");
});

const exec = promisify(execFile);

test("`sinawi --help`, `--version` and bad arguments answer without touching the network", async () => {
  const help = await exec(process.execPath, [BIN, "--help"]);
  assert.match(help.stdout, /npx @rakmlabs\/sinawi mcp/u);
  assert.match(help.stdout, /--yes/u);
  const manifest = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
  assert.equal((await exec(process.execPath, [BIN, "-v"])).stdout.trim(), manifest.version);
  await assert.rejects(exec(process.execPath, [BIN, "--bogus"]), (error: any) => error.code === 2 && /unknown option --bogus/u.test(error.stderr));
});

test("parseArgs: install is the default, mcp passes everything through, values are checked", () => {
  assert.deepEqual(parseArgs([]), { command: "install", yes: false, open: true, dmg: undefined, dir: "/Applications", error: undefined });
  assert.equal(parseArgs(["install", "-y"]).yes, true);
  assert.equal(parseArgs(["--yes", "--no-open"]).open, false);
  assert.equal(parseArgs(["--dmg", "/tmp/x.dmg"]).dmg, "/tmp/x.dmg");
  assert.equal(parseArgs(["--dir", "/tmp/apps"]).dir, "/tmp/apps");
  assert.equal(parseArgs(["mcp", "--whatever"]).command, "mcp", "the bridge takes no options of its own");
  assert.equal(parseArgs(["help"]).command, "help");
  assert.equal(parseArgs(["install", "--help"]).command, "help");
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.match(parseArgs(["--dmg"]).error, /--dmg needs a value/u);
  assert.match(parseArgs(["--dir", "--yes"]).error, /--dir needs a value/u);
  assert.match(parseArgs(["update"]).error, /unknown command update/u);
  assert.match(HELP, /install \(default\)/u);
});

test("pickAsset prefers the universal dmg and says so when a release has none", () => {
  const release = { tag_name: "v1.4.0", assets: [
    { name: "Sinawi.app.tar.gz", browser_download_url: "https://x/tar" },
    { name: "Sinawi_1.4.0_aarch64.dmg", browser_download_url: "https://x/arm" },
    { name: "Sinawi_1.4.0_universal.dmg", browser_download_url: "https://x/universal" },
  ] };
  assert.deepEqual(pickAsset(release), { name: "Sinawi_1.4.0_universal.dmg", url: "https://x/universal", version: "v1.4.0" });
  assert.equal(pickAsset({ tag_name: "v1", assets: [release.assets[1]] }).url, "https://x/arm");
  assert.throws(() => pickAsset({ tag_name: "v9", assets: [release.assets[0]] }), /v9\) has no \.dmg/u);
  assert.throws(() => pickAsset({}), /no \.dmg/u);
});

/** The installer with every outside effect faked: a fake GitHub, disk image, codesign/spctl and /Applications in a temp folder. */
async function fakeMac(t: test.TestContext, { codesign = 0, spctl = 0, running = false, answer = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sinawi-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apps = join(root, "Applications");
  await mkdir(apps);
  const calls: string[][] = [];
  const asked: string[] = [];
  const logs: string[] = [];
  const deps = {
    platform: "darwin", pid: 4242,
    tmp: () => mkdtemp(join(root, "work-")),
    log: (line: string) => { logs.push(line); },
    confirm: async (question: string) => { asked.push(question); return answer; },
    fetch: async (url: string) => {
      calls.push(["fetch", url]);
      return { ok: true, status: 200, json: async () => ({ tag_name: "v1.4.0", assets: [{ name: "Sinawi_1.4.0_universal.dmg", browser_download_url: "https://github.com/dl/Sinawi_1.4.0_universal.dmg" }] }) };
    },
    download: async (_fetch: unknown, url: string, file: string) => { calls.push(["download", url]); await writeFile(file, "dmg"); },
    run: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "hdiutil" && args[0] === "attach") {
        const mount = args[args.indexOf("-mountpoint") + 1];
        await mkdir(join(mount, "Sinawi.app", "Contents"), { recursive: true });
        await writeFile(join(mount, "Sinawi.app", "Contents", "VERSION"), "new");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "ditto") { await cp(args[0], args[1], { recursive: true }); return { code: 0, stdout: "", stderr: "" }; }
      if (command === "codesign") return { code: codesign, stdout: "", stderr: codesign ? "a sealed resource is missing or invalid" : "" };
      if (command === "spctl") return { code: spctl, stdout: "", stderr: spctl ? "rejected" : "accepted" };
      if (command === "pgrep") return { code: running ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const installed = () => readFile(join(apps, "Sinawi.app", "Contents", "VERSION"), "utf8").catch(() => undefined);
  const leftovers = async () => (await readdir(apps)).filter((name) => name !== "Sinawi.app");
  return { root, apps, calls, asked, logs, deps, installed, leftovers };
}

test("install: downloads the universal dmg, checks codesign and Gatekeeper on the image and on the copy, installs and opens", async (t) => {
  const mac = await fakeMac(t);
  const result = await install({ ...parseArgs(["--dir", mac.apps]) }, mac.deps);
  assert.deepEqual(result, { status: "installed", target: join(mac.apps, "Sinawi.app"), version: "v1.4.0" });
  assert.equal(await mac.installed(), "new");
  assert.deepEqual(await mac.leftovers(), [], "no staging or previous copy left behind");
  const names = mac.calls.map((call) => call[0]);
  assert.deepEqual(names.filter((name) => name !== "pgrep"), ["fetch", "download", "hdiutil", "codesign", "spctl", "ditto", "codesign", "spctl", "open", "hdiutil"]);
  assert.ok(mac.calls[0][1].endsWith("/repos/Rakmlabs/sinawi/releases/latest"));
  assert.deepEqual(mac.calls.find((call) => call[0] === "codesign")!.slice(1, 4), ["--verify", "--deep", "--strict"]);
  assert.deepEqual(mac.calls.find((call) => call[0] === "spctl")!.slice(1, 4), ["-a", "-t", "exec"]);
  assert.ok(mac.calls.find((call) => call[0] === "hdiutil")!.includes("-readonly"));
  assert.deepEqual(mac.calls.at(-1)!.slice(0, 2), ["hdiutil", "detach"], "the image is always unmounted");
  assert.equal(mac.asked.length, 0, "nothing to replace, nothing to ask");
});

test("install: asks before replacing an existing app; no leaves it as is, --yes replaces it", async (t) => {
  const mac = await fakeMac(t, { answer: false });
  await mkdir(join(mac.apps, "Sinawi.app", "Contents"), { recursive: true });
  await writeFile(join(mac.apps, "Sinawi.app", "Contents", "VERSION"), "old");
  assert.deepEqual(await install({ ...parseArgs(["--dir", mac.apps, "--no-open"]) }, mac.deps), { status: "cancelled" });
  assert.equal(mac.asked.length, 1);
  assert.match(mac.asked[0], /already exists\. Replace it\?/u);
  assert.equal(await mac.installed(), "old");
  assert.ok(!mac.calls.some((call) => call[0] === "ditto"), "nothing copied");
  assert.ok(mac.logs.some((line) => /--yes/u.test(line)));

  const again = await fakeMac(t);
  await mkdir(join(again.apps, "Sinawi.app", "Contents"), { recursive: true });
  await writeFile(join(again.apps, "Sinawi.app", "Contents", "VERSION"), "old");
  const result = await install({ ...parseArgs(["--dir", again.apps, "--yes", "--no-open"]) }, again.deps);
  assert.equal(result.status, "installed");
  assert.equal(again.asked.length, 0, "--yes does not ask");
  assert.equal(await again.installed(), "new");
  assert.deepEqual(await again.leftovers(), []);
  assert.ok(!again.calls.some((call) => call[0] === "open"), "--no-open");
});

test("install: a bad signature, a Gatekeeper rejection or a running app stops before anything changes", async (t) => {
  for (const [options, pattern] of [[{ codesign: 1 }, /signature .* is not valid/u], [{ spctl: 3 }, /Gatekeeper rejected/u]] as const) {
    const mac = await fakeMac(t, options);
    await assert.rejects(install({ ...parseArgs(["--dir", mac.apps, "-y"]) }, mac.deps), pattern);
    assert.equal(await mac.installed(), undefined, "not installed");
    assert.deepEqual(await mac.leftovers(), []);
    assert.deepEqual(mac.calls.at(-1)!.slice(0, 2), ["hdiutil", "detach"]);
  }
  const busy = await fakeMac(t, { running: true });
  await mkdir(join(busy.apps, "Sinawi.app", "Contents"), { recursive: true });
  await writeFile(join(busy.apps, "Sinawi.app", "Contents", "VERSION"), "old");
  await assert.rejects(install({ ...parseArgs(["--dir", busy.apps, "-y"]) }, busy.deps), /Sinawi is running\. Quit it first/u);
  assert.equal(await busy.installed(), "old");
});

test("install: a local --dmg skips GitHub; other systems are refused", async (t) => {
  const mac = await fakeMac(t);
  const dmg = join(mac.root, "Sinawi.dmg");
  await writeFile(dmg, "dmg");
  const result = await install({ ...parseArgs(["--dir", mac.apps, "--dmg", dmg, "--no-open"]) }, mac.deps);
  assert.equal(result.status, "installed");
  assert.ok(!mac.calls.some((call) => call[0] === "fetch" || call[0] === "download"), "no network");
  assert.equal(mac.calls.find((call) => call[0] === "hdiutil")![2], dmg);
  await assert.rejects(install(parseArgs([]), { ...mac.deps, platform: "linux" }), /macOS only/u);
});

test("the sinawi package is publishable: bin, libs, README and LICENSE are packed, nothing else, no dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
  assert.equal(manifest.name, "@rakmlabs/sinawi");
  assert.equal(manifest.bin.sinawi, "bin/sinawi.mjs");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.os, ["darwin"]);
  assert.equal(manifest.private, undefined, "a private package cannot be published");
  assert.equal(manifest.dependencies, undefined, "zero dependencies");
  assert.equal(manifest.repository.directory, "packages/sinawi");
  for (const file of [BIN, BRIDGE]) {
    const source = await readFile(file, "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env node\n"), `${file} starts with a shebang`);
    assert.ok((await stat(file)).mode & 0o111, `${file} is executable`);
  }
  for (const file of [BIN, BRIDGE, join(PACKAGE, "lib", "install.mjs")]) {
    assert.doesNotMatch(await readFile(file, "utf8"), /from "(?!node:|\.\.?\/)/u, `${file} imports only node: built-ins and its own files`);
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // An empty cache and no user config: no network, nothing from this machine's npm setup.
  const cache = await mkdtemp(join(tmpdir(), "sinawi-npm-"));
  try {
    const { stdout } = await exec(npm, ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline", `--cache=${cache}`, "--userconfig=/dev/null"], { cwd: PACKAGE, env: { ...process.env, npm_config_loglevel: "silent" } });
    const [pack] = JSON.parse(stdout);
    assert.equal(pack.name, "@rakmlabs/sinawi");
    assert.equal(pack.filename, `rakmlabs-sinawi-${manifest.version}.tgz`);
    const files = pack.files as Array<{ path: string; mode: number }>;
    assert.deepEqual(files.map((file) => file.path).sort(), ["LICENSE", "README.md", "bin/sinawi.mjs", "lib/install.mjs", "lib/mcp.mjs", "package.json"]);
    assert.ok(files.find((file) => file.path === "bin/sinawi.mjs")!.mode & 0o111, "packed as executable");
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test("one bridge: the repository script, the app bundle and the server's hooks copy all use packages/sinawi/lib/mcp.mjs", async () => {
  assert.match(await readFile(join(process.cwd(), "scripts", "sinawi-mcp.mjs"), "utf8"), /import "\.\.\/packages\/sinawi\/lib\/mcp\.mjs";/u);
  const build = await readFile(join(process.cwd(), "scripts", "build-server.mjs"), "utf8");
  assert.match(build, /packages\/sinawi\/lib\/mcp\.mjs/u);
  assert.match(build, /new URL\("sinawi-mcp\.mjs", resources\)/u, "written next to server.cjs in src-tauri/resources");
  const tauri = JSON.parse(await readFile(join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(tauri.bundle.resources["resources/sinawi-mcp.mjs"], "sinawi-mcp.mjs", "Sinawi.app/Contents/Resources/sinawi-mcp.mjs");
  const root = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(root.bin.sinawi, "packages/sinawi/bin/sinawi.mjs");
  assert.equal(root.scripts["sinawi-mcp"], "node scripts/sinawi-mcp.mjs");
});
