import { useCallback, useEffect, useRef, useState } from "react";
import { isNearChatBottom } from "../chat-scroll";

/**
 * Chat pinning: follow the bottom while the user is already there (including late layout growth
 * from images and code), and offer a "jump to bottom" button otherwise.
 */
export function useChatScroll({ resetKey, followKey, observeKey }: { resetKey: unknown[]; followKey: unknown[]; observeKey: unknown[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  const chatBody = useRef<HTMLDivElement>(null);
  const followsChatBottom = useRef(true);
  const [showChatBottom, setShowChatBottom] = useState(false);
  const scrollToChatBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const body = chatBody.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior });
    else bottom.current?.scrollIntoView({ behavior, block: "nearest" });
    followsChatBottom.current = true;
    setShowChatBottom(false);
  }, []);
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
    const observer = new ResizeObserver(() => { if (followsChatBottom.current) body.scrollTop = body.scrollHeight; });
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, observeKey);
  const onChatScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const nearBottom = isNearChatBottom(event.currentTarget);
    followsChatBottom.current = nearBottom;
    setShowChatBottom(!nearBottom);
  };
  return { bottom, chatBody, showChatBottom, scrollToChatBottom, onChatScroll };
}
