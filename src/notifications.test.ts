import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsCenter, notificationRelativeTime } from "./NotificationsCenter";

test("notifications center renders its closed bell state without a browser document", () => {
  const html = renderToStaticMarkup(createElement(NotificationsCenter, {
    workspaceId: "personal",
    onSession: () => undefined,
  }));

  assert.match(html, /class="notifications-center"/);
  assert.match(html, /aria-label="알림"/);
  assert.doesNotMatch(html, /notification-toasts/);
});

test("notification relative time uses Korean minute, hour, day, and calendar labels", () => {
  const now = new Date("2026-10-30T12:00:00.000Z").getTime();
  assert.equal(notificationRelativeTime("2026-10-30T11:59:31.000Z", now), "방금 전");
  assert.equal(notificationRelativeTime("2026-10-30T11:43:00.000Z", now), "17분 전");
  assert.equal(notificationRelativeTime("2026-10-30T09:00:00.000Z", now), "3시간 전");
  assert.equal(notificationRelativeTime("2026-10-27T12:00:00.000Z", now), "3일 전");
  assert.match(notificationRelativeTime("2026-10-20T12:00:00.000Z", now), /10월\s*20일/);
});
