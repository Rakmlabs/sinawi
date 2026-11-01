import type { WorkspaceId } from "./types.js";
export type NotificationType = "auth" | "quota" | "permission" | "run-finished" | "error" | "info";
export interface NotificationAction { label: string; command?: string; cwd?: string; sessionId?: string }
export interface AppNotification {
  id: string; key?: string; workspaceId: WorkspaceId; type: NotificationType;
  title: string; body: string; createdAt: string; updatedAt: string; read: boolean;
  action?: NotificationAction;
}
export type NotificationInput = Pick<AppNotification, "workspaceId" | "type" | "title" | "body"> & Partial<Pick<AppNotification, "key" | "action">>;
