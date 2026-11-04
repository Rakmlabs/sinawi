import { replacedRange } from "../composer-lists";

/**
 * Applies an edit to the textarea synchronously, before the next key can arrive: the change goes in
 * through the editing commands (native undo keeps working) and fires `input`, so React state follows
 * through onChange; the caret is set right away instead of after a render.
 */
export function applyFieldEdit(field: HTMLTextAreaElement, next: string, caret: number) {
  if (field.value !== next) {
    const { start, end, text } = replacedRange(field.value, next);
    field.focus();
    field.setSelectionRange(start, end);
    const applied = text
      ? document.execCommand("insertText", false, text)
      : start === end || document.execCommand("delete");
    if (!applied) {
      // setRangeText bypasses React's value tracker, so the dispatched input still reaches onChange.
      field.setRangeText(text, start, end, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  field.setSelectionRange(caret, caret);
}
