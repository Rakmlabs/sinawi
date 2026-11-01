import type { Bot as Preset, Group, SkillInfo as Skill, WorkspaceId } from "../../server/types";

export type Bootstrap = {
  agents: {
    id: string;
    name: string;
    available: boolean;
    detail: string;
  }[];
  skills: Skill[];
  bots: Preset[];
  groups: Group[];
  defaultCwd: string;
  homeCwd?: string;
};

export type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

export async function workspaceApi<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method: method ?? (body ? "POST" : "GET"),
    keepalive: path === "/workspaces",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = r.status === 204 ? "" : await r.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { throw new Error("앱 서버 응답을 읽지 못했습니다. 다시 시도하면 서버에 다시 연결합니다."); }
  if (!r.ok) throw new Error(data?.error || "요청을 처리하지 못했습니다.");
  return data;
}

/** POST bodies carry the workspace they were sent from. */
export function scopedApi(workspaceId: WorkspaceId): Api {
  return <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
    const verb = method ?? (body ? "POST" : "GET");
    const payload = verb === "POST" && body && typeof body === "object" ? { ...body, workspaceId } : body;
    return workspaceApi<T>(path, payload, method);
  };
}
