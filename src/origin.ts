// Who gave the work when it was not the user typing in the app (server/types.ts RequestOrigin):
// an outside AI over MCP, or another lead. Known MCP client ids get their product name.
import type { RequestOrigin } from "../server/types";

const KNOWN_CLIENTS: [RegExp, string][] = [
  [/^claude[- ]?code$/iu, "Claude Code"],
  [/^claude[- ]?(ai|desktop)$/iu, "Claude Desktop"],
  [/^codex(?:[- ]mcp[- ]client)?$/iu, "Codex"],
  [/^grok(?:[- ]?build|[- ]?cli)?$/iu, "Grok Build"],
  [/^grok[- ]?bot$/iu, "Grok Bot"],
  [/^cursor(?:[- ]vscode)?$/iu, "Cursor"],
  [/^mcp$/iu, "MCP"],
];

/** The name to show: a known client's product name, else the name the client gave. */
export function originLabel(origin: RequestOrigin | undefined): string {
  if (!origin) return "";
  const raw = origin.client.trim();
  if (origin.kind === "lead") return raw;
  return KNOWN_CLIENTS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;
}
