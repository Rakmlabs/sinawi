// `npx @rakmlabs/sinawi`: installs (or updates) Sinawi.app from the latest GitHub release on macOS.
//
//   1. GET https://api.github.com/repos/Rakmlabs/sinawi/releases/latest, pick the universal .dmg
//   2. download it to a temporary folder, mount it read-only
//   3. check the app on the disk image: `codesign --verify --deep --strict` and `spctl -a -t exec`
//   4. ask before replacing an existing Sinawi.app (--yes skips the question)
//   5. copy it next to the target with `ditto`, check the copy again, swap it in, open it
//
// Every outside effect goes through `deps`, so the tests run the whole flow without network,
// disk images or /Applications. No dependencies: node: built-ins only.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "Rakmlabs/sinawi";
export const APP = "Sinawi.app";
export const DEFAULT_DIR = "/Applications";

export const HELP = `Usage: npx @rakmlabs/sinawi [install] [options]
       npx @rakmlabs/sinawi mcp

Commands:
  install (default)  Download the latest Sinawi release, check its signature and install it (macOS)
  mcp                Run the stdio MCP bridge to a running Sinawi app (for Claude Desktop, Cursor, ...)

Install options:
  -y, --yes          Replace an existing Sinawi.app without asking
      --no-open      Do not open Sinawi after installing
      --dmg <file>   Install from a .dmg you already downloaded
      --dir <folder> Install into this folder instead of /Applications

  -h, --help         Show this help
  -v, --version      Show the version of this package

MCP bridge environment: SINAWI_URL, SINAWI_PORT, SINAWI_MCP_TOKEN, SINAWI_MCP_TOKEN_FILE, SINAWI_DATA_DIR.
More: https://github.com/${REPO}#readme`;

/** argv (without node and the script) → what to do. Unknown input comes back as `error`. */
export function parseArgs(argv) {
  const result = { command: "install", yes: false, open: true, dmg: undefined, dir: DEFAULT_DIR, error: undefined };
  const rest = [...argv];
  if (rest[0] === "mcp") return { ...result, command: "mcp" };
  if (rest[0] === "install") rest.shift();
  else if (rest[0] === "help") return { ...result, command: "help" };
  while (rest.length) {
    const arg = rest.shift();
    const value = () => {
      const next = rest.shift();
      if (!next || next.startsWith("-")) { result.error = `${arg} needs a value`; return undefined; }
      return next;
    };
    if (arg === "-h" || arg === "--help") return { ...result, command: "help", error: undefined };
    if (arg === "-v" || arg === "--version") return { ...result, command: "version", error: undefined };
    if (arg === "-y" || arg === "--yes") result.yes = true;
    else if (arg === "--no-open") result.open = false;
    else if (arg === "--dmg") result.dmg = value();
    else if (arg === "--dir") result.dir = value() ?? result.dir;
    else result.error = arg.startsWith("-") ? `unknown option ${arg}` : `unknown command ${arg}`;
    if (result.error) return result;
  }
  return result;
}

/** The disk image of a GitHub release: the universal one when there is one. */
export function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const dmgs = assets.filter((asset) => typeof asset?.name === "string" && asset.name.endsWith(".dmg") && asset.browser_download_url);
  const asset = dmgs.find((item) => /_universal\.dmg$/u.test(item.name)) ?? dmgs[0];
  if (!asset) throw new Error(`The latest release${release?.tag_name ? ` (${release.tag_name})` : ""} has no .dmg to install.`);
  return { name: asset.name, url: asset.browser_download_url, version: typeof release.tag_name === "string" ? release.tag_name : undefined };
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error.message ?? error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(`${question} [y/N] `, (answer) => { rl.close(); resolve(/^y(es)?$/iu.test(answer.trim())); }));
}

async function download(fetchImpl, url, file) {
  const res = await fetchImpl(url, { headers: { "user-agent": "sinawi-installer" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

const exists = (path) => access(path).then(() => true, () => false);

export const defaultDeps = () => ({
  platform: process.platform,
  pid: process.pid,
  fetch: globalThis.fetch,
  run: runCommand,
  confirm: askYesNo,
  download,
  log: (line) => process.stderr.write(`${line}\n`),
  tmp: () => mkdtemp(join(tmpdir(), "sinawi-install-")),
});

/** Throws unless macOS accepts the app: a valid, complete signature and a Gatekeeper pass (notarized). */
async function verify(run, app) {
  const sign = await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (sign.code !== 0) throw new Error(`The signature of ${app} is not valid:\n${(sign.stderr || sign.stdout).trim()}`);
  const gate = await run("spctl", ["-a", "-t", "exec", "-vv", app]);
  if (gate.code !== 0) throw new Error(`Gatekeeper rejected ${app}:\n${(gate.stderr || gate.stdout).trim()}`);
}

/**
 * Installs Sinawi.app. Resolves to { status: "installed", target, version } or { status: "cancelled" }.
 * `deps` replaces outside effects (see defaultDeps); tests pass fakes.
 */
export async function install(options, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const { run, log } = deps;
  if (deps.platform !== "darwin") throw new Error("Sinawi is a macOS app; `npx @rakmlabs/sinawi` installs it on macOS only.");
  const target = join(options.dir ?? DEFAULT_DIR, APP);
  const work = await deps.tmp();
  const mount = join(work, "mount");
  let mounted = false;
  try {
    let dmg = options.dmg;
    let version;
    if (!dmg) {
      log(`Looking up the latest release of ${REPO}…`);
      const res = await deps.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "sinawi-installer" } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release.`);
      const asset = pickAsset(await res.json());
      version = asset.version;
      dmg = join(work, basename(asset.name));
      log(`Downloading ${asset.name}…`);
      await deps.download(deps.fetch, asset.url, dmg);
    }
    const attach = await run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount]);
    if (attach.code !== 0) throw new Error(`Could not open the disk image ${dmg}:\n${attach.stderr.trim()}`);
    mounted = true;
    const source = join(mount, APP);
    if (!(await exists(source))) throw new Error(`${APP} is not on the disk image.`);
    log("Checking the signature and notarization…");
    await verify(run, source);

    if (await exists(target)) {
      if ((await run("pgrep", ["-x", "Sinawi"])).code === 0) throw new Error("Sinawi is running. Quit it first (Sinawi → Quit), then run this again.");
      if (!options.yes && !(await deps.confirm(`${target} already exists. Replace it?`))) {
        log("Nothing changed. Run with --yes to replace it without asking.");
        return { status: "cancelled" };
      }
    }
    const staging = join(options.dir ?? DEFAULT_DIR, `.${APP}.installing-${deps.pid}`);
    const previous = join(options.dir ?? DEFAULT_DIR, `.${APP}.previous-${deps.pid}`);
    await rm(staging, { recursive: true, force: true });
    log(`Installing to ${target}…`);
    const copy = await run("ditto", [source, staging]);
    if (copy.code !== 0) { await rm(staging, { recursive: true, force: true }); throw new Error(`Copying the app failed:\n${copy.stderr.trim()}`); }
    try { await verify(run, staging); } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    const hadTarget = await exists(target);
    if (hadTarget) await rename(target, previous);
    try { await rename(staging, target); }
    catch (error) { if (hadTarget) await rename(previous, target); await rm(staging, { recursive: true, force: true }); throw error; }
    if (hadTarget) await rm(previous, { recursive: true, force: true });
    log(`Installed ${APP}${version ? ` ${version}` : ""}.`);
    if (options.open) await run("open", [target]);
    return { status: "installed", target, version };
  } finally {
    if (mounted) await run("hdiutil", ["detach", mount, "-quiet"]);
    await rm(work, { recursive: true, force: true });
  }
}
