#!/usr/bin/env node
// Version + release helper. package.json is the single source of truth:
//   - `version`            → src-tauri/Cargo.toml, src-tauri/Cargo.lock (tauri.conf.json reads ../package.json)
//   - `repository.url`     → the updater endpoint in src-tauri/tauri.conf.json (GitHub owner/repo)
//
// Usage:
//   node scripts/release.mjs patch|minor|major|<x.y.z>  [--commit] [--tag] [--notes <file>]
//   node scripts/release.mjs sync                       # rewrite derived files from package.json
//   node scripts/release.mjs check [--tag-name vX.Y.Z] [--repo owner/name]   # CI: fail on drift
//
// Nothing is pushed. With --tag the annotated tag message (from --notes or a default) becomes the
// release notes shown in the app's update banner.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const paths = {
  pkg: `${root}package.json`,
  lock: `${root}package-lock.json`,
  cargo: `${root}src-tauri/Cargo.toml`,
  cargoLock: `${root}src-tauri/Cargo.lock`,
  tauri: `${root}src-tauri/tauri.conf.json`,
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

const read = (path) => readFileSync(path, "utf8");
const fail = (message) => { console.error(`release: ${message}`); process.exit(1); };

export function repoSlug(pkg) {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  const match = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url) ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) fail(`package.json repository must point at GitHub (got "${url}")`);
  return `${match[1]}/${match[2]}`;
}

export const endpointFor = (slug) => `https://github.com/${slug}/releases/latest/download/latest.json`;

export function bump(version, kind) {
  if (SEMVER.test(kind)) return kind;
  const [, major, minor, patch] = SEMVER.exec(version) ?? fail(`current version "${version}" is not semver`);
  const n = [Number(major), Number(minor), Number(patch)];
  if (kind === "major") return `${n[0] + 1}.0.0`;
  if (kind === "minor") return `${n[0]}.${n[1] + 1}.0`;
  if (kind === "patch") return `${n[0]}.${n[1]}.${n[2] + 1}`;
  return fail(`unknown bump "${kind}" (patch|minor|major|x.y.z)`);
}

/** [package] version in Cargo.toml (the first `version =` line after `[package]`). */
const CARGO_VERSION = /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const CARGO_LOCK_VERSION = /(\[\[package\]\]\nname = "sinawi"\nversion = ")([^"]+)(")/;
const ENDPOINT = /https:\/\/github\.com\/[^"/]+\/[^"/]+\/releases\/latest\/download\/latest\.json/g;

function derived() {
  const cargo = read(paths.cargo), cargoLock = read(paths.cargoLock), tauri = read(paths.tauri);
  return {
    cargo: CARGO_VERSION.exec(cargo)?.[2],
    cargoLock: CARGO_LOCK_VERSION.exec(cargoLock)?.[2],
    tauriVersion: JSON.parse(tauri).version,
    endpoints: JSON.parse(tauri).plugins?.updater?.endpoints ?? [],
  };
}

function sync(pkg) {
  const version = pkg.version;
  const slug = repoSlug(pkg);
  const replace = (path, pattern, value) => {
    const text = read(path);
    if (!pattern.test(text)) fail(`could not find the version in ${path}`);
    pattern.lastIndex = 0;
    writeFileSync(path, text.replace(pattern, typeof value === "function" ? value : `$1${value}$3`));
  };
  replace(paths.cargo, CARGO_VERSION, version);
  replace(paths.cargoLock, CARGO_LOCK_VERSION, version);
  // Text edits only: other keys of tauri.conf.json keep their formatting.
  replace(paths.tauri, ENDPOINT, () => endpointFor(slug));
  const lock = JSON.parse(read(paths.lock));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeFileSync(paths.lock, `${JSON.stringify(lock, null, 2)}\n`);
}

function check(pkg, { tagName, repo }) {
  const problems = [];
  const d = derived();
  if (!SEMVER.test(pkg.version)) problems.push(`package.json version "${pkg.version}" is not semver`);
  if (d.tauriVersion !== "../package.json" && d.tauriVersion !== pkg.version) problems.push(`tauri.conf.json version ${d.tauriVersion} ≠ ${pkg.version}`);
  if (d.cargo !== pkg.version) problems.push(`Cargo.toml version ${d.cargo} ≠ ${pkg.version} (run: node scripts/release.mjs sync)`);
  if (d.cargoLock !== pkg.version) problems.push(`Cargo.lock version ${d.cargoLock} ≠ ${pkg.version} (run: node scripts/release.mjs sync)`);
  const slug = repoSlug(pkg);
  if (d.endpoints.length !== 1 || d.endpoints[0] !== endpointFor(slug)) problems.push(`updater endpoint ${JSON.stringify(d.endpoints)} ≠ ${endpointFor(slug)} (run: node scripts/release.mjs sync)`);
  if (tagName && tagName !== `v${pkg.version}`) problems.push(`tag ${tagName} ≠ v${pkg.version}`);
  if (repo && repo.toLowerCase() !== slug.toLowerCase()) problems.push(`package.json repository ${slug} ≠ this GitHub repo ${repo}: the app would look for updates in the wrong place`);
  if (problems.length) fail(`\n  - ${problems.join("\n  - ")}`);
  console.log(`release: ok — v${pkg.version}, updates from ${endpointFor(slug)}`);
}

const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });

function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => rest.includes(name);
  const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const pkg = JSON.parse(read(paths.pkg));
  if (!command) fail("usage: release.mjs patch|minor|major|<x.y.z> [--commit] [--tag] [--notes file] | sync | check");
  if (command === "check") return check(pkg, { tagName: option("--tag-name"), repo: option("--repo") });
  if (command === "sync") { sync(pkg); return console.log(`release: synced v${pkg.version}`); }

  const next = bump(pkg.version, command);
  pkg.version = next;
  writeFileSync(paths.pkg, `${JSON.stringify(pkg, null, 2)}\n`);
  sync(pkg);
  check(pkg, {});
  const files = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];
  if (flag("--commit") || flag("--tag")) {
    git("add", ...files);
    git("commit", "-m", `Release v${next}`);
  }
  if (flag("--tag")) {
    const notes = option("--notes");
    git("tag", "-a", `v${next}`, ...(notes ? ["-F", notes] : ["-m", `Sinawi v${next}`]));
  }
  console.log(`\nv${next} ready. Next:\n${flag("--tag") ? "" : `  git commit -am "Release v${next}" && git tag -a v${next} -F notes.md\n`}  git push && git push origin v${next}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
