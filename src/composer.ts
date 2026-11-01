import type { SkillInfo } from "../server/types";

export function slashToken(text: string, cursor: number) {
  const match = /^\/([^\s/]*)$/.exec(text.slice(0, cursor));
  return match ? { start: 0, end: cursor, query: match[1] } : undefined;
}

export function fileToken(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : undefined;
}

export function matchingSkills(skills: SkillInfo[], query: string) {
  const normalized = query.toLocaleLowerCase();
  return skills.filter((skill) => `${skill.name} ${skill.source} ${skill.description}`.toLocaleLowerCase().includes(normalized));
}

export function recentPaths(value: unknown, limit = 8): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.startsWith("/")))].slice(0, limit) : [];
}

export function isUsageCommand(text: string): boolean {
  return text.trim() === "/usage";
}

/** While a session is running, an empty composer keeps the stop control. A draft sends instead. */
export function composerAction(running: boolean, hasDraft: boolean): "send" | "stop" {
  return running && !hasDraft ? "stop" : "send";
}

/** A running session must keep accepting typing even if another request set the app busy. */
export function composerLocked(running: boolean, busy: boolean): boolean {
  return busy && !running;
}

export function numberedOptions(text: string): string[] {
  let current: Array<{ number: number; text: string }> = [];
  let latest: string[] = [];
  let fenced = false;
  const finishBlock = () => {
    if (current.length >= 2 && current.every((option, index) => option.number === index + 1)) {
      latest = current.map((option) => option.text);
    }
    current = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { finishBlock(); fenced = !fenced; continue; }
    if (fenced || !line.trim()) continue;
    const match = /^\s*([1-9])[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) { finishBlock(); continue; }
    const option = { number: Number(match[1]), text: match[2] };
    if (option.number === 1) {
      finishBlock();
      current = [option];
    } else if (current.length && option.number === current.at(-1)!.number + 1) {
      current.push(option);
    } else {
      current = [];
    }
  }
  finishBlock();
  return latest;
}

export function handlesCompletionKey(key: string, shiftKey: boolean): boolean {
  return ["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab"].includes(key) && !(key === "Enter" && shiftKey);
}

export function historyEntries(current: readonly string[], global: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...current, ...global].filter((entry) => {
    const value = entry.trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function historyStep(entries: readonly string[], direction: -1 | 1, draft: string, currentIndex: number) {
  if (!entries.length) return { index: -1, value: draft, draft };
  if (direction === -1) {
    const index = Math.min(entries.length - 1, Math.max(-1, currentIndex) + 1);
    return { index, value: entries[index], draft };
  }
  const index = Math.max(-1, Math.min(entries.length - 1, currentIndex) - 1);
  return { index, value: index === -1 ? draft : entries[index], draft };
}
