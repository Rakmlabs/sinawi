import type { Session } from "../../server/types";
import { currentActivity, quietState } from "../run-activity";
import { t } from "../i18n";
import { useNow } from "./clock";

function elapsedLabel(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? t("run.quietMinutes", { minutes, seconds }) : t("run.quietSeconds", { seconds });
}

/** Leaf clock: what the team is running right now ("waiting for the deploy… 3m"), else "thinking… 42s". */
export function QuietIndicator({ session }: { session: Pick<Session, "status" | "events" | "lastActivityAt"> }) {
  const now = useNow(1_000, session.status === "running");
  const activity = currentActivity(session);
  if (activity) {
    const who = activity.who === "lead" ? t("run.lead") : activity.who;
    const elapsed = elapsedLabel(Math.max(0, Math.floor((now - Date.parse(activity.since)) / 1_000)));
    return <span className="quiet-indicator" title={activity.text}>
      {activity.kind === "deploy" ? t("run.waitingDeploy", { who, elapsed }) : t("run.runningTool", { who, tool: activity.text, elapsed })}
    </span>;
  }
  const quiet = quietState(session, now);
  if (!quiet) return null;
  const elapsed = elapsedLabel(quiet.seconds);
  return <span className="quiet-indicator" title={quiet.alive ? t("run.thinkingHint") : t("run.waitingHint")}>
    {quiet.alive ? t("run.thinking", { elapsed }) : t("run.waiting", { elapsed })}
  </span>;
}
