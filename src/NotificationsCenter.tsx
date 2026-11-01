import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  Gauge,
  Info,
  KeyRound,
  ShieldAlert,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AppNotification, NotificationType } from "../server/notification-types";
import type { WorkspaceId } from "../server/types";
import { openTerminal, terminalOwnsKeyboardEvent } from "./terminal-events";
import { useNow } from "./app/clock";
import { t, translatedMap } from "./i18n";

const NOTIFICATIONS_EVENT = "orchestra:notifications";
const criticalTypes = new Set<NotificationType>(["auth", "error", "permission"]);
const toastStoragePrefix = "orchestra:notification-toasts:v1";

const typeLabels = translatedMap<NotificationType>({
  auth: "noti.auth",
  quota: "noti.quota",
  permission: "noti.permission",
  "run-finished": "noti.runFinished",
  error: "noti.error",
  info: "noti.info",
});

function NotificationIcon({ type, size = 15 }: { type: NotificationType; size?: number }) {
  const props = { size, "aria-hidden": true as const };
  if (type === "auth") return <KeyRound {...props} />;
  if (type === "quota") return <Gauge {...props} />;
  if (type === "permission") return <ShieldAlert {...props} />;
  if (type === "run-finished") return <CircleCheck {...props} />;
  if (type === "error") return <CircleAlert {...props} />;
  return <Info {...props} />;
}

export function notificationRelativeTime(value: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("time.daysAgo", { n: days });
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value));
}

function absoluteTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toastVersion(notification: AppNotification): string {
  return `${notification.id}:${notification.updatedAt}`;
}

function loadSeenToasts(workspaceId: WorkspaceId): Set<string> {
  if (typeof sessionStorage === "undefined") return new Set();
  try {
    const stored = JSON.parse(sessionStorage.getItem(`${toastStoragePrefix}:${workspaceId}`) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSeenToasts(workspaceId: WorkspaceId, seen: Set<string>): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${toastStoragePrefix}:${workspaceId}`, JSON.stringify([...seen].slice(-400)));
  } catch {
    // Notifications still work when storage is unavailable.
  }
}

type NotificationsCenterProps = {
  workspaceId: WorkspaceId;
  cwd?: string;
  /** Main WebSocket state: the server pushes changes while connected, so polling is only a fallback. */
  connected?: boolean;
  onSession: (sessionId: string) => void;
  onRefreshAuth?: () => void;
};

/** Fallback poll period while the push channel is down. */
export const NOTIFICATIONS_FALLBACK_POLL_MS = 5_000;

export function NotificationsCenter({ workspaceId, cwd, connected = false, onSession, onRefreshAuth }: NotificationsCenterProps) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  // Relative times ("n분 전") refresh on their own clock while the list is open.
  const now = useNow(60_000, open);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const centerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const workspaceRef = useRef(workspaceId);
  const toastTimers = useRef(new Set<number>());
  workspaceRef.current = workspaceId;

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const response = await fetch(`/api/notifications?workspace=${encodeURIComponent(workspaceId)}`);
      if (!response.ok) return;
      const result = await response.json();
      if (request !== requestRef.current || workspaceRef.current !== workspaceId || !Array.isArray(result)) return;
      setNotifications(result as AppNotification[]);
    } catch {
      // Polling recovers automatically when the local server becomes available.
    }
  }, [workspaceId]);

  useEffect(() => {
    requestRef.current += 1;
    setNotifications([]);
    setToasts([]);
    void refresh();
    const invalidate = () => { void refresh(); };
    window.addEventListener(NOTIFICATIONS_EVENT, invalidate);
    return () => {
      window.removeEventListener(NOTIFICATIONS_EVENT, invalidate);
      requestRef.current += 1;
    };
  }, [refresh]);

  // Pushes (NOTIFICATIONS_EVENT) cover every change while the WebSocket is up. Poll only while it
  // is down, and catch up once on reconnect for anything pushed during the outage.
  const wasConnected = useRef(connected);
  useEffect(() => {
    const reconnected = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (connected) { if (reconnected) void refresh(); return; }
    const interval = window.setInterval(() => { void refresh(); }, NOTIFICATIONS_FALLBACK_POLL_MS);
    return () => window.clearInterval(interval);
  }, [connected, refresh]);

  useEffect(() => () => {
    for (const timer of toastTimers.current) window.clearTimeout(timer);
    toastTimers.current.clear();
  }, []);

  useEffect(() => {
    const seen = loadSeenToasts(workspaceId);
    const fresh = notifications.filter((notification) => {
      if (notification.read || !criticalTypes.has(notification.type)) return false;
      const version = toastVersion(notification);
      return !seen.has(version);
    }).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, 3);
    if (!fresh.length) return;
    for (const notification of fresh) seen.add(toastVersion(notification));
    saveSeenToasts(workspaceId, seen);
    setToasts((current) => [...current, ...fresh]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, 3));
    for (const notification of fresh) {
      const timer = window.setTimeout(() => {
        toastTimers.current.delete(timer);
        setToasts((current) => current.filter((toast) => toast.id !== notification.id));
      }, 4_000);
      toastTimers.current.add(timer);
    }
  }, [notifications, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!centerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !terminalOwnsKeyboardEvent(event)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const ordered = useMemo(
    () => [...notifications].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [notifications],
  );
  const unread = notifications.reduce((total, notification) => total + (notification.read ? 0 : 1), 0);

  const markRead = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const selected = new Set(ids);
    setNotifications((current) => current.map((notification) => selected.has(notification.id) ? { ...notification, read: true } : notification));
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId, ids }),
    }).then(() => refresh(), () => refresh());
  }, [refresh, workspaceId]);

  const markAllRead = useCallback(() => {
    setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId, all: true }),
    }).then(() => refresh(), () => refresh());
  }, [refresh, workspaceId]);

  const clearAll = useCallback(() => {
    setNotifications([]);
    void fetch(`/api/notifications?workspace=${encodeURIComponent(workspaceId)}`, { method: "DELETE" })
      .then(() => refresh(), () => refresh());
  }, [refresh, workspaceId]);

  const activate = useCallback((notification: AppNotification) => {
    if (!notification.read) markRead([notification.id]);
    const action = notification.action;
    if (action?.sessionId) onSession(action.sessionId);
    if (action?.command) {
      openTerminal({ cwd: action.cwd ?? cwd, command: action.command });
      onRefreshAuth?.();
      window.setTimeout(() => onRefreshAuth?.(), 5_000);
    }
    setOpen(false);
  }, [cwd, markRead, onRefreshAuth, onSession]);

  const toastLayer = (
    <div className="notification-toasts" aria-live="assertive" aria-relevant="additions">
      {toasts.map((toast) => (
        <article className={`notification-toast notification-${toast.type}`} key={toastVersion(toast)}>
          <span className="notification-type-icon"><NotificationIcon type={toast.type} size={16} /></span>
          <button type="button" className="notification-toast-copy" onClick={() => activate(toast)}>
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </button>
          <button
            type="button"
            className="notification-toast-close"
            aria-label={t("noti.dismiss")}
            onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </article>
      ))}
    </div>
  );

  return (
    <>
      <div className="notifications-center" ref={centerRef}>
        <button
        type="button"
        className="notifications-trigger header-icon-button"
        aria-label={unread ? t("noti.buttonUnread", { n: unread }) : t("noti.title")}
        aria-expanded={open}
        aria-controls="notifications-popover"
        title={t("noti.title")}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void refresh();
        }}
      >
        <Bell size={18} aria-hidden="true" />
        {unread > 0 ? <span className="notifications-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span> : null}
        </button>

        {open ? (
          <section id="notifications-popover" className="notifications-popover" aria-label={t("noti.center")}>
          <header className="notifications-heading">
            <div>
              <strong>{t("noti.title")}</strong>
              <span>{unread ? t("noti.unread", { n: unread }) : t("noti.none")}</span>
            </div>
            <div className="notifications-controls">
              <button type="button" disabled={!unread} onClick={markAllRead}>{t("noti.markAllRead")}</button>
              <button type="button" disabled={!notifications.length} onClick={clearAll}>{t("noti.clearAll")}</button>
            </div>
          </header>
          <div className="notifications-list">
            {ordered.length ? ordered.map((notification) => (
              <button
                type="button"
                className={`notification-item notification-${notification.type}${notification.read ? " is-read" : ""}`}
                key={notification.id}
                onClick={() => activate(notification)}
              >
                <span className="notification-type-icon" title={typeLabels[notification.type]}>
                  <NotificationIcon type={notification.type} />
                </span>
                <span className="notification-copy">
                  <span className="notification-title-row">
                    <strong>{notification.title}</strong>
                    <time dateTime={notification.updatedAt} title={absoluteTime(notification.updatedAt)}>
                      {notificationRelativeTime(notification.updatedAt, now)}
                    </time>
                  </span>
                  <span className="notification-body">{notification.body}</span>
                  {notification.action ? (
                    <span className="notification-action">
                      {notification.action.command ? <SquareTerminal size={12} aria-hidden="true" /> : null}
                      {notification.action.label}
                    </span>
                  ) : null}
                </span>
                {!notification.read ? <span className="notification-unread" aria-label={t("noti.unreadDot")} /> : null}
              </button>
            )) : (
              <div className="notifications-empty">
                <Bell size={18} aria-hidden="true" />
                <span>{t("noti.empty")}</span>
              </div>
            )}
          </div>
          </section>
        ) : null}
      </div>
      {typeof document !== "undefined" ? createPortal(toastLayer, document.body) : null}
    </>
  );
}
