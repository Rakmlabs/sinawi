import type { Session } from "../../server/types";
import { quietState } from "../run-activity";
import { t } from "../i18n";
import { useNow } from "./clock";

/** Leaf clock: "thinking… 42s" while a running session is alive but shows nothing new. */
export function QuietIndicator({ session }: { session: Pick<Session, "status" | "events" | "lastActivityAt"> }) {
  const now = useNow(1_000, session.status === "running");
  const quiet = quietState(session, now);
  if (!quiet) return null;
  const minutes = Math.floor(quiet.seconds / 60);
  const seconds = quiet.seconds % 60;
  const elapsed = minutes ? t("run.quietMinutes", { minutes, seconds }) : t("run.quietSeconds", { seconds });
  return <span className="quiet-indicator" title={quiet.alive ? t("run.thinkingHint") : t("run.waitingHint")}>
    {quiet.alive ? t("run.thinking", { elapsed }) : t("run.waiting", { elapsed })}
  </span>;
}
