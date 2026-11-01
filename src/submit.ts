import type { RouteRecommendation } from "../server/routing";
import type { Session, StartSessionInput } from "../server/types";

type Request = <T>(path: string, body: unknown) => Promise<T>;

/** One composer submission routes and starts the recommended team. */
export async function submitSession(
  request: Request,
  input: StartSessionInput,
  recommendation?: RouteRecommendation,
  onRouting?: (routing: boolean) => void,
): Promise<Session> {
  let selection = recommendation;
  if (input.mode === "auto" && !selection) {
    onRouting?.(true);
    try {
      selection = await request<RouteRecommendation>("/route", { prompt: input.prompt, cwd: input.cwd, skills: input.skills, workspaceId: input.workspaceId });
    } finally { onRouting?.(false); }
  }
  return request<Session>("/sessions", selection && input.mode === "auto" ? {
    ...input,
    agent: selection.orchestrator.agent,
    model: selection.orchestrator.model,
    reasoningEffort: selection.orchestrator.reasoningEffort,
    workers: selection.workers.map((worker) => worker.agent),
    workerConfigs: selection.workers,
    planner: selection.planner,
    skills: selection.skills,
  } : input);
}
