/**
 * Markdown list editing for the composer textarea. Pure functions over (text, selection) so the
 * component only applies the returned value and caret. The text stays plain Markdown: what the user
 * sees is exactly what is sent.
 */

export type ListItem = {
  /** Offset of the line in the whole text. */
  lineStart: number;
  lineEnd: number;
  /** Leading spaces/tabs. */
  indent: string;
  /** `-`, `*`, `+`, or `3.` / `3)`. */
  marker: string;
  ordered: boolean;
  number?: number;
  delimiter?: "." | ")";
  /** `[ ] ` / `[x] ` after the marker, if any. */
  checkbox: string;
  /** Column where the item's text starts (after marker, space and checkbox). */
  contentStart: number;
  /** The item has no text yet. */
  empty: boolean;
};

export type ListEdit = { value: string; caret: number };

// Marker + required space, so a bare "-" or "1." typed mid-sentence is never treated as a list item.
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t](\[[ xX]\][ \t])?/;

function lineBounds(value: string, from: number, to = from) {
  const start = value.lastIndexOf("\n", from - 1) + 1;
  const newline = value.indexOf("\n", to);
  return { start, end: newline < 0 ? value.length : newline };
}

function parseLine(value: string, start: number, end: number): ListItem | undefined {
  const line = value.slice(start, end);
  const match = LIST_ITEM.exec(line);
  if (!match) return undefined;
  const [whole, indent, bullet, digits, delimiter, checkbox = ""] = match;
  return {
    lineStart: start,
    lineEnd: end,
    indent,
    marker: bullet ?? `${digits}${delimiter}`,
    ordered: !bullet,
    number: digits === undefined ? undefined : Number(digits),
    delimiter: delimiter as ListItem["delimiter"],
    checkbox,
    contentStart: whole.length,
    empty: !line.slice(whole.length).trim(),
  };
}

/** The list item on the caret's line, if that line is one. */
export function listItemAt(value: string, caret: number): ListItem | undefined {
  const { start, end } = lineBounds(value, caret);
  return parseLine(value, start, end);
}

/**
 * Korean/Japanese/Chinese IME: the key that commits a composition must not also send, continue a list
 * or indent. WebKit (the Tauri webview) reports that key with `isComposing === false` but keyCode 229.
 */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

/** List items above `lineStart` that belong to the same list block, nearest first. */
function itemsAbove(value: string, lineStart: number): ListItem[] {
  const items: ListItem[] = [];
  let end = lineStart - 1;
  while (end >= 0) {
    const start = value.lastIndexOf("\n", end - 1) + 1;
    const item = parseLine(value, start, end);
    const line = value.slice(start, end);
    if (item) items.push(item);
    // Blank lines and indented continuation text stay inside the list; anything else ends it.
    else if (line.trim() && !/^[ \t]/.test(line)) break;
    end = start - 1;
  }
  return items;
}

const width = (indent: string) => indent.replace(/\t/g, "    ").length;

function rewriteItem(value: string, item: ListItem, caret: number, indent: number, marker: string): ListEdit {
  const oldPrefix = item.indent.length + item.marker.length;
  const prefix = " ".repeat(indent) + marker;
  const line = prefix + value.slice(item.lineStart + oldPrefix, item.lineEnd);
  const offset = caret - item.lineStart;
  const delta = prefix.length - oldPrefix;
  const contentStart = item.contentStart + delta;
  return {
    value: value.slice(0, item.lineStart) + line + value.slice(item.lineEnd),
    caret: item.lineStart + (offset >= item.contentStart ? offset + delta : contentStart),
  };
}

const orderedMarker = (item: ListItem, number: number) => `${number}${item.delimiter ?? "."}`;

/**
 * Tab / Shift+Tab on a list item. Indent nests the item under the previous sibling, aligned to that
 * sibling's text column (so `1. ` nests by three spaces and still renders as a sublist); a numbered item
 * restarts or continues the numbering at its new level. Returns the text unchanged when the item cannot
 * move (first item, already top level), so Tab never jumps focus out of a list.
 */
export function indentListLine(value: string, selectionStart: number, outdent: boolean): ListEdit | undefined {
  const item = listItemAt(value, selectionStart);
  if (!item) return undefined;
  const unchanged = { value, caret: selectionStart };
  const current = width(item.indent);
  const above = itemsAbove(value, item.lineStart);
  if (!outdent) {
    const sibling = above.find((other) => width(other.indent) <= current);
    if (!sibling || width(sibling.indent) !== current) return unchanged;
    const target = sibling.contentStart - sibling.checkbox.length;
    const before = above.slice(0, above.indexOf(sibling));
    const previous = before.find((other) => width(other.indent) === target);
    const marker = item.ordered ? orderedMarker(item, previous?.ordered && previous.number ? previous.number + 1 : 1) : item.marker;
    return rewriteItem(value, item, selectionStart, target, marker);
  }
  if (current === 0) return unchanged;
  const parent = above.find((other) => width(other.indent) < current);
  const target = parent ? width(parent.indent) : 0;
  const marker = item.ordered && parent?.ordered && parent.number !== undefined ? orderedMarker(item, parent.number + 1) : item.marker;
  return rewriteItem(value, item, selectionStart, target, marker);
}

/**
 * Shift+Enter inside a list item: continue the list on the next line (`2.` after `1.`, the same bullet,
 * an unchecked box after a task). On an empty item it ends that level instead: a nested item moves out
 * one level, a top-level item loses its marker.
 */
export function continueListOnNewline(value: string, selectionStart: number, selectionEnd: number): ListEdit | undefined {
  const { start, end } = lineBounds(value, selectionStart, selectionEnd);
  const item = parseLine(value, start, end);
  if (!item) return undefined;
  // Caret inside the marker itself (or in the indentation): plain newline.
  if (selectionStart - start < item.contentStart) return undefined;
  if (selectionStart === selectionEnd && item.empty) {
    if (width(item.indent) > 0) return indentListLine(value, selectionStart, true);
    // The marker goes; after a list a blank line follows, so the next text is not read as part of the last item.
    if (start === 0) return { value: value.slice(end), caret: 0 };
    return { value: value.slice(0, start) + "\n" + value.slice(end), caret: start + 1 };
  }
  const marker = item.ordered ? orderedMarker(item, (item.number ?? 0) + 1) : item.marker;
  const prefix = `${item.indent}${marker} ${item.checkbox ? "[ ] " : ""}`;
  return { value: value.slice(0, selectionStart) + "\n" + prefix + value.slice(selectionEnd), caret: selectionStart + 1 + prefix.length };
}

/**
 * The smallest single replacement that turns `before` into `after`, so an edit can be applied to the
 * textarea in place (keeps native undo and never resets the caret mid-typing).
 */
export function replacedRange(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let tail = 0;
  while (tail < limit - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
