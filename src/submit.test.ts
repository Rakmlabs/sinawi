import assert from "node:assert/strict";
import test from "node:test";
import { submitSession } from "./submit";
import type { StartSessionInput } from "../server/types";

const input: StartSessionInput = { prompt: "Build this", cwd: "/project", agent: "codex", mode: "auto", autoSwitch: true, skills: ["skill"], groupId: "group", systemPrompt: "instructions" };
const recommendation = {
  orchestrator: { agent: "claude" as const, model: "sonnet", reason: "routing" },
  planner: { agent: "codex" as const, reason: "planning" },
  workers: [{ agent: "codex" as const, model: "gpt", reason: "coding" }], skills: ["skill"], reason: "team", source: "planner" as const,
};

test("one auto submit routes then creates a session with the recommended team", async () => {
  const calls: { path: string; body: any }[] = [];
  const routing: boolean[] = [];
  const session = { id: "started" };
  const result = await submitSession(async <T>(path: string, body: unknown) => {
    calls.push({ path, body });
    return (path === "/route" ? recommendation : session) as T;
  }, input, undefined, (value) => routing.push(value));
  assert.equal(result, session);
  assert.deepEqual(calls.map((call) => call.path), ["/route", "/sessions"]);
  assert.deepEqual(routing, [true, false]);
  assert.deepEqual(calls[1].body, { ...input, agent: "claude", model: "sonnet", reasoningEffort: undefined, workers: ["codex"], workerConfigs: recommendation.workers, planner: recommendation.planner });
});

test("routing and start failures propagate to the chat error handler", async () => {
  for (const failedPath of ["/route", "/sessions"]) {
    const routing: boolean[] = [];
    await assert.rejects(submitSession(async <T>(path: string) => {
      if (path === failedPath) throw new Error(`${path} failed`);
      return recommendation as T;
    }, input, undefined, (value) => routing.push(value)), new RegExp(`${failedPath} failed`));
    assert.deepEqual(routing, [true, false]);
  }
});

test("manual submit and an edited recommendation start without routing again", async () => {
  for (const [mode, selection] of [["manual", undefined], ["auto", recommendation]] as const) {
    const paths: string[] = [];
    await submitSession(async <T>(path: string) => { paths.push(path); return { id: "started" } as T; }, { ...input, mode }, selection);
    assert.deepEqual(paths, ["/sessions"]);
  }
});

test("workspace ownership is retained during automatic routing and session creation", async () => {
  const calls: { path: string; body: any }[] = [];
  await submitSession(async <T>(path: string, body: unknown) => {
    calls.push({ path, body });
    return (path === "/route" ? recommendation : { id: "company-session", workspaceId: "company" }) as T;
  }, { ...input, workspaceId: "company" });
  assert.equal(calls[0].body.workspaceId, "company");
  assert.equal(calls[1].body.workspaceId, "company");
});
