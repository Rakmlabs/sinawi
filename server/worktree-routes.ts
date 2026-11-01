import { execFile } from "node:child_process";
import type { Express, Request, Response } from "express";
import type { Orchestra } from "./orchestra.js";
import { fileActionCommand } from "./session-files.js";
import { removeWorktree, worktreeStatus, WorktreeDirtyError } from "./worktrees.js";

type Deps = { orchestra: Orchestra; persist: () => Promise<void> };

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function fail(res: Response, error: unknown, status = 400) {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error), ...(error instanceof WorktreeDirtyError ? { code: error.code, uncommitted: error.uncommitted } : {}) });
}

/** Session worktree panel: list with status, open folder, remove (merging stays with the developer). */
export function registerWorktreeRoutes(app: Express, { orchestra, persist }: Deps) {
  const find = (req: Request) => {
    const session = orchestra.get(param(req.params.id));
    if (!session) throw Object.assign(new Error("세션을 찾을 수 없습니다."), { status: 404 });
    const workerId = req.params.workerId === undefined ? undefined : param(req.params.workerId);
    const info = workerId === undefined ? undefined : session.worktrees?.find((item) => item.workerId === workerId);
    if (workerId !== undefined && !info) throw Object.assign(new Error("worktree를 찾을 수 없습니다."), { status: 404 });
    return { session, info };
  };
  const statusOf = (error: unknown) => (error as { status?: number }).status ?? 400;

  app.get("/api/sessions/:id/worktrees", async (req, res) => {
    try {
      const { session } = find(req);
      res.json({ worktrees: await Promise.all((session.worktrees ?? []).map(worktreeStatus)) });
    } catch (error) { fail(res, error, statusOf(error)); }
  });

  app.post("/api/sessions/:id/worktrees/:workerId/open", (req, res) => {
    try {
      const { info } = find(req);
      const { command, args } = fileActionCommand("open", info!.path);
      execFile(command, args, { timeout: 10_000 }, (error) => error ? fail(res, new Error("폴더를 열지 못했습니다."), 500) : res.status(204).end());
    } catch (error) { fail(res, error, statusOf(error)); }
  });

  app.delete("/api/sessions/:id/worktrees/:workerId", async (req, res) => {
    try {
      const { session, info } = find(req);
      if (session.status === "running") throw Object.assign(new Error("실행 중에는 worktree를 지울 수 없습니다."), { status: 409 });
      const result = await removeWorktree(info!, { force: req.query.force === "1" });
      orchestra.setWorktrees(session.id, (session.worktrees ?? []).filter((item) => item !== info));
      await persist();
      res.json(result);
    } catch (error) { fail(res, error, error instanceof WorktreeDirtyError ? 409 : statusOf(error)); }
  });
}
