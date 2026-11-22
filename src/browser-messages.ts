/** postMessage trust rules between the app and its preview iframes. */

export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

type TabLike = { proxied?: boolean; proxyOrigin?: string };

type PortLike = { postMessage(message: unknown): void; close(): void; onmessage: ((event: { data: unknown }) => void) | null };
type ChannelLike = { port1: PortLike; port2: unknown };
type WindowLike = { postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void };

/**
 * Opens a private channel to a proxied preview frame (L6): the injected script keeps the port and
 * hides the connect message from the page, so only it can talk to the app. Messages from the frame
 * arrive in `onMessage`; the returned port sends commands. A page that posts to the app window
 * directly is no longer heard.
 */
export function connectPreview(frame: WindowLike, targetOrigin: string, onMessage: (data: Record<string, unknown>) => void, channel: ChannelLike = new MessageChannel() as unknown as ChannelLike): PortLike {
  channel.port1.onmessage = (event) => {
    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.source === "orchestra-preview") onMessage(data);
  };
  frame.postMessage({ source: "orchestra-parent", type: "connect" }, targetOrigin, [channel.port2]);
  return channel.port1;
}

/** Target origin for app → frame messages: the proxy origin, so nothing leaks once a page navigates away. */
export function previewTargetOrigin(tab: TabLike | undefined): string | undefined {
  return tab?.proxied && tab.proxyOrigin ? tab.proxyOrigin : undefined;
}
