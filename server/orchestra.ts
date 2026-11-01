import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runCli } from "./cli.js";
import { workerSessionId, setWorkerSessionId, loadToolSettings } from "./store.js";
import { enabledPublicSkills, resolveSkillPrompt } from "./skills.js";
import type { AgentId, AgentSelection, Bot, ConversationInput, ConversationSettings, Session, SessionEvent, StartSessionInput, UpdateTeamInput } from "./types.js";
import type { ProviderQuota } from "./quota.js";
import { equivalentFallbackModel, exhaustionFromQuota, isQuotaExhaustion, selectQuotaFallback } from "./quota-fallback.js";

import type { AutoSwitchRecommendation } from "./auto-routing.js";
import { allowedAgentsForWorkspace, assertAgentsAllowed, type AllowedAgentResolver } from "./workspace-policy.js";
import { normalizeWorkerConfigs, workerLabel } from "./workers.js";
import { mediaRouteRequired, mediaSkills, mediaUnavailableMessage, companyMediaUnavailableMessage, personalMediaPromptHint, isMediaRule } from "./media-routing.js";
import { cliNotes, compactHandoff, ensureBrief, ORCHESTRATOR_RULES, retargetCliNotes, reviewPrompt, StallDetector, stripToolNoise, isPureNoise, WORKER_RULES, type StallOptions, type StallSignal } from "./supervision.js";
import { classifyLiveMessage, instructionSuffix, pushInstruction, STATUS_AGENT_MODEL, statusDigest, statusPrompt, takePending, type LiveWorker } from "./live-turn.js";

const delegationPattern = /<<DELEGATE\s+to=["']([\w.-]{1,100})["']>>(.*?)<<\/DELEGATE>>/gis;
const maxEvents = 2_000;
const maxDelegations = 6;
/** Extra delegation rounds the orchestrator may use to re-plan after verification. */
const maxReplanRounds = 2;
const stallCheckMs = 15_000;
const agentNames: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok Build",
};

function workerRoster(workers: AgentSelection[]): string {
  return workers.map((worker) => `${worker.id} (${workerLabel(worker)} / ${worker.agent})`).join(", ") || "없음";
}

function clearChangedWorkerSessions(session: Session, before: AgentSelection[], after: AgentSelection[]): void {
  const previous = new Map(before.map((worker) => [worker.id!, worker.agent]));
  const next = new Map(after.map((worker) => [worker.id!, worker.agent]));
  for (const workerId of new Set([...previous.keys(), ...next.keys()])) {
    if (!previous.has(workerId) || !next.has(workerId) || previous.get(workerId) !== next.get(workerId)) {
      setWorkerSessionId(session, workerId);
    }
  }
}

export interface QuotaFallbackContext {
  enabled: boolean;
  threshold: number;
  order?: Partial<Record<AgentId, AgentId[]>>;
  quotas: ProviderQuota[];
  authenticated: AgentId[];
}

export type QuotaFallbackResolver = (session: Session) => Promise<QuotaFallbackContext>;

export interface DelegationRequest { target: string; task: string }
export function parseDelegations(text: string): DelegationRequest[] {
  const requests: DelegationRequest[] = [];
  for (const match of text.matchAll(delegationPattern)) {
    const task = match[2].trim();
    if (task) requests.push({ target: match[1], task });
    if (requests.length >= maxDelegations) break;
  }
  return requests;
}

function titleFrom(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact || "새 세션";
}

export class Orchestra {
  private sessions = new Map<string, Session>();
  private controllers = new Map<string, AbortController>();
  private inactivityTimers = new Map<string, NodeJS.Timeout>();
  private configs = new Map<string, { skills: string[]; systemPrompt: string }>();
  /** Per-session kill switch + stall detector for the worker currently running. */
  private workerGuards = new Map<string, { kill: AbortController; detector: StallDetector; stall?: StallSignal }>();
  /** Sessions whose already-published events were edited or removed since the last publish. */
  private rewrittenEvents = new Set<string>();
  /** Tunable stall thresholds (tests shorten these). */
  stallOptions: StallOptions = {};

  constructor(
    // `full` = already-sent events were changed or removed, so clients need a whole snapshot, not an append.
    private publish: (session: Session, options?: { full?: boolean }) => void = () => undefined,
    private runner: typeof runCli = runCli,
    // Receives the full list plus the ids that changed, so storage can rewrite only those.
    private persist: (sessions: Session[], changedIds: string[]) => void | Promise<void> = () => undefined,
    private publishRemoval: (sessionId: string) => void = () => undefined,
    private autoRouter?: (session: Session, prompt: string, signal: AbortSignal) => Promise<AutoSwitchRecommendation | undefined>,
    private allowedAgentResolver?: AllowedAgentResolver,
    private usageDataDir?: string,
    private quotaFallbackResolver?: QuotaFallbackResolver,
    private mediaRequestResolver?: (prompt: string) => Promise<boolean>,
    private inactivityTimeoutMs = 10 * 60 * 1_000,
  ) {}

  private clearInactivityTimer(sessionId: string): void {
    const timer = this.inactivityTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.inactivityTimers.delete(sessionId);
  }

  private touchInactivityTimer(session: Session): void {
    this.clearInactivityTimer(session.id);
    if (session.status !== "running" || !this.controllers.has(session.id) || this.inactivityTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      if (session.status !== "running") return;
      this.controllers.get(session.id)?.abort();
      this.fail(session, new Error("새 이벤트가 없어 작업을 중단했습니다."));
    }, this.inactivityTimeoutMs);
    timer.unref();
    this.inactivityTimers.set(session.id, timer);
  }

  private isCurrentRun(session: Session, signal: AbortSignal): boolean {
    return !signal.aborted && this.controllers.get(session.id)?.signal === signal;
  }

  private requireCurrentRun(session: Session, signal: AbortSignal): void {
    if (!this.isCurrentRun(session, signal)) throw Object.assign(new Error("실행이 중지되었습니다."), { name: "AbortError" });
  }

  private async isMediaRequest(prompt: string, skills: string[] = [], workspaceId: Session["workspaceId"] = "personal"): Promise<boolean> {
    const disabled = new Set((await loadToolSettings(this.usageDataDir))[workspaceId].disabledSkills.map((name) => name.toLocaleLowerCase()));
    return skills.some((id) => isMediaRule(id) && !disabled.has(id.toLocaleLowerCase())) || (this.mediaRequestResolver
      ? await this.mediaRequestResolver(prompt)
      : mediaRouteRequired(prompt, []));
  }

  private mediaWorkers(workspaceId: Session["workspaceId"]): AgentId[] {
    return (["codex", "grok"] as AgentId[]).filter((agent) => this.allowedAgents({ workspaceId }).includes(agent));
  }

  private allowedAgents(session: Pick<Session, "workspaceId">): AgentId[] {
    return allowedAgentsForWorkspace(session.workspaceId, this.allowedAgentResolver?.(session.workspaceId));
  }

  private assertPolicy(workspaceId: Session["workspaceId"], agents: readonly AgentId[]): void {
    assertAgentsAllowed(workspaceId, agents, this.allowedAgentResolver?.(workspaceId));
  }

  private assertSessionPolicy(session: Session): void {
    this.assertPolicy(session.workspaceId, [session.agent, ...session.workers, ...(session.planner ? [session.planner.agent] : [])]);
  }

  restore(sessions: Session[]) {
    for (const session of sessions) {
      session.workerConfigs = normalizeWorkerConfigs(session.workers, session.workerConfigs);
      this.sessions.set(session.id, session);
      this.configs.set(session.id, { skills: session.skills ?? [], systemPrompt: session.systemPrompt ?? "" });
    }
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Session | undefined { return this.sessions.get(id); }

  /** Call after editing or removing events that clients may already hold. */
  private markEventsRewritten(session: Session): void {
    this.rewrittenEvents.add(session.id);
  }

  private broadcast(session: Session) {
    this.publish(session, this.rewrittenEvents.delete(session.id) ? { full: true } : undefined);
    void Promise.resolve(this.persist(this.list(), [session.id])).catch(() => undefined);
  }

  private event(
    session: Session,
    agent: AgentId | "user",
    type: SessionEvent["type"],
    text: string,
    metadata: Partial<Pick<SessionEvent, "role" | "delegationId" | "taskStatus" | "model" | "reasoningEffort" | "workerId" | "workerLabel" | "metadata">> = {},
  ): SessionEvent | undefined {
    if (this.sessions.get(session.id) !== session) return;
    if (!text.trim()) return;
    if (type === "status" && text === "CLI 세션 연결됨" && session.events.some((event) => event.type === type && event.text === text)) return;
    const id = type === "delegation" && metadata.taskStatus === "running" ? (metadata.delegationId ?? randomUUID()) : randomUUID();
    const event = { id, sessionId: session.id, agent, type, text, time: new Date().toISOString(), ...metadata } satisfies SessionEvent;
    if (type === "delegation" && metadata.taskStatus === "running") event.delegationId = id;
    session.events.push(event);
    if (session.events.length > maxEvents) session.events.splice(0, session.events.length - maxEvents);
    this.touchInactivityTimer(session);
    this.broadcast(session);
    return event;
  }

  async create(input: StartSessionInput): Promise<Session> {
    if (!input.workers?.length) throw new Error("워커를 한 명 이상 선택하세요.");
    const workspaceId = input.workspaceId ?? "personal";
    const mediaRequest = await this.isMediaRequest(input.prompt, input.skills, workspaceId);
    if (workspaceId === "company" && mediaRequest) throw new Error(companyMediaUnavailableMessage);
    if (mediaRequest && !this.allowedAgents({ workspaceId }).includes("grok")) throw new Error(mediaUnavailableMessage);
    const agent = mediaRequest ? "grok" : input.agent;
    const workers: AgentId[] = [...input.workers];
    const model = mediaRequest ? "grok-4.7" : input.model;
    const reasoningEffort = mediaRequest ? undefined : input.reasoningEffort;
    const workerConfigs = normalizeWorkerConfigs(workers, input.workerConfigs);
    this.assertPolicy(workspaceId, [agent, ...workers, ...(input.planner ? [input.planner.agent] : [])]);
    const cwd = resolve(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
    const selectedSkills = [...new Set([...(input.skills ?? []), ...mediaSkills(input.prompt, await enabledPublicSkills(cwd, false, (await loadToolSettings(this.usageDataDir))[workspaceId].disabledSkills))])];
    const session: Session = {
      id: randomUUID(), title: titleFrom(input.prompt), agent,
      workers, cwd, model,
      reasoningEffort,
      workerConfigs,
      planner: input.planner,
      mode: input.mode ?? "manual", autoSwitch: input.autoSwitch ?? true, turnCount: 1,
      status: "running", createdAt: new Date().toISOString(), events: [],
      cliSessionId: agent === input.agent ? input.resumeSessionId : undefined,
      groupId: input.groupId,
      workspaceId,
      skills: selectedSkills, systemPrompt: input.systemPrompt ?? "",
    };
    this.sessions.set(session.id, session);
    this.configs.set(session.id, { skills: selectedSkills, systemPrompt: input.systemPrompt ?? "" });
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    this.event(session, agent, "status", `${agentNames[agent]} 세션을 시작했습니다.`);
    this.event(session, "user", "message", input.prompt);
    void this.execute(session, input.prompt, selectedSkills, input.systemPrompt ?? "", controller, mediaRequest)
      .catch((error) => this.fail(session, error, controller));
    return session;
  }

  private async execute(session: Session, userPrompt: string, skillIds: string[], systemPrompt: string, controller: AbortController, requiresGrokMedia: boolean) {
    if (!this.isCurrentRun(session, controller.signal)) return;
    this.assertSessionPolicy(session);
    if (session.workspaceId === "company" && requiresGrokMedia) throw new Error(companyMediaUnavailableMessage);
    if (requiresGrokMedia && session.agent !== "grok") {
      throw new Error(mediaUnavailableMessage);
    }
    const skills = await resolveSkillPrompt(skillIds, session.cwd, (await loadToolSettings(this.usageDataDir))[session.workspaceId].disabledSkills);
    if (!this.isCurrentRun(session, controller.signal)) return;
    let plan = "";
    if (session.planner) {
      this.event(session, session.planner.agent, "status", `${agentNames[session.planner.agent]}가 실행 계획을 준비하고 있습니다.`);
      const planningPrompt = `당신은 실행 전 계획을 작성하는 전문 에이전트입니다. 파일을 수정하거나 상태를 변경하지 말고, 도구를 호출하지 마세요. 구현하지 마세요. 주어진 요청을 분석해 간결한 실행 계획을 한국어로 작성하세요. 단계는 확인 가능한 문장으로, 2개 이상일 때만 나누고, 한 단계짜리 계획은 쓰지 마세요. 서로 독립인 단계만 병렬이라고 표시하고, 같은 파일은 한 단계에만 넣으세요. 주요 위험, 가정, 완료 조건을 적으세요. "그것", "이어서"처럼 앞 대화를 가리키는 표현은 아래 이전 대화로 해석하세요.${skills}\n\n이전 대화 요약:\n${session.handoffContext ?? this.conversationSummary(session, session.agent)}\n\n사용자 요청:\n${userPrompt}`;
      const planning = await this.runSelection(session, session.planner, planningPrompt, undefined, controller.signal);
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      if (planning.exitCode !== 0) throw new Error(`${agentNames[session.planner.agent]} 계획 단계가 종료 코드 ${planning.exitCode}로 끝났습니다.`);
      plan = planning.finalText.trim();
    }
    const workers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workerConfigs = workers;
    const workerNames = workerRoster(workers);
    const workerContext = workers.map((worker) => `${worker.id}: ${worker.sessionMode !== "new" && workerSessionId(session, worker.id!) ? "이전 작업의 맥락을 가진 세션을 이어서 사용합니다. 기존 설명을 반복하지 않고 후속 작업을 지시할 수 있습니다." : "새 세션으로 시작합니다. 필요한 맥락을 전달하세요."}`).join("\n");
    const exampleWorker = workers[0]?.id ?? "claude";
    const orchestration = `당신은 Agent Orchestra의 상위 명령자입니다. 사용 가능한 워커: ${workerNames}. 워커에게 일을 맡길 때는 정확히 <<DELEGATE to="${exampleWorker}">>구체적인 작업<</DELEGATE>> 형식으로 출력하세요. 같은 에이전트 워커가 여러 명이면 반드시 워커 ID로 지정하세요. 선택되지 않은 워커에게 위임하지 마세요. 워커 결과를 받은 뒤 검증하고 사용자에게 최종 답을 작성하세요.\n\n${ORCHESTRATOR_RULES}\n\n${cliNotes(session.agent, "orchestrator")}\n\n워커 세션 상태:\n${workerContext}`;
    const planningContext = plan ? `\n\n계획 전문 에이전트가 작성한 실행 계획:\n${plan}` : "";
    const handoffContext = session.handoffContext ? `\n\n이전 오케스트라의 대화 요약:\n${session.handoffContext}` : "";
    const resumeBrief = session.cliSessionId ? `\n\n이어받기 전 압축 요약:\n${compactHandoff(session.events)}` : "";
    const prompt = `${systemPrompt ? `${systemPrompt}\n\n` : ""}${orchestration}${skills}${planningContext}${handoffContext}${resumeBrief}\n\n사용자 요청:\n${userPrompt}`;
    const first = await this.runAgent(session, session.agent, prompt, session.model, session.reasoningEffort, session.cliSessionId, controller.signal, true, false, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
    if (controller.signal.aborted) return this.finishStopped(session, controller);
    if (first.sessionId) session.cliSessionId = first.sessionId;
    if (first.exitCode !== 0) throw new Error(`${agentNames[session.agent]} CLI가 종료 코드 ${first.exitCode}로 끝났습니다.`);
    delete session.handoffContext;

    const resolveRequests = (text: string) => parseDelegations(text).flatMap((request) => {
      const exact = workers.find((candidate) => candidate.id === request.target);
      const legacyAgent = request.target.toLowerCase();
      const worker = exact ?? (legacyAgent === "codex" || legacyAgent === "claude" || legacyAgent === "grok"
        ? workers.find((candidate) => candidate.agent === legacyAgent)
        : undefined);
      return worker ? [{ request, worker }] : [];
    });
    let requests = resolveRequests(first.finalText);
    if (!requests.length) return this.finish(session);

    for (let round = 0; ; round++) {
      const workerResults: string[] = [];
      for (const { request, worker } of requests) {
        if (controller.signal.aborted) return this.finishStopped(session, controller);
        const brief = ensureBrief(request.task, userPrompt);
        const workerId = worker.id!;
        const resumeIdForBrief = worker.sessionMode === "new" ? undefined : workerSessionId(session, workerId);
        const workerResume = resumeIdForBrief ? `\n\n이어받기 전 압축 요약:\n${compactHandoff(session.events, workerId)}` : "";
        const workerPrompt = `${requiresGrokMedia && session.workspaceId === "personal" ? `${personalMediaPromptHint}\n\n` : ""}${systemPrompt ? `${systemPrompt}\n\n` : ""}상위 에이전트가 다음 작업을 위임했습니다. 작업 결과를 간결하고 구체적으로 보고하세요.\n\n${WORKER_RULES}\n\n${cliNotes(worker.agent, "worker")}${skills}\n\n${brief.text}${workerResume}`;
        const label = workerLabel(worker);
        const delegation = this.event(session, worker.agent, "delegation", request.task, { role: "worker", workerId, workerLabel: label, taskStatus: "running", model: worker.model, reasoningEffort: worker.reasoningEffort, ...(brief.missing.length ? { metadata: { briefAutofilled: brief.missing } } : {}) });
        const delegationId = delegation?.id;
        const resumeId = resumeIdForBrief;
        if (!resumeId) setWorkerSessionId(session, workerId);
        const guard = { kill: new AbortController(), detector: new StallDetector(this.stallOptions) } as { kill: AbortController; detector: StallDetector; stall?: StallSignal };
        this.workerGuards.set(session.id, guard);
        const idleTimer = setInterval(() => {
          const stall = guard.detector.checkIdle();
          if (stall && !guard.stall) this.tripStall(session, guard, stall, worker.agent, workerId, label, delegationId);
        }, Math.min(stallCheckMs, Math.max(50, Math.floor(guard.detector.idleMs / 4))));
        idleTimer.unref();
        const runWorker = (id?: string) => this.runAgent(session, worker.agent, workerPrompt, worker.model, worker.reasoningEffort, id, controller.signal, false, false, "worker", delegationId, workerId, label, requiresGrokMedia);
        let result;
        const eventStart = session.events.length;
        try {
          try {
            result = await runWorker(resumeId);
          } catch (error) {
            if (!resumeId || controller.signal.aborted || isQuotaExhaustion(error) || guard.stall) throw error;
          }
          if (resumeId && !controller.signal.aborted && !guard.stall && (!result || result.exitCode !== 0 && !result.quotaFailure)) {
            setWorkerSessionId(session, workerId);
            this.event(session, worker.agent, "status", "이전 세션에 연결하지 못해 새 세션으로 다시 시작합니다.", { role: "worker", workerId, workerLabel: label, delegationId });
            result = await runWorker();
          }
        } catch (error) {
          if (!guard.stall) throw error;
        } finally {
          clearInterval(idleTimer);
          if (this.workerGuards.get(session.id) === guard) this.workerGuards.delete(session.id);
        }
        if (controller.signal.aborted) return this.finishStopped(session, controller);
        if (guard.stall) {
          if (result?.sessionId) setWorkerSessionId(session, workerId, result.sessionId);
          const partial = result?.finalText?.trim();
          workerResults.push(`[${label} 결과 — 앱이 정체를 감지해 중단함]\n원인: ${guard.stall.reason}\n최근 기록:\n${guard.stall.evidence.map((line) => `- ${line}`).join("\n")}${partial ? `\n중단 전 마지막 응답:\n${partial.slice(-1_500)}` : ""}\n→ 같은 방법을 반복하지 말고 원인을 진단해 다른 접근으로 다시 계획하세요.`);
          continue;
        }
        if (!result) throw new Error("작업자 세션을 시작할 수 없습니다.");
        if (result.sessionId) setWorkerSessionId(session, workerId, result.sessionId);
        if (result.exitCode !== 0) {
          this.event(session, result.agent, "error", `${label} 워커가 종료 코드 ${result.exitCode}로 끝났습니다.`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", model: result.model, reasoningEffort: result.reasoningEffort });
          throw new Error(`${agentNames[result.agent]} 워커가 종료 코드 ${result.exitCode}로 끝났습니다.`);
        }
        const report = result.finalText || `${agentNames[result.agent]}가 결과 없이 종료되었습니다(코드 ${result.exitCode}).`;
        // Exit code 0 but the CLI reported it stopped early (e.g. Grok "cancelled"): not a success.
        const interrupted = session.events.slice(eventStart).find((event) => event.type === "error" && event.delegationId === delegationId && /중단되었습니다 \(/.test(event.text));
        if (interrupted) {
          workerResults.push(`[${label} 결과 — 중단됨: ${interrupted.text} 아래 내용은 불완전할 수 있다]\n${report}`);
          this.event(session, result.agent, "status", `작업이 중간에 중단되었습니다. ${interrupted.text}`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", model: result.model, reasoningEffort: result.reasoningEffort });
          continue;
        }
        workerResults.push(`[${label} 결과]\n${report}`);
        this.event(session, result.agent, "status", "작업을 완료했습니다.", { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "done", model: result.model, reasoningEffort: result.reasoningEffort });
      }

      if (controller.signal.aborted) return this.finishStopped(session, controller);
      const roundsLeft = maxReplanRounds - round;
      const originalContext = session.cliSessionId ? "" : `\n\n원래 사용자 요청:\n${userPrompt}\n\n당신의 첫 응답:\n${first.finalText}`;
      this.event(session, session.agent, "status", round === 0 ? "총괄이 워커 결과를 검증하고 있습니다." : `총괄이 재계획 ${round}회차 결과를 검증하고 있습니다.`, { role: "orchestrator", metadata: { phase: "verify", round } });
      const roundFailed = workerResults.some((text) => /^\[[^\]]*결과 — (앱이 정체를 감지해 중단함|중단됨)/u.test(text));
      const strict = roundFailed && roundsLeft > 0 && session.agent === "grok";
      const reviewText = `이어받기 전 압축 요약:\n${compactHandoff(session.events)}\n\n${reviewPrompt(workerResults, originalContext, roundsLeft)}` + (strict ? `\n\n[필수] 실패한 워커가 있습니다. 총괄은 파일 수정·명령 실행으로 직접 일을 하지 말고, 다른 접근의 <<DELEGATE>>로 재위임하세요. 읽기 전용 확인만 허용됩니다.` : "");
      const reviewStart = session.events.length;
      let review = await this.runAgent(session, session.agent, reviewText, session.model, session.reasoningEffort, undefined, controller.signal, false, true, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      if (review.exitCode !== 0) throw new Error(`${agentNames[session.agent]} 후속 실행이 종료 코드 ${review.exitCode}로 끝났습니다.`);
      let next = roundsLeft > 0 ? resolveRequests(review.finalText) : [];
      if (roundFailed && !next.length) {
        const selfWork = session.events.slice(reviewStart).filter((event) => event.role === "orchestrator" && (event.type === "edit" || event.type === "command" || event.type === "tool") && /^(명령|파일 (수정|쓰기|생성)|편집|쓰기)\s*:/u.test(event.text));
        this.event(session, session.agent, "warning", `검증 실패 후 총괄이 재위임하지 않고 ${selfWork.length ? `직접 작업했습니다 (${selfWork.length}건: ${selfWork.slice(0, 3).map((event) => event.text.slice(0, 60)).join(", ")})` : "마무리하려 합니다"}.`, { role: "orchestrator", metadata: { phase: "self-work", round } });
        if (strict) {
          // Enforce once: Grok orchestrators must hand the failed work back to a worker.
          review = await this.runAgent(session, session.agent, `방금 응답에 <<DELEGATE>>가 없습니다. 실패한 작업을 다른 접근으로 워커에게 재위임하세요(6개 제목 사용). 정말 재위임이 불가능하면 그 이유를 한 줄로 쓰고 끝내세요.`, session.model, session.reasoningEffort, session.cliSessionId, controller.signal, true, false, "orchestrator", undefined, undefined, undefined, requiresGrokMedia);
          if (review.sessionId) session.cliSessionId = review.sessionId;
          if (controller.signal.aborted) return this.finishStopped(session, controller);
          next = review.exitCode === 0 ? resolveRequests(review.finalText) : [];
        }
      }
      if (!next.length) return this.finish(session);
      this.event(session, session.agent, "status", `총괄이 다시 계획해 ${next.length}건을 재위임합니다 (남은 기회 ${roundsLeft - 1}회).`, { role: "orchestrator", metadata: { phase: "replan", round: round + 1 } });
      requests = next;
    }
  }

  /** Stall detected: tell the user, stop only this worker's CLI, and let the orchestrator re-plan. */
  private tripStall(session: Session, guard: { kill: AbortController; stall?: StallSignal }, stall: StallSignal, agent: AgentId, workerId: string, label: string, delegationId?: string): void {
    if (guard.stall) return;
    guard.stall = stall;
    this.event(session, agent, "warning", `정체 감지: ${stall.reason} 작업자를 멈추고 총괄이 다시 계획합니다.`, { role: "worker", workerId, workerLabel: label, delegationId, taskStatus: "error", metadata: { stall: stall.kind } });
    guard.kill.abort();
  }

  private runSelection(session: Session, selection: AgentSelection, prompt: string, resumeSessionId: string | undefined, signal: AbortSignal) {
    return this.runAgent(session, selection.agent, prompt, selection.model, selection.reasoningEffort, resumeSessionId, signal, false, true, "planner");
  }

  private applyPendingInstructions(session: Session, role: SessionEvent["role"], workerId?: string): string {
    const { taken, rest } = takePending(session.pendingInstructions, role, workerId);
    if (!taken.length) return "";
    if (rest.length) session.pendingInstructions = rest;
    else delete session.pendingInstructions;
    return instructionSuffix(taken);
  }

  private liveWorkers(session: Session): LiveWorker[] {
    return normalizeWorkerConfigs(session.workers, session.workerConfigs).map((worker) => ({
      id: worker.id!,
      label: workerLabel(worker),
      agent: worker.agent,
    }));
  }

  private enqueueInstruction(session: Session, text: string, targetWorkerId?: string): void {
    const item = { id: randomUUID(), text, targetWorkerId, createdAt: new Date().toISOString() };
    session.pendingInstructions = pushInstruction(session.pendingInstructions, item);
    const worker = this.liveWorkers(session).find((candidate) => candidate.id === targetWorkerId);
    const ack = worker
      ? `${worker.label}의 다음 턴에 넣었습니다. 진행 중인 작업은 바꾸지 않고, 그 작업자의 다음 턴에 전달합니다.`
      : "특정 작업자를 찾지 못해 총괄의 다음 턴에 넣었습니다. 진행 중인 작업은 바꾸지 않습니다.";
    this.event(session, "grok", "message", ack, { metadata: { live: "directive", targetWorkerId } });
  }

  /** A message typed while a session is already running: answer, queue, or stop. Never starts a second task. */
  async liveTurn(id: string, prompt: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status !== "running") return this.followup(id, prompt);
    const classified = classifyLiveMessage(prompt, this.liveWorkers(session));
    if (classified.intent === "stop") return this.stop(id);
    if (classified.intent === "directive") {
      this.event(session, "user", "message", prompt);
      this.enqueueInstruction(session, prompt, classified.targetWorkerId);
      return session;
    }
    // The status answer is a Grok CLI run, so it obeys the same workspace policy as every other run.
    this.assertPolicy(session.workspaceId, ["grok"]);
    const ambiguous = classified.intent === "ambiguous";
    const digest = statusDigest(session);
    this.event(session, "user", "message", prompt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    timer.unref();
    let answer = "";
    try {
      const result = await this.runner({
        agent: "grok",
        prompt: statusPrompt(prompt, digest),
        cwd: session.cwd,
        model: STATUS_AGENT_MODEL,
        readOnly: true,
        signal: controller.signal,
        usageContext: { workspaceId: session.workspaceId, sessionId: session.id, role: "status", dataDir: this.usageDataDir },
        onLine: () => undefined,
      });
      answer = result.finalText.trim();
    } catch {
      answer = "";
    } finally {
      clearTimeout(timer);
    }
    if (!answer) answer = "로그에서 상태를 정리하지 못했습니다. 작업은 그대로 진행 중입니다.";
    if (answer.length > 2000) answer = `${answer.slice(0, 1999)}…`;
    this.event(session, "grok", "message", answer, { metadata: { live: "status", ambiguous, prompt } });
    return session;
  }

  promoteLive(id: string, eventId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    const event = session.events.find((item) => item.id === eventId);
    if (!event?.metadata || event.metadata.live !== "status" || !event.metadata.ambiguous || !event.metadata.prompt) {
      throw new Error("이 응답은 지시로 바꿀 수 없습니다.");
    }
    if (event.metadata.promoted) return session;
    const prompt = event.metadata.prompt;
    event.metadata = { ...event.metadata, promoted: true };
    this.markEventsRewritten(session);
    const target = classifyLiveMessage(prompt, this.liveWorkers(session)).targetWorkerId;
    this.enqueueInstruction(session, prompt, target);
    return session;
  }

  private async runAgent(session: Session, agent: AgentId, prompt: string, model: string | undefined, reasoningEffort: string | undefined, resumeSessionId: string | undefined, signal: AbortSignal, trackPrimarySession = true, readOnly = false, role: SessionEvent["role"] = "orchestrator", delegationId?: string, workerId?: string, workerName?: string, requiresGrokMedia = false) {
    this.requireCurrentRun(session, signal);
    const pendingNote = this.applyPendingInstructions(session, role, workerId);
    if (pendingNote) prompt = `${prompt}\n\n${pendingNote}`;
    const priorAgent = agent;
    const mediaWorker = requiresGrokMedia && role === "worker";
    const grokMediaTask = agent === "grok" && requiresGrokMedia && !mediaWorker;
    // Media handoffs belong to an individual worker, never the Grok coordinator.
    const activeTarget = requiresGrokMedia ? agent : this.activeFallbackTarget(session, agent);
    const choose = (context: QuotaFallbackContext) => selectQuotaFallback(agent,
      mediaWorker ? this.mediaWorkers(session.workspaceId) : this.allowedAgents(session),
      context.authenticated, context.quotas, mediaWorker ? { [agent]: [agent === "grok" ? "codex" : "grok"] } : context.order, session.workspaceId, context.threshold);
    let mediaFallbackReason = "한도 소진";
    const switchAgent = (fallback: AgentId, resetsAt?: number) => mediaWorker
      ? this.switchMediaWorker(session, workerId, agent, fallback, model, reasoningEffort, delegationId, mediaFallbackReason)
      : this.switchExhaustedAgent(session, agent, fallback, model, reasoningEffort, resetsAt);
    if (activeTarget !== agent && (role !== "worker" || session.workers.includes(activeTarget))) {
      const mapped = equivalentFallbackModel(agent, activeTarget, model, reasoningEffort);
      agent = activeTarget;
      model = mapped.model;
      reasoningEffort = mapped.reasoningEffort;
      resumeSessionId = undefined;
      prompt = this.remapFallbackPrompt(prompt, priorAgent, agent, session, role);
    }
    const context = this.quotaFallbackResolver ? await this.quotaFallbackContext(session, signal) : undefined;
    this.requireCurrentRun(session, signal);
    const quotaState = exhaustionFromQuota(context?.quotas.find((quota) => quota.agent === agent), context?.threshold);
    if (context?.enabled && quotaState.exhausted) {
      if (grokMediaTask) throw new Error(mediaUnavailableMessage);
      const fallback = choose(context);
      if (fallback) {
        const mapped = switchAgent(fallback, quotaState.resetsAt);
        return this.runAgentOnce(session, fallback, this.remapFallbackPrompt(prompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
      }
    }

    let first;
    try {
      first = await this.runAgentOnce(session, agent, prompt, model, reasoningEffort, resumeSessionId, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
    } catch (error) {
      const missingCli = mediaWorker && /\b(?:ENOENT|EACCES)\b/.test(error instanceof Error ? error.message : String(error));
      if (!context?.enabled || !(isQuotaExhaustion(error) || missingCli) || signal.aborted) throw error;
      if (missingCli) mediaFallbackReason = "CLI 사용 불가";
      if (grokMediaTask) throw new Error(mediaUnavailableMessage, { cause: error });
      const fallback = choose(context);
      if (!fallback) throw error;
      const mapped = switchAgent(fallback, this.knownReset(context, agent));
      const retryPrompt = missingCli
        ? `${prompt}\n\n이전 워커의 CLI를 사용할 수 없어 작업을 이어받았습니다. 원래 작업을 계속 완료하세요.`
        : this.fallbackRetryPrompt(session, role, prompt, agent, error instanceof Error ? error.message : String(error), delegationId);
      try {
        return await this.runAgentOnce(session, fallback, this.remapFallbackPrompt(retryPrompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
      } catch (retryError) {
        if (isQuotaExhaustion(retryError)) Object.assign(retryError as object, { quotaFailure: true });
        throw retryError;
      }
    }

    const exhaustedEvidence = first.quotaErrorEvidence || first.exitCode !== 0 && isQuotaExhaustion(first.outputText);
    if (!context?.enabled || !exhaustedEvidence || signal.aborted) return first;
    if (grokMediaTask) throw new Error(mediaUnavailableMessage);
    const fallback = choose(context);
    if (!fallback) return { ...first, exitCode: first.exitCode || 1, quotaFailure: true };
    const mapped = switchAgent(fallback, this.knownReset(context, agent));
    const retryPrompt = this.fallbackRetryPrompt(session, role, prompt, agent, first.outputText, delegationId);
    const retried = await this.runAgentOnce(session, fallback, this.remapFallbackPrompt(retryPrompt, agent, fallback, session, role), mapped.model, mapped.reasoningEffort, undefined, signal, trackPrimarySession, readOnly, role, delegationId, workerId, workerName);
    const retryExhausted = retried.quotaErrorEvidence || retried.exitCode !== 0 && isQuotaExhaustion(retried.outputText);
    return retryExhausted ? { ...retried, exitCode: retried.exitCode || 1, quotaFailure: true } : retried;
  }

  private async runAgentOnce(session: Session, agent: AgentId, prompt: string, model: string | undefined, reasoningEffort: string | undefined, resumeSessionId: string | undefined, signal: AbortSignal, trackPrimarySession = true, readOnly = false, role: SessionEvent["role"] = "orchestrator", delegationId?: string, workerId?: string, workerName?: string) {
    this.requireCurrentRun(session, signal);
    this.assertPolicy(session.workspaceId, [agent]);
    if (agent === "claude") prompt = prompt.replace(`${personalMediaPromptHint}\n\n`, "");
    const originalDelegation = delegationId ? session.events.find((event) => event.id === delegationId) : undefined;
    if (role === "worker" && originalDelegation && originalDelegation.agent !== agent) {
      this.event(session, agent, "status", "작업을 이어받고 있습니다.", { role: "worker", workerId, workerLabel: workerName, delegationId, taskStatus: "running", model, reasoningEffort });
    }
    let lastCompleteMessage = "";
    const output: string[] = [];
    let quotaErrorEvidence = false;
    const disabledMcp = (await loadToolSettings(this.usageDataDir))[session.workspaceId].disabledMcp;
    this.requireCurrentRun(session, signal);
    const blockedMcp = disabledMcp.filter((key) => key.startsWith(`${agent}:`))
      .map((key) => `mcp__${key.slice(agent.length + 1)}__*`);
    const guard = role === "worker" ? this.workerGuards.get(session.id) : undefined;
    const runSignal = guard ? AbortSignal.any([signal, guard.kill.signal]) : signal;
    const result = await this.runner({
      blockedMcp,
      agent, prompt, cwd: session.cwd, model, reasoningEffort, readOnly, resumeSessionId, signal: runSignal,
      usageContext: { workspaceId: session.workspaceId, sessionId: session.id, role, dataDir: this.usageDataDir },
      onLine: (line) => {
        if (this.controllers.get(session.id)?.signal !== signal) return;
        if (line.type !== "message" && isPureNoise(line.text)) return;
        if (line.type !== "message") line = { ...line, text: stripToolNoise(line.text) };
        if (guard && !guard.stall) {
          const stall = guard.detector.observe(line);
          if (stall) this.tripStall(session, guard, stall, agent, workerId ?? agent, workerName ?? agent, delegationId);
        }
        output.push(line.text);
        if (line.type === "error" && isQuotaExhaustion(line.text)) quotaErrorEvidence = true;
        if (trackPrimarySession && line.sessionId && agent === session.agent) session.cliSessionId = line.sessionId;
        if (role === "worker" && workerId && line.sessionId) setWorkerSessionId(session, workerId, line.sessionId);
        if (line.type === "message" && !line.appendFinal) {
          if (line.text === lastCompleteMessage) return;
          lastCompleteMessage = line.text;
        }
        this.event(session, agent, line.type, line.text, { role, workerId, workerLabel: workerName, delegationId, model, reasoningEffort });
      },
    });
    return { ...result, agent, model, reasoningEffort, outputText: `${output.join("\n")}\n${result.finalText}`, quotaErrorEvidence, quotaFailure: false };
  }

  private async quotaFallbackContext(session: Session, signal?: AbortSignal): Promise<QuotaFallbackContext | undefined> {
    if (!this.quotaFallbackResolver) return;
    try { return await this.quotaFallbackResolver(session); }
    catch {
      if (signal && !this.isCurrentRun(session, signal)) return;
      const warning = "한도 정보를 불러오지 못해 자동 전환을 건너뜁니다.";
      if (!session.events.some((event) => event.type === "status" && event.text === warning)) {
        this.event(session, session.agent, "status", warning, { role: "orchestrator" });
      }
      return;
    }
  }

  private activeFallbackTarget(session: Session, initial: AgentId): AgentId {
    let current = initial;
    for (let step = 0; step < 3; step++) {
      const handoff = [...session.events].reverse().find((event) => event.metadata?.quotaFallback && !event.metadata.undone && event.metadata.from === current);
      if (!handoff?.metadata?.to || handoff.metadata.to === current) break;
      current = handoff.metadata.to;
    }
    return current;
  }

  private knownReset(context: QuotaFallbackContext, agent: AgentId): number | undefined {
    const now = Date.now() / 1_000;
    return context.quotas.find((quota) => quota.agent === agent)?.windows
      .map((window) => window.resetsAt)
      .filter((reset): reset is number => reset !== undefined && reset > now)
      .sort((left, right) => left - right)[0];
  }

  private remapFallbackPrompt(prompt: string, from: AgentId, to: AgentId, session: Session, role?: SessionEvent["role"]): string {
    const workers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    const roster = prompt.replace(/사용 가능한 워커: .*?(?=\. 워커에게 일을 맡길 때는)/u, `사용 가능한 워커: ${workerRoster(workers)}`);
    if (role !== "orchestrator" && role !== "worker") return roster;
    return retargetCliNotes(roster, from, to, role);
  }

  private switchMediaWorker(session: Session, workerId: string | undefined, from: AgentId, to: AgentId, model?: string, effort?: string, delegationId?: string, reason = "한도 소진") {
    const mapped = equivalentFallbackModel(from, to, model, effort);
    const before = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workerConfigs = before.map((worker) => worker.id === workerId
      ? { ...worker, agent: to, ...mapped, sessionMode: "new" }
      : worker);
    session.workers = session.workerConfigs.map((worker) => worker.agent);
    clearChangedWorkerSessions(session, before, session.workerConfigs);
    this.event(session, to, "status", `${agentNames[from]} ${reason} → ${agentNames[to]} 워커로 전환`, {
      role: "worker", workerId, delegationId, taskStatus: "running", ...mapped,
    });
    return mapped;
  }

  private switchExhaustedAgent(session: Session, exhausted: AgentId, fallback: AgentId, invocationModel?: string, invocationEffort?: string, resetsAt?: number): { model?: string; reasoningEffort?: string } {
    const previousConfig = this.teamConfig(session);
    const previousPlanner = session.planner ? structuredClone(session.planner) : undefined;
    const primaryMapped = equivalentFallbackModel(exhausted, fallback, session.model, session.reasoningEffort);
    if (session.agent === exhausted) {
      session.handoffContext = this.conversationSummary(session, exhausted);
      session.agent = fallback;
      session.model = primaryMapped.model;
      session.reasoningEffort = primaryMapped.reasoningEffort;
      delete session.cliSessionId;
    }
    const previousWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.workers = session.workers.map((worker) => worker === exhausted ? fallback : worker);
    session.workerConfigs = session.workerConfigs?.map((config) => {
      if (config.agent !== exhausted) return config;
      return { ...config, agent: fallback, ...equivalentFallbackModel(exhausted, fallback, config.model, config.reasoningEffort), sessionMode: "new" };
    });
    session.workerConfigs = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    if (session.planner?.agent === exhausted) {
      session.planner = { ...session.planner, agent: fallback, ...equivalentFallbackModel(exhausted, fallback, session.planner.model, session.planner.reasoningEffort), sessionMode: "new" };
    }
    clearChangedWorkerSessions(session, previousWorkers, session.workerConfigs);
    const resetLabel = resetsAt === undefined ? "" : ` (리셋 ${new Date(resetsAt * 1_000).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\. /gu, "/").replace(/\./gu, "")})`;
    this.event(session, fallback, "handoff", `${agentNames[exhausted]} 한도 소진 → ${agentNames[fallback]}로 전환${resetLabel}`, {
      role: "orchestrator",
      model: session.agent === fallback ? session.model : undefined,
      reasoningEffort: session.agent === fallback ? session.reasoningEffort : undefined,
      metadata: { auto: true, quotaFallback: true, from: exhausted, to: fallback, reason: "한도 소진", resetsAt, previousConfig, previousPlanner },
    });
    return equivalentFallbackModel(exhausted, fallback, invocationModel, invocationEffort);
  }

  private fallbackRetryPrompt(session: Session, role: SessionEvent["role"], originalPrompt: string, exhausted: AgentId, output: string, delegationId?: string): string {
    const partial = output.replace(/\s+/gu, " ").trim().slice(-2_000) || "기록된 진행 내용이 없습니다.";
    const task = role === "worker"
      ? session.events.find((event) => event.id === delegationId || event.delegationId === delegationId)?.text ?? originalPrompt
      : originalPrompt;
    const conversation = role === "orchestrator" ? `\n\n이전 대화 요약:\n${this.conversationSummary(session, exhausted)}` : "";
    const delegatedTask = role === "worker" ? `\n\n원래 위임 작업:\n${task}` : "";
    return `${originalPrompt}${delegatedTask}${conversation}\n\n한도 소진으로 작업을 이어받았습니다. 원래 작업을 계속 완료하세요.\n지금까지의 로그:\n${partial}`;
  }

  async followup(id: string, prompt: string, skills: string[] = [], settings: ConversationSettings = {}): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("세션이 이미 실행 중입니다.");
    const mediaRequest = await this.isMediaRequest(prompt, [...(session.skills ?? []), ...skills], session.workspaceId);
    if (session.workspaceId === "company" && mediaRequest) throw new Error(companyMediaUnavailableMessage);
    this.assertSessionPolicy(session);
    session.status = "running";
    delete session.endedAt;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    if (settings.mode !== undefined) session.mode = settings.mode;
    if (settings.autoSwitch !== undefined) session.autoSwitch = settings.autoSwitch;
    session.turnCount = (session.turnCount ?? session.events.filter((event) => event.agent === "user" && event.type === "message").length) + 1;
    this.event(session, "user", "message", prompt);
    const allowed = new Set(this.allowedAgents(session));
    if (mediaRequest && !allowed.has("grok")) {
      this.fail(session, new Error(mediaUnavailableMessage), controller);
      return session;
    }
    if (mediaRequest && (session.agent !== "grok" || session.model !== "grok-4.7")) {
      const workers = session.agent === "grok" ? session.workers : this.mediaWorkers(session.workspaceId);
      this.applyTeam(session, {
        agent: "grok", model: "grok-4.7", workers,
        workerConfigs: normalizeWorkerConfigs(workers, session.workerConfigs),
      });
    }
    let mediaRoutingUnavailable = false;
    if (this.autoRouter && session.mode === "auto" && session.autoSwitch !== false &&
      (mediaRequest || session.lastAutoSwitchTurn === undefined || session.turnCount - session.lastAutoSwitchTurn > 2)) {
      try {
        const recommendation = await this.autoRouter(session, prompt, controller.signal);
        if (mediaRequest && (!recommendation || recommendation.agent !== "grok" || !allowed.has("grok"))) {
          mediaRoutingUnavailable = true;
        } else if (!controller.signal.aborted && recommendation && recommendation.confidence >= 0.85 &&
          (recommendation.agent !== session.agent || mediaRequest && (session.model !== "grok-4.7" || session.workers.join(",") !== recommendation.workers.filter((agent) => allowed.has(agent)).join(","))) && allowed.has(recommendation.agent)) {
          const previousConfig = this.teamConfig(session);
          const candidate = session.workerConfigs?.find((config) => config.agent === recommendation.agent);
          const workers = (mediaRequest ? recommendation.workers : session.workers).filter((agent) => allowed.has(agent));
          if (!workers.length) throw new Error("허용된 작업자를 한 명 이상 선택하세요.");
          session.lastAutoSwitchTurn = session.turnCount;
          this.applyTeam(session, {
            agent: recommendation.agent,
            model: mediaRequest ? "grok-4.7" : candidate?.model ?? (recommendation.agent === "grok" ? "grok-4.7" : undefined),
            reasoningEffort: mediaRequest ? undefined : candidate?.reasoningEffort,
            workers, workerConfigs: normalizeWorkerConfigs(workers, session.workerConfigs),
          }, { auto: true, from: session.agent, to: recommendation.agent, reason: recommendation.reason, previousConfig });
        }
      } catch { if (mediaRequest) mediaRoutingUnavailable = true; }
    }
    if (mediaRequest && session.mode === "auto" && session.autoSwitch !== false && mediaRoutingUnavailable) {
      this.fail(session, new Error(mediaUnavailableMessage), controller);
      return session;
    }
    if (controller.signal.aborted) return session;
    const config = this.configs.get(id) ?? { skills: [], systemPrompt: "" };
    const selectedSkills = [...new Set([...config.skills, ...skills, ...mediaSkills(prompt, await enabledPublicSkills(session.cwd, false, (await loadToolSettings(this.usageDataDir))[session.workspaceId].disabledSkills))])];
    void this.execute(session, prompt, selectedSkills, config.systemPrompt, controller, mediaRequest)
      .catch((error) => this.fail(session, error, controller));
    return session;
  }

  setGroup(id: string, groupId?: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (groupId) session.groupId = groupId;
    else delete session.groupId;
    this.broadcast(session);
    return session;
  }

  setWorkspace(id: string, workspaceId: Session["workspaceId"], detachFromGroup = true): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") this.assertPolicy(workspaceId, [session.agent, ...session.workers, ...(session.planner ? [session.planner.agent] : [])]);
    session.workspaceId = workspaceId;
    if (detachFromGroup) delete session.groupId;
    this.broadcast(session);
    return session;
  }

  rename(id: string, title: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    session.title = title;
    this.broadcast(session);
    return session;
  }

  updateTeam(id: string, input: UpdateTeamInput): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    this.assertPolicy(session.workspaceId, [input.agent, ...input.workers]);
    return this.applyTeam(session, input);
  }

  private teamConfig(session: Session): UpdateTeamInput {
    return structuredClone({ agent: session.agent, model: session.model, reasoningEffort: session.reasoningEffort,
      workers: session.workers, workerConfigs: session.workerConfigs });
  }

  undoHandoff(id: string, eventId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    const latest = [...session.events].reverse().find((event) => event.type === "handoff");
    if (latest?.id !== eventId || !latest.metadata?.auto || latest.metadata.undone || !latest.metadata.previousConfig || latest.metadata.to !== session.agent) {
      throw new Error("되돌릴 수 있는 최신 자동 전환이 아닙니다.");
    }
    session.lastAutoSwitchTurn = session.turnCount ?? session.events.filter((event) => event.agent === "user" && event.type === "message").length;
    latest.metadata.undone = true;
    this.markEventsRewritten(session);
    return this.updateTeam(id, latest.metadata.previousConfig);
  }

  async returnFromQuotaFallback(id: string, eventId: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중에는 팀을 변경할 수 없습니다.");
    const latest = [...session.events].reverse().find((event) => event.type === "handoff");
    if (latest?.id !== eventId || !latest.metadata?.quotaFallback || latest.metadata.undone || !latest.metadata.previousConfig || !latest.metadata.from) {
      throw new Error("돌아갈 수 있는 최신 한도 전환이 아닙니다.");
    }
    const context = await this.quotaFallbackContext(session);
    const originalQuota = context?.quotas.find((quota) => quota.agent === latest.metadata!.from);
    const resetPassed = latest.metadata.resetsAt !== undefined && latest.metadata.resetsAt <= Date.now() / 1_000;
    const now = Date.now();
    const quotaIsFresh = originalQuota && (!originalQuota.updatedAt || Date.parse(originalQuota.updatedAt) >= now - 24 * 60 * 60 * 1_000);
    const activeWindows = originalQuota?.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now / 1_000) ?? [];
    const freshQuotaAvailable = Boolean(quotaIsFresh && activeWindows.length
      && activeWindows.every((window) => window.remainingPercent > (context?.threshold ?? 3)));
    if (context && !context.authenticated.includes(latest.metadata.from)) throw new Error(`${agentNames[latest.metadata.from]} 인증이 필요합니다.`);
    if (exhaustionFromQuota(originalQuota, context?.threshold).exhausted || (!freshQuotaAvailable && !resetPassed)) throw new Error(`${agentNames[latest.metadata.from]} 한도가 아직 복구되지 않았습니다.`);

    const previous = latest.metadata.previousConfig;
    this.assertPolicy(session.workspaceId, [previous.agent, ...previous.workers, ...(latest.metadata.previousPlanner ? [latest.metadata.previousPlanner.agent] : [])]);
    const fallbackAgent = session.agent;
    const orchestratorChanged = fallbackAgent !== previous.agent;
    if (orchestratorChanged) session.handoffContext = this.conversationSummary(session, fallbackAgent);
    const currentWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    session.agent = previous.agent;
    session.model = previous.model;
    session.reasoningEffort = previous.reasoningEffort;
    session.workers = [...previous.workers];
    session.workerConfigs = normalizeWorkerConfigs(session.workers, previous.workerConfigs ? structuredClone(previous.workerConfigs) : undefined);
    session.planner = latest.metadata.previousPlanner ? structuredClone(latest.metadata.previousPlanner) : undefined;
    if (orchestratorChanged) delete session.cliSessionId;
    clearChangedWorkerSessions(session, currentWorkers, session.workerConfigs);
    latest.metadata.undone = true;
    this.markEventsRewritten(session);
    const restoredWorker = session.workerConfigs?.find((config) => config.agent === latest.metadata!.from);
    this.event(session, latest.metadata.from, "handoff", `${agentNames[latest.metadata.to ?? session.agent]} → ${agentNames[latest.metadata.from]}로 돌아왔습니다`, {
      role: orchestratorChanged ? "orchestrator" : "worker",
      model: orchestratorChanged ? session.model : restoredWorker?.model,
      reasoningEffort: orchestratorChanged ? session.reasoningEffort : restoredWorker?.reasoningEffort,
      metadata: { auto: false, from: latest.metadata.to, to: latest.metadata.from, reason: "한도 복구" },
    });
    return session;
  }

  private applyTeam(session: Session, input: UpdateTeamInput, metadata?: SessionEvent["metadata"]): Session {
    this.assertPolicy(session.workspaceId, [input.agent, ...input.workers]);
    const workers = [...input.workers];
    if (!workers.length) throw new Error("작업자를 한 명 이상 선택하세요.");
    const previousWorkers = normalizeWorkerConfigs(session.workers, session.workerConfigs);
    const nextWorkers = normalizeWorkerConfigs(workers, input.workerConfigs);
    clearChangedWorkerSessions(session, previousWorkers, nextWorkers);
    if (session.planner && !this.allowedAgents(session).includes(session.planner.agent)) delete session.planner;
    const previous = session.agent;
    const switched = previous !== input.agent;
    if (switched) {
      session.handoffContext = this.conversationSummary(session, previous);
      for (const event of session.events) {
        if (!event.role && event.agent === previous && event.type === "message") event.role = "orchestrator";
      }
      this.markEventsRewritten(session);
      session.agent = input.agent;
      delete session.cliSessionId;
    }
    session.model = input.model;
    session.reasoningEffort = input.reasoningEffort;
    session.workers = workers;
    session.workerConfigs = nextWorkers;
    if (switched) {
      this.event(session, input.agent, "handoff", metadata?.auto
        ? `오케스트라 변경: ${agentNames[previous]} → ${agentNames[input.agent]} (${metadata.reason})`
        : `오케스트라가 ${agentNames[previous]} → ${agentNames[input.agent]}로 바뀌었습니다`, {
        metadata,
        role: "orchestrator", model: input.model, reasoningEffort: input.reasoningEffort,
      });
    } else this.broadcast(session);
    return session;
  }

  private conversationSummary(session: Session, orchestrator: AgentId): string {
    const lines = session.events
      .filter((event) => event.type === "message" && (event.agent === "user" || event.role === "orchestrator" || (!event.role && event.agent === orchestrator)))
      .slice(-12)
      .map((event) => `${event.agent === "user" ? "사용자" : agentNames[event.agent as AgentId]}: ${event.text.replace(/\s+/g, " ").trim()}`);
    const summary = lines.join("\n");
    return summary.length > 4_000 ? `…${summary.slice(-3_999)}` : summary || "이전 대화 내용이 없습니다.";
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    if (session.status === "running") throw new Error("실행 중인 세션은 삭제할 수 없습니다.");
    this.sessions.delete(id);
    this.controllers.delete(id);
    this.clearInactivityTimer(id);
    this.rewrittenEvents.delete(id);
    this.configs.delete(id);
    this.publishRemoval(id);
    void Promise.resolve(this.persist(this.list(), [])).catch(() => undefined);
  }

  /**
   * Deletes one worker sub-session from a chat. The chat history keeps its delegation
   * cards (marked deletedWorker) but drops the worker's own log, and the stored CLI
   * session id is cleared so the next delegation starts a fresh worker session.
   */
  removeWorker(id: string, workerId: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    const keyOf = (event: SessionEvent) => event.workerId ?? event.agent;
    const delegations = session.events.filter((event) => event.type === "delegation" && !event.metadata?.deletedWorker && keyOf(event) === workerId);
    if (!delegations.length) throw new Error("워커를 찾을 수 없습니다.");
    const delegationIds = new Set(delegations.map((event) => event.id));
    const running = session.status === "running" && delegations.some((event) => {
      const thread = session.events.filter((item) => item.delegationId === event.id && item.type !== "delegation");
      return !thread.some((item) => item.taskStatus && item.taskStatus !== "running");
    });
    if (running) {
      this.controllers.get(id)?.abort();
      this.finishStopped(session);
    }
    session.events = session.events.filter((event) => {
      if (event.type === "delegation") return true;
      if (event.delegationId && delegationIds.has(event.delegationId)) return false;
      if (!event.delegationId && event.role === "worker" && event.workerId === workerId) return false;
      return true;
    });
    for (const event of delegations) event.metadata = { ...event.metadata, deletedWorker: true };
    setWorkerSessionId(session, workerId);
    const config = session.workerConfigs?.find((worker) => worker.id === workerId);
    if (config?.agent && config.agent !== workerId) setWorkerSessionId(session, config.agent);
    this.markEventsRewritten(session);
    this.broadcast(session);
    return session;
  }

  stop(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("세션을 찾을 수 없습니다.");
    this.controllers.get(id)?.abort();
    this.finishStopped(session);
    return session;
  }

  async conversation(input: ConversationInput, bots: Bot[]): Promise<Session> {
    const botA = bots.find((bot) => bot.id === input.botA);
    const botB = bots.find((bot) => bot.id === input.botB);
    if (!botA || !botB) throw new Error("대화할 봇 두 개를 선택하세요.");
    const workspaceId = input.workspaceId ?? "personal";
    if (workspaceId === "company" && await this.isMediaRequest(input.prompt, [...botA.skills, ...botB.skills], workspaceId)) throw new Error(companyMediaUnavailableMessage);
    this.assertPolicy(workspaceId, [botA.agent, botB.agent]);
    const cwd = resolve(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("작업 폴더가 올바르지 않습니다.");
    const session: Session = { id: randomUUID(), title: `${botA.name} ↔ ${botB.name}`, agent: botA.agent, workers: [botB.agent], cwd, status: "running", createdAt: new Date().toISOString(), events: [], workspaceId };
    this.sessions.set(session.id, session);
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    this.event(session, botA.agent, "status", `${Math.min(Math.max(input.turns, 1), 20)}턴 봇 대화를 시작했습니다.`);
    void this.executeConversation(session, botA, botB, input.prompt, input.turns, controller).catch((error) => this.fail(session, error, controller));
    return session;
  }

  private async executeConversation(session: Session, botA: Bot, botB: Bot, initial: string, turns: number, controller: AbortController) {
    let message = initial;
    for (let index = 0; index < Math.min(Math.max(turns, 1), 20); index++) {
      if (controller.signal.aborted) return this.finishStopped(session, controller);
      const bot = index % 2 === 0 ? botA : botB;
      const skills = await resolveSkillPrompt(bot.skills, session.cwd, (await loadToolSettings(this.usageDataDir))[session.workspaceId].disabledSkills);
      const prompt = `${bot.systemPrompt}${skills}\n\n상대 봇의 메시지에 응답하세요. 현재 ${index + 1}/${turns}턴입니다.\n\n${message}`;
      const result = await this.runAgent(session, bot.agent, prompt, bot.model, undefined, undefined, controller.signal);
      if (result.exitCode !== 0) throw new Error(`${bot.name} 실행 실패 (코드 ${result.exitCode})`);
      message = result.finalText || "(응답 없음)";
    }
    this.finish(session);
  }

  private finish(session: Session) {
    if (session.status !== "running") return;
    session.status = "done"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    this.event(session, session.agent, "status", "세션이 완료되었습니다.");
  }
  private finishStopped(session: Session, controller?: AbortController) {
    if (controller && this.controllers.get(session.id) !== controller) return;
    if (session.status !== "running") return;
    session.status = "stopped"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    this.event(session, session.agent, "status", "중지됨");
  }
  private fail(session: Session, error: unknown, controller?: AbortController) {
    if (controller && this.controllers.get(session.id) !== controller) return;
    if (session.status !== "running") return;
    session.status = "error"; session.endedAt = new Date().toISOString(); this.controllers.delete(session.id); this.clearInactivityTimer(session.id);
    const message = error instanceof Error ? error.message : String(error);
    this.event(session, session.agent, "error", message);
  }
}
