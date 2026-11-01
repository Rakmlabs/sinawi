// User-visible labels shared by the app views; values follow the current language (see ../i18n).
import type { EventType, SessionStatus } from "../../server/types";
import { t, translatedMap } from "../i18n";

export const names: Record<string, string> = Object.defineProperties({
  codex: "Codex",
  claude: "Claude",
  grok: "Grok Build",
} as Record<string, string>, {
  user: { enumerable: true, get: () => t("names.user") },
  system: { enumerable: true, get: () => t("names.system") },
});

export const statusLabels = translatedMap<SessionStatus>({
  running: "status.running",
  done: "status.done",
  error: "status.error",
  stopped: "status.stopped",
});

export const eventLabels = translatedMap<EventType>({
  message: "event.message",
  tool: "event.tool",
  command: "event.command",
  edit: "event.edit",
  status: "event.status",
  error: "event.error",
  warning: "event.warning",
  delegation: "event.delegation",
  handoff: "event.handoff",
});

// Composer prefills: the user sees and edits these before sending, so they follow the UI language.
export function promptChips(): [label: string, text: string][] {
  return [
    [t("chips.buildApp"), t("chips.buildAppText")],
    [t("chips.exploreCode"), t("chips.exploreCodeText")],
    [t("chips.team"), t("chips.teamText")],
  ];
}
