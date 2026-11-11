import { useCallback, useEffect, useRef, useState } from "react";
import { isNearChatBottom, scrollsUpKey } from "../chat-scroll";

/** How long a smooth "jump to bottom" may take before its scroll guard lifts anyway (no `scrollend`). */
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 1_000;
/** Back this close to the bottom, following resumes (smaller than the button's tolerance on purpose). */
const REARM_DISTANCE_PX = 24;

/**
 * Chat pinning: follow the bottom while the user is already there (including late layout growth
 * from images and code), and offer a "jump to bottom" button otherwise.
 *
 * A streaming reply grows the chat every frame, and the ResizeObserver snaps back to the bottom
 * while following. A position check alone cannot tell the user's own scroll apart from that growth
 * (one wheel tick stays inside the near-bottom tolerance), so upward intent (wheel, touch, keys, or
 * scrollTop going down without us moving it) stops following at once. Returning near the bottom
 * re-arms it.
 */
export function useChatScroll({ resetKey, followKey, observeKey }: { resetKey: unknown[]; followKey: unknown[]; observeKey: unknown[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  const chatBody = useRef<HTMLDivElement>(null);
  const followsChatBottom = useRef(true);
  /** Set while our own smooth scroll runs: its intermediate scroll events are not the user's. */
  const programmatic = useRef<{ timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastScrollTop = useRef(0);
  const [showChatBottom, setShowChatBottom] = useState(false);
  const endProgrammatic = useCallback(() => {
    if (!programmatic.current) return;
    clearTimeout(programmatic.current.timer);
    programmatic.current = null;
  }, []);
  const stopFollowing = useCallback(() => {
    const body = chatBody.current;
    // Nothing to scroll back to (a short chat): keep following, or growth would never be tracked again.
    if (body && body.scrollHeight <= body.clientHeight + 2) return;
    endProgrammatic();
    followsChatBottom.current = false;
    setShowChatBottom(true);
  }, [endProgrammatic]);
  const scrollToChatBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const body = chatBody.current;
    followsChatBottom.current = true;
    setShowChatBottom(false);
    if (behavior === "smooth") {
      endProgrammatic();
      programmatic.current = { timer: setTimeout(endProgrammatic, PROGRAMMATIC_SCROLL_TIMEOUT_MS) };
    }
    if (body) body.scrollTo({ top: body.scrollHeight, behavior });
    else bottom.current?.scrollIntoView({ behavior, block: "nearest" });
    if (body) lastScrollTop.current = body.scrollTop;
  }, [endProgrammatic]);
  useEffect(() => {
    followsChatBottom.current = true;
    setShowChatBottom(false);
    const frame = requestAnimationFrame(() => scrollToChatBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [...resetKey, scrollToChatBottom]);
  useEffect(() => {
    if (followsChatBottom.current) scrollToChatBottom("auto");
  }, [...followKey, scrollToChatBottom]);
  useEffect(() => {
    const body = chatBody.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // During a smooth jump the browser is already heading down; snapping would cut it short.
      if (followsChatBottom.current && !programmatic.current) { body.scrollTop = body.scrollHeight; lastScrollTop.current = body.scrollTop; }
    });
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, observeKey);
  useEffect(() => endProgrammatic, [endProgrammatic]);
  const onChatScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const body = event.currentTarget;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    const movedUp = body.scrollTop < lastScrollTop.current - 1;
    lastScrollTop.current = body.scrollTop;
    if (programmatic.current) {
      // Our own smooth scroll: keep following and the button hidden until it lands.
      if (distance > 2) return;
      endProgrammatic();
    }
    // Moving up off the very bottom is the user (a scrollbar drag too); the browser clamping
    // scrollTop when content shrinks keeps the distance at zero and does not count.
    if (movedUp && distance > 2) followsChatBottom.current = false;
    else if (isNearChatBottom(body, REARM_DISTANCE_PX)) followsChatBottom.current = true;
    setShowChatBottom(!followsChatBottom.current && !isNearChatBottom(body));
  };
  // Upward intent, as React props on the chat body (it remounts when the tab changes).
  const touchY = useRef<number | undefined>(undefined);
  const chatScrollHandlers = {
    onScroll: onChatScroll,
    onScrollEnd: endProgrammatic,
    onWheel: (event: React.WheelEvent<HTMLDivElement>) => { if (event.deltaY < 0) stopFollowing(); },
    onTouchStart: (event: React.TouchEvent<HTMLDivElement>) => { touchY.current = event.touches[0]?.clientY; },
    // A finger moving down drags the content down: the user is reading back.
    onTouchMove: (event: React.TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY;
      if (touchY.current !== undefined && y !== undefined && y > touchY.current + 2) stopFollowing();
      touchY.current = y;
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => { if (scrollsUpKey(event)) stopFollowing(); },
  };
  return { bottom, chatBody, showChatBottom, scrollToChatBottom, chatScrollHandlers };
}
