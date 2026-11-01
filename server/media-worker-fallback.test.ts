import assert from "node:assert/strict";
import test from "node:test";
import { Orchestra } from "./orchestra.js";
import type { RunCliOptions } from "./cli.js";
import type { Session, AgentId } from "./types.js";

async function settled(session: Session) {
  const deadline = Date.now() + 3000;
  while (session.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done", session.events.at(-1)?.text);
}

for (const [primary, alternate] of [["grok", "codex"], ["codex", "grok"]] as const) {
  for (const failure of ["quota", "unavailable"]) test(`personal media worker ${primary} ${failure} failure falls back to ${alternate} without changing Grok orchestrator`, async () => {
    const calls: Array<{ agent: AgentId; role?: string }> = [];
    const runner = async (options: RunCliOptions) => {
      const role = options.usageContext?.role;
      calls.push({ agent: options.agent, role });
      if (role === "worker") {
        if (options.agent === primary) {
          if (failure === "unavailable") throw new Error(`${primary} CLI를 시작할 수 없습니다 (ENOENT).`);
          return { exitCode: 1, finalText: "quota exceeded (429)" };
        }
        return { exitCode: 0, finalText: "asset created" };
      }
      if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "finished" };
      return { exitCode: 0, finalText: `<<DELEGATE to="${primary}">>Create the asset<</DELEGATE>>` };
    };
    const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, undefined,
      async () => ({ enabled: true, threshold: 3, quotas: [], order: { codex: ["claude"], grok: ["claude"] }, authenticated: ["grok", "codex", "claude"] }));
    const session = await orchestra.create({ prompt: "이미지 만들어 줘", cwd: process.cwd(), agent: "grok", workers: [primary] });
    await settled(session);
    assert.deepEqual(calls.filter((call) => call.role === "worker").map((call) => call.agent), [primary, alternate]);
    assert.equal(session.agent, "grok");
    assert.deepEqual(session.workers, [alternate]);
    assert.ok(calls.filter((call) => call.role === "orchestrator").every((call) => call.agent === "grok"));
  });
}

for (const prompt of ["Docker image 버그 수정", "video player 버그 수정"]) {
  test(`company coding request stays available: ${prompt}`, async () => {
    const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "fixed" }));
    const session = await orchestra.create({ prompt, cwd: process.cwd(), agent: "claude", workers: ["grok"], workspaceId: "company" });
    await settled(session);
    assert.equal(session.agent, "claude");
    await orchestra.followup(session.id, prompt);
    await settled(session);
  });
}
