import type { SkillInfo } from "../server/types";

export function slashToken(text: string, cursor: number) {
  const match = /^\/([^\s/]*)$/.exec(text.slice(0, cursor));
  return match ? { start: 0, end: cursor, query: match[1] } : undefined;
}

export function fileToken(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : undefined;
}

/** Skills matching a `/query`, best first: name prefix, then name substring, then description/source. */
export function matchingSkills(skills: SkillInfo[], query: string) {
  const normalized = query.toLocaleLowerCase();
  const rank = (skill: SkillInfo) => {
    const name = skill.name.toLocaleLowerCase();
    // "oh-my-claudecode:ask" also matches "ask" as a prefix of its last segment.
    if (name.startsWith(normalized) || name.split(":").at(-1)!.startsWith(normalized)) return 0;
    if (name.includes(normalized)) return 1;
    return `${skill.source} ${skill.description}`.toLocaleLowerCase().includes(normalized) ? 2 : -1;
  };
  return skills.map((skill, index) => ({ skill, index, score: rank(skill) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.skill);
}

/** Built-in `/` commands, like Claude Code's: handled by the app, never sent to an agent. */
export const SLASH_COMMANDS = ["clear", "compact", "usage"] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export function matchingCommands(query: string): SlashCommand[] {
  const normalized = query.toLocaleLowerCase();
  return SLASH_COMMANDS.filter((command) => command.startsWith(normalized));
}

/** The command a whole message names (`/clear`), if any. */
export function slashCommandOf(text: string): SlashCommand | undefined {
  const name = text.trim().match(/^\/([a-z]+)$/u)?.[1];
  return SLASH_COMMANDS.find((command) => command === name);
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

/** How long the stop button ignores clicks after it replaced the send button under the cursor. */
export const STOP_CLICK_GRACE_MS = 1_500;
export function stopClickAllowed(stopSince: number, now: number): boolean {
  return stopSince > 0 && now - stopSince >= STOP_CLICK_GRACE_MS;
}

/** A running session must keep accepting typing even if another request set the app busy. */
export function composerLocked(running: boolean, busy: boolean): boolean {
  return busy && !running;
}

/**
 * Reply buttons for a message that asks the user to pick: the numbered list must close the message
 * and a question must introduce or follow it. Reports also end in numbered lists (evidence, findings);
 * without the question those stay plain text instead of turning into a choice the model never offered.
 */
export function numberedOptions(text: string): string[] {
  type Block = { options: string[]; before: string; end: number };
  const lines = text.split("\n");
  let current: Array<{ number: number; text: string }> = [];
  let currentBefore = "";
  let lastText = "";
  let latest: Block | undefined;
  let fenced = false;
  const finishBlock = (end: number) => {
    if (current.length >= 2 && current.every((option, index) => option.number === index + 1)) {
      latest = { options: current.map((option) => option.text), before: currentBefore, end };
    }
    current = [];
  };
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { finishBlock(index); fenced = !fenced; lastText = line; return; }
    if (fenced || !line.trim()) return;
    const match = /^\s*([1-9])[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) { finishBlock(index); lastText = line; return; }
    const option = { number: Number(match[1]), text: match[2] };
    if (option.number === 1) {
      finishBlock(index);
      current = [option];
      currentBefore = lastText;
    } else if (current.length && option.number === current.at(-1)!.number + 1) {
      current.push(option);
    } else {
      current = [];
    }
    lastText = line;
  });
  finishBlock(lines.length);
  if (!latest) return [];
  const after = lines.slice(latest.end).join("\n").trim();
  const asks = (value: string) => /[?？]\W*$/u.test(value.trim());
  if (after ? !asks(after) || after.split("\n").length > 2 : !asks(latest.before)) return [];
  return latest.options;
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

// Marker + required space, so a bare "-" or "1." typed mid-sentence is never treated as a list item.
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))[ \t](\[[ xX]\][ \t])?/;

function lineBounds(value: string, from: number, to: number) {
  return { start: value.lastIndexOf("\n", from - 1) + 1, end: (() => { const i = value.indexOf("\n", to); return i < 0 ? value.length : i; })() };
}

/** Shift+Enter inside a Markdown list item: continue the list, or end it when the item is empty. */
export function continueListOnNewline(value: string, selectionStart: number, selectionEnd: number): { value: string; caret: number } | undefined {
  const { start, end } = lineBounds(value, selectionStart, selectionEnd);
  const line = value.slice(start, end);
  const match = LIST_ITEM.exec(line);
  if (!match) return undefined;
  // Caret inside the marker itself (or in the indentation): plain newline.
  if (selectionStart - start < match[0].length) return undefined;
  if (selectionStart === selectionEnd && !line.slice(match[0].length).trim()) {
    return { value: value.slice(0, start) + value.slice(end), caret: start };
  }
  const [, indent, bullet, digits, delimiter, checkbox] = match;
  const marker = bullet ?? `${Number(digits) + 1}${delimiter}`;
  const prefix = `${indent}${marker} ${checkbox ? "[ ] " : ""}`;
  return { value: value.slice(0, selectionStart) + "\n" + prefix + value.slice(selectionEnd), caret: selectionStart + 1 + prefix.length };
}

/** Tab / Shift+Tab on a list item line: indent or outdent by two spaces. */
export function indentListLine(value: string, selectionStart: number, outdent: boolean): { value: string; caret: number } | undefined {
  const { start, end } = lineBounds(value, selectionStart, selectionStart);
  const line = value.slice(start, end);
  if (!LIST_ITEM.test(line)) return undefined;
  if (!outdent) return { value: value.slice(0, start) + "  " + value.slice(start), caret: selectionStart + 2 };
  const remove = /^(?: {1,2}|\t)/.exec(line)?.[0].length ?? 0;
  return { value: value.slice(0, start) + value.slice(start + remove), caret: Math.max(start, selectionStart - remove) };
}
