import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { activitiesBetween, sessionActivity } from "./computer-use";
import { messageRowProps, type MessageRowProps } from "./app/message-rows";
import { stableHandlers } from "./app/stable-callbacks";
import { delegationKey } from "./Sidebar";
import type { ComputerActivity } from "../server/computer-bridge";
import type { Session, SessionEvent } from "../server/types";

const MEMO = Symbol.for("react.memo");

test("the parts a composer keystroke must skip are memoized", async () => {
  // These components pull in stylesheets; Node cannot load CSS, so stub it before importing them.
  registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });
  const [{ MessageList }, { Sidebar }, { TeamBarSlot }, { ComputerTrail }] = await Promise.all([
    import("./app/MessageList"), import("./Sidebar"), import("./app/TeamBarSlot"), import("./ComputerUse"),
  ]);
  for (const [name, component] of Object.entries({ MessageList, Sidebar, TeamBarSlot, ComputerTrail })) {
    assert.equal((component as unknown as { $$typeof: symbol }).$$typeof, MEMO, name);
  }
});

const activity = (id: string, time: string, sessionId = "s1"): ComputerActivity => ({ id, time, key: `session:${sessionId}`, sessionId, workspaceId: "default", action: "click", summary: id, ok: true });

test("computer activity is grouped by session once per list, with stable slices", () => {
  const list = [activity("a", "2026-11-02T00:00:01Z"), activity("x", "2026-11-02T00:00:02Z", "s2"), activity("b", "2026-11-02T00:00:05Z")];
  const s1 = sessionActivity(list, "s1");
  assert.deepEqual(s1.map((item) => item.id), ["a", "b"]);
  assert.equal(sessionActivity(list, "s1"), s1, "same list, same slice: the trail's store snapshot stays put");
  assert.equal(sessionActivity(list, "none"), sessionActivity([], "other"), "no activity: one shared empty array");
  assert.equal(sessionActivity(list, "none").length, 0);
  // The slice gives the same trail as the whole list.
  assert.deepEqual(activitiesBetween(s1, "s1", "2026-11-02T00:00:00Z", "2026-11-02T00:00:05Z"), activitiesBetween(list, "s1", "2026-11-02T00:00:00Z", "2026-11-02T00:00:05Z"));
  const next = [...list, activity("c", "2026-11-02T00:00:09Z")];
  assert.notEqual(sessionActivity(next, "s1"), s1, "new activity: a new slice");
  assert.equal(sessionActivity(next, "s2").length, 1);
});

test("stable handlers keep their identity and call the latest closure", () => {
  const latest = { current: { onChoose: (option: string) => `first ${option}` } };
  const stable = stableHandlers(latest);
  const before = stable.onChoose;
  latest.current = { onChoose: (option: string) => `second ${option}` };
  assert.equal(stable.onChoose, before);
  assert.equal(stable.onChoose("1"), "second 1");
});

test("the sidebar's delegation key only follows delegations", () => {
  const events = [{ id: "u", type: "message" }, { id: "d1", type: "delegation" }] as SessionEvent[];
  assert.equal(delegationKey(events), JSON.stringify(["d1"]));
  assert.equal(delegationKey([...events, { id: "m", type: "message" } as SessionEvent]), delegationKey(events));
  assert.equal(delegationKey(undefined), "[]");
});

const event = (index: number, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id: `e${index}`, time: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
  agent: index % 2 ? "claude" : "user", type: "message", text: `message ${index}`, ...extra,
} as SessionEvent);

const shallowEqual = (a: MessageRowProps, b: MessageRowProps) =>
  Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof MessageRowProps)[]).every((key) => Object.is(a[key], b[key]));

function rows(active: Pick<Session, "id" | "status" | "permissionMode" | "workerConfigs">, events: SessionEvent[], overrides: Partial<Parameters<typeof messageRowProps>[0]> = {}) {
  const handlers = overrides.handlers ?? HANDLERS;
  const latestAssistantId = [...events].reverse().find((item) => item.agent !== "user")?.id;
  return events.map((_, index) => messageRowProps({ active, events, index, tasksById: new Map(), latestHandoffId: undefined, latestAssistantId,
    choiceOptions: ["a", "b"], streamingMessageId: undefined, busy: false, drafting: false, canExecutePlan: true, ...overrides, handlers }));
}
const HANDLERS = { onUndoHandoff: () => undefined, onOpenWorker: () => undefined, onPromote: () => undefined, onChoose: () => undefined, onExecutePlan: () => undefined };

test("a new event leaves the props of older rows unchanged, however long the history", () => {
  const history = Array.from({ length: 2000 }, (_, index) => event(index));
  const before = rows({ id: "s1", status: "running", permissionMode: "auto", workerConfigs: [] }, history);
  // The server pushes the session again: a new session object, one more event, a new workerConfigs array.
  const after = rows({ id: "s1", status: "running", permissionMode: "auto", workerConfigs: [] }, [...history, event(2001)]);
  const changed = before.filter((props, index) => !shallowEqual(props, after[index])).map((props) => props.e.id);
  // Only the previous last row changes: it gets a `nextTime` and stops being the latest reply.
  assert.deepEqual(changed, ["e1999"]);
  assert.equal(before[1999].choiceOptions.length, 2);
  assert.equal(after[1999].choiceOptions.length, 0);
  assert.equal(after[2000].isLatestAssistant, true);
});

test("busy and the session status only reach rows that show them", () => {
  const history = Array.from({ length: 50 }, (_, index) => event(index));
  const idle = rows({ id: "s1", status: "done", permissionMode: "plan", workerConfigs: [] }, history);
  const busy = rows({ id: "s1", status: "done", permissionMode: "plan", workerConfigs: [] }, history, { busy: true });
  const changed = idle.filter((props, index) => !shallowEqual(props, busy[index])).map((props) => props.e.id);
  assert.deepEqual(changed, ["e49"], "only the latest reply's execute-plan button");
  assert.equal(busy[49].showExecutePlan, true);
  assert.deepEqual(busy[49].choiceOptions, ["a", "b"]);
  assert.equal(busy[47].choiceOptions.length, 0);
});
