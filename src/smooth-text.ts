import { useEffect, useRef, useState } from "react";

/**
 * Streamed text arrives in bursts (a network push every ~50 ms, several words at a time). Revealing
 * it at a steady pace that speeds up with the backlog reads like Claude / ChatGPT instead of jumping.
 * `catchUpMs` is roughly how long a backlog takes to drain.
 */
export function nextRevealLength(shown: number, target: string, elapsedMs: number, catchUpMs = 180): number {
  const backlog = target.length - shown;
  if (backlog <= 0) return target.length;
  let next = shown + Math.max(1, Math.ceil(backlog * Math.min(1, elapsedMs / catchUpMs)));
  if (next >= target.length) return target.length;
  // Never cut a surrogate pair (emoji) in half.
  const code = target.charCodeAt(next - 1);
  if (code >= 0xd800 && code <= 0xdbff) next++;
  return next;
}

/** Length of the part of `shown` that `target` still starts with (a draft can be replaced). */
export function keptPrefix(shownText: string, target: string): number {
  if (target.startsWith(shownText)) return shownText.length;
  let index = 0;
  while (index < shownText.length && index < target.length && shownText[index] === target[index]) index++;
  return index;
}

/** `text` revealed smoothly, one animation frame at a time. */
export function useSmoothText(text: string): string {
  const [shown, setShown] = useState(0);
  const state = useRef({ shown: 0, text: "" });
  useEffect(() => {
    const kept = keptPrefix(state.current.text.slice(0, state.current.shown), text);
    state.current = { shown: kept, text };
    if (kept !== shown) setShown(kept);
    if (kept >= text.length) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = nextRevealLength(state.current.shown, text, now - last);
      last = now;
      state.current.shown = next;
      setShown(next);
      if (next < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown` is read through the ref
  }, [text]);
  return text.slice(0, Math.min(shown, text.length));
}
