import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isArray, readJsonFile, writeJsonFile } from "./json-file.js";

/**
 * Pending approvals for app tools that are hard to undo (deleting, changing settings, approving a
 * merge, stopping a run). The AI's call does not run them: it gets `{status:"pending_approval",
 * approvalId}` back, the user sees a card with 승인/거절 in the app, and only an approval runs the
 * tool (server/app-tools.ts). Kept in app-approvals.json so a restart does not lose a waiting one.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "failed";
export type ApprovalSource = "lead" | "external";

export interface AppApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** One human line: what will happen ("채팅 'API' 삭제"). */
  summary: string;
  source: ApprovalSource;
  /** The lead chat that asked (source "lead"). */
  sessionId?: string;
  workspaceId: string;
  /** Who asked, by name: the lead's name (source "lead"). The card shows it before any ID. */
  requester?: string;
  /** The asking chat's title and the workspace's name when the request was made. */
  sessionTitle?: string;
  workspaceName?: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  /** What the tool returned when approved (shortened), or why it failed. */
  result?: string;
  error?: string;
}

const KEEP_DECIDED = 200;
const RESULT_LIMIT = 4_000;

export function approvalResultText(value: unknown): string {
  const text = value === undefined ? "완료" : typeof value === "string" ? value : JSON.stringify(value);
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text;
}

export class ApprovalStore {
  private items = new Map<string, AppApproval>();
  private loaded?: Promise<void>;
  private writing = Promise.resolve();

  constructor(private readonly dataDir: string | undefined, private readonly onChange?: (item: AppApproval) => void) {}

  private get file() { return this.dataDir ? join(this.dataDir, "app-approvals.json") : undefined; }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.file;
      const raw = file ? await readJsonFile(file, isArray).catch(() => undefined) : undefined;
      for (const item of (raw as AppApproval[] | undefined) ?? []) if (item && typeof item.id === "string" && typeof item.tool === "string") this.items.set(item.id, item);
    })();
    return this.loaded;
  }

  private persist() {
    const file = this.file;
    if (!file) return Promise.resolve();
    const decided = [...this.items.values()].filter((item) => item.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
    for (const old of decided.slice(KEEP_DECIDED)) this.items.delete(old.id);
    const snapshot = [...this.items.values()];
    this.writing = this.writing.then(() => writeJsonFile(file, snapshot, 2)).catch((error) => console.error("승인 대기 목록 저장 실패:", error instanceof Error ? error.message : error));
    return this.writing;
  }

  async create(input: Pick<AppApproval, "tool" | "args" | "summary" | "source" | "sessionId" | "workspaceId" | "requester" | "sessionTitle" | "workspaceName">): Promise<AppApproval> {
    await this.load();
    const item: AppApproval = { ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    this.items.set(item.id, item);
    await this.persist();
    this.onChange?.(item);
    return item;
  }

  async get(id: string): Promise<AppApproval | undefined> {
    await this.load();
    return this.items.get(id);
  }

  async list(filter: { status?: ApprovalStatus; id?: string } = {}): Promise<AppApproval[]> {
    await this.load();
    return [...this.items.values()]
      .filter((item) => (!filter.status || item.status === filter.status) && (!filter.id || item.id === filter.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Marks a pending approval decided. Takes it out of "pending" before `run` so a double click
   * cannot run the tool twice; `run` is only called for an approval.
   */
  async decide(id: string, approve: boolean, run: (item: AppApproval) => Promise<unknown>): Promise<AppApproval> {
    await this.load();
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error("승인 요청을 찾을 수 없습니다."), { status: 404 });
    if (item.status !== "pending") throw Object.assign(new Error("이미 처리된 승인 요청입니다."), { status: 409 });
    item.decidedAt = new Date().toISOString();
    if (!approve) {
      item.status = "rejected";
    } else {
      item.status = "approved";
      // On disk as decided before the tool runs: a crash or restart mid-run must not bring it back as
      // pending, where a second 승인 would run it again.
      await this.persist();
      try { item.result = approvalResultText(await run(item)); }
      catch (error) { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); }
    }
    await this.persist();
    this.onChange?.(item);
    return item;
  }
}

/** Who asked, as the user knows them: "담당 '백엔드'", "담당" or "외부 AI" (the particle is the caller's). */
export function approvalRequester(item: Pick<AppApproval, "source" | "requester">): string {
  if (item.source !== "lead") return "외부 AI";
  return item.requester?.trim() ? `담당 '${item.requester.trim()}'` : "담당";
}
