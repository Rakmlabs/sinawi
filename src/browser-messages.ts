/** postMessage trust rules between the app and its preview iframes. */

export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

type FrameLike = { contentWindow: unknown };
type TabLike = { id: string; proxied?: boolean; proxyOrigin?: string };

/**
 * The tab whose preview frame sent `event`, or undefined when the message must be ignored.
 * Only the injected picker script talks to the app, and it only runs in proxied pages, so a
 * message is trusted when it (1) is tagged `orchestra-preview`, (2) comes from one of our own
 * iframes' windows, and (3) has that tab's proxy origin.
 */
export function trustedPreviewSender(
  event: { data: unknown; origin: string; source: unknown },
  frames: Iterable<[string, FrameLike]>,
  tabs: readonly TabLike[],
): string | undefined {
  const data = event.data as { source?: unknown } | null;
  if (!data || typeof data !== "object" || data.source !== "orchestra-preview") return undefined;
  if (!event.source) return undefined;
  let id: string | undefined;
  for (const [frameId, frame] of frames) if (frame.contentWindow === event.source) { id = frameId; break; }
  if (!id) return undefined;
  const tab = tabs.find((item) => item.id === id);
  if (!tab?.proxied || !tab.proxyOrigin || event.origin !== tab.proxyOrigin) return undefined;
  return id;
}

/** Target origin for app → frame messages: the proxy origin, so nothing leaks once a page navigates away. */
export function previewTargetOrigin(tab: TabLike | undefined): string | undefined {
  return tab?.proxied && tab.proxyOrigin ? tab.proxyOrigin : undefined;
}
