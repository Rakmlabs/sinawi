import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isArray, readJsonFile, writeJsonFile } from "./json-file.js";
import { defaultDataDir } from "./runtime.js";
import type { WorkspaceId } from "./types.js";
import type { AppNotification, NotificationInput } from "./notification-types.js";

export class NotificationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory = defaultDataDir, private onChange?: (workspaceId: WorkspaceId) => void) {}
  private operate<T>(operation: (items: AppNotification[]) => T, write: boolean | (() => boolean) = false): Promise<T> {
    const result = this.queue.then(async () => {
      const file = resolve(this.directory, "notifications.json");
      const items = (await readJsonFile(file, isArray) as AppNotification[] | undefined) ?? [];
      const result = operation(items);
      if (typeof write === "function" ? write() : write) await writeJsonFile(file, items);
      return result;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  list(workspaceId: WorkspaceId) { return this.operate((items) => items.filter((n) => n.workspaceId === workspaceId)); }
  async add(input: NotificationInput): Promise<AppNotification> {
    let changed = false;
    const item = await this.operate((items) => {
      const previous = input.key ? items.find((n) => n.workspaceId === input.workspaceId && n.key === input.key) : undefined;
      if (previous && previous.type === input.type && previous.title === input.title && previous.body === input.body && JSON.stringify(previous.action) === JSON.stringify(input.action)) return previous;
      const now = new Date().toISOString();
      const next: AppNotification = { ...input, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now, read: false };
      const rest = items.filter((n) => n.id !== next.id);
      items.splice(0, items.length, next, ...rest.filter((n) => n.workspaceId === input.workspaceId).slice(0, 199), ...rest.filter((n) => n.workspaceId !== input.workspaceId));
      changed = true;
      return next;
    }, () => changed);
    if (changed) this.onChange?.(input.workspaceId);
    return item;
  }
  async read(workspaceId: WorkspaceId, ids: string[] | "all") {
    await this.operate((items) => { for (const n of items) if (n.workspaceId === workspaceId && (ids === "all" || ids.includes(n.id))) n.read = true; }, true);
    this.onChange?.(workspaceId);
  }
  async clear(workspaceId: WorkspaceId) {
    await this.operate((items) => { const keep = items.filter((n) => n.workspaceId !== workspaceId); items.splice(0, items.length, ...keep); }, true);
    this.onChange?.(workspaceId);
  }
  async resolveWhere(workspaceId: WorkspaceId, match: (key: string) => boolean) {
    let changed = false;
    await this.operate((items) => { const keep = items.filter((n) => !(n.workspaceId === workspaceId && n.key && match(n.key))); if (keep.length !== items.length) { items.splice(0, items.length, ...keep); changed = true; } }, () => changed);
    if (changed) this.onChange?.(workspaceId);
  }
  async resolve(workspaceId: WorkspaceId, key: string) {
    let changed = false;
    await this.operate((items) => { const index = items.findIndex((n) => n.workspaceId === workspaceId && n.key === key); if (index >= 0) { items.splice(index, 1); changed = true; } }, () => changed);
    if (changed) this.onChange?.(workspaceId);
  }
}
