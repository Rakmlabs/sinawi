type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function isNearChatBottom(metrics: ScrollMetrics, tolerance = 120): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= tolerance;
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
