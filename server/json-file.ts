import { mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Reads a JSON data file. A missing file yields undefined. A file that cannot be parsed,
// or does not have the expected shape, is moved aside to `<file>.corrupt-<time>` before
// returning undefined, so the next save cannot silently overwrite the only copy.
export async function readJsonFile(file: string, valid: (value: unknown) => boolean = () => true): Promise<unknown> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { parsed = undefined; }
  if (parsed !== undefined && valid(parsed)) return parsed;
  await quarantine(file);
  return undefined;
}

async function quarantine(file: string) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await rename(file, backup);
    console.error(`손상된 데이터 파일을 ${backup}(으)로 옮겼습니다.`);
  } catch (error) {
    // If the file cannot be moved aside, refuse to continue rather than overwrite it later.
    throw new Error(`손상된 데이터 파일을 보존하지 못했습니다: ${file}`, { cause: error });
  }
}

// Writes through a synced temporary file and renames it over the target.
export async function writeJsonFile(file: string, value: unknown, space?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(space ? `${JSON.stringify(value, null, space)}\n` : JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export const isArray = (value: unknown) => Array.isArray(value);
export const isPlainObject = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
