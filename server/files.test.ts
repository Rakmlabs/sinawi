import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Express } from "express";
import { createServer } from "./server.js";
import { discoverFiles } from "./files.js";

test("file completion filters paths and excludes dependencies, git and symlink traversal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-files-"));
  try {
    for (const folder of ["src", "node_modules", ".git", "nested/node_modules"]) await mkdir(join(cwd, folder), { recursive: true });
    for (const file of ["src/App.tsx", "README.md", "node_modules/secret.ts", ".git/config", "nested/node_modules/hidden.ts"]) await writeFile(join(cwd, file), "");
    await symlink(join(cwd, "src"), join(cwd, "link"));
    assert.deepEqual(await discoverFiles(cwd, "APP"), ["src/App.tsx"]);
    assert.deepEqual(await discoverFiles(cwd, ""), ["README.md", "src/App.tsx"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("file completion returns at most fifty matches and rejects missing roots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-files-"));
  try {
    await Promise.all(Array.from({length: 60}, (_, i) => writeFile(join(cwd, `file-${i}.ts`), "")));
    assert.equal((await discoverFiles(cwd, "file-")).length, 50);
    await assert.rejects(discoverFiles(join(cwd, "missing"), ""));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req); res.assignSocket(socket as never); res.on("error", reject); socket.on("error", reject);
    res.on("finish", () => {
      try {
        const payload = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : undefined });
      } catch (error) { reject(error); } finally { socket.destroy(); }
    });
    app(req, res); if (json) req.push(json); req.complete = true; req.push(null);
  });
}


test("files API returns matching relative paths and rejects malformed queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-files-api-"));
  await writeFile(join(directory, "app.ts"), "");
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("fixture"); } });
  try {
    const response = await request(app, "GET", `/api/files?cwd=${encodeURIComponent(directory)}&q=app`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { files: ["app.ts"] });
    assert.equal((await request(app, "GET", "/api/files?q=a&q=b")).status, 400);
    assert.equal((await request(app, "GET", `/api/files?cwd=${encodeURIComponent(join(directory, "missing"))}`)).status, 400);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});
