#!/usr/bin/env node
// Writes the updater manifest (latest.json) for a release, or refreshes its notes.
//   node scripts/latest-json.mjs --repo owner/name --tag vX.Y.Z --assets release-assets --notes notes.md
//   node scripts/latest-json.mjs --refresh latest.json --notes notes.md
// The universal tarball serves both darwin-aarch64 and darwin-x86_64.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const required = (name) => option(name) ?? (console.error(`latest-json: ${name} is required`), process.exit(1));
const notesFile = option("--notes");
const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : "";

const refresh = option("--refresh");
if (refresh) {
  const manifest = JSON.parse(readFileSync(refresh, "utf8"));
  manifest.notes = notes;
  writeFileSync(refresh, `${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(0);
}

const repo = required("--repo"), tag = required("--tag"), dir = required("--assets");
const tarball = readdirSync(dir).find((file) => file.endsWith(".app.tar.gz"));
if (!tarball) { console.error(`latest-json: no .app.tar.gz in ${dir}`); process.exit(1); }
const platform = {
  signature: readFileSync(join(dir, `${tarball}.sig`), "utf8").trim(),
  url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(tarball)}`,
};
const manifest = {
  version: tag.replace(/^v/, ""),
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
};
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest-json: ${manifest.version} → ${platform.url}`);
