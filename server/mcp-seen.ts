// Which outside AIs actually reached this server (review round 2, §6 "외부 AI 연결"): the connect page
// shows the last request each client name made since the server started, so "is it connected?" has
// an answer. Only requests that passed the token check count. Memory only: a restart starts empty.
export type McpSeen = { client: string; at: string; calls: number };

const seen = new Map<string, McpSeen>();
const MAX_CLIENTS = 20;

export function noteMcpClient(client: string, now = new Date()): void {
  const old = seen.get(client);
  seen.delete(client);
  seen.set(client, { client, at: now.toISOString(), calls: (old?.calls ?? 0) + 1 });
  // Oldest first in a Map: drop the least recent beyond the cap.
  while (seen.size > MAX_CLIENTS) seen.delete(seen.keys().next().value!);
}

/** Most recent first. */
export function mcpClientsSeen(): McpSeen[] { return [...seen.values()].reverse(); }

export function forgetMcpClients(): void { seen.clear(); }
