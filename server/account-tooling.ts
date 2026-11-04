import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_MD as browserSkill } from "./browser-bridge.js";
import { SKILL_MD as computerSkill } from "./computer-bridge.js";
import type { WorkspacePolicy } from "./types.js";

/** Explicit account roots use the same skills/ layout for each supported CLI. */
export async function installAccountSkills(accounts?: WorkspacePolicy["accounts"]): Promise<void> {
  for (const account of new Set(Object.values(accounts ?? {}))) {
    for (const [name, content] of [["orchestra-browser", browserSkill], ["orchestra-computer", computerSkill]]) {
      const directory = join(account, "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), content);
    }
  }
}
