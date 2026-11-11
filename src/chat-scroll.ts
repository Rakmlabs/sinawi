type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function isNearChatBottom(metrics: ScrollMetrics, tolerance = 120): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= tolerance;
}

/** A key that scrolls the chat up (reading back), unless typed into a field. */
export function scrollsUpKey(event: Pick<KeyboardEvent, "key" | "target" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.altKey || event.ctrlKey) return false;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (target && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/u.test(target.tagName ?? ""))) return false;
  if (event.metaKey) return event.key === "ArrowUp";
  return event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home";
}

type ChatEvent = { id: string; type: string; agent: string; aside?: boolean };

export function streamingAssistantMessageId(events: ChatEvent[], running: boolean): string | undefined {
  if (!running) return undefined;
  let latestUser = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "message" && events[index].agent === "user" && !events[index].aside) {
      latestUser = index;
      break;
    }
  }
  if (latestUser < 0) return undefined;
  for (let index = events.length - 1; index > latestUser; index -= 1) {
    if (events[index].type === "message" && events[index].agent !== "user" && !events[index].aside) return events[index].id;
  }
  return undefined;
}
