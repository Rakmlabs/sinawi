import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Bounded, symlink-free fallback for both Git and non-Git working folders. */
export async function discoverFiles(cwd: string, query: string): Promise<string[]> {
  const root = resolve(cwd);
  if (!(await stat(root)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
  const matches: string[] = [];
  const pending = [""];
  const normalized = query.toLocaleLowerCase();
  let visited = 0;
  while (pending.length && matches.length < 50 && visited < 20_000) {
    const relative = pending.shift()!;
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch((error) => {
      if (!relative) throw error;
      return [];
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 20_000 || matches.length >= 50) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && path.toLocaleLowerCase().includes(normalized)) matches.push(path);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}
