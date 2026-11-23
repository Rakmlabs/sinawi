import type { AgentId } from "./types.js";
import type { SkillRecord } from "./skills.js";

/** The lead picks installed skills itself and names them in the brief; workers open what the brief names. */

const CATALOG_LIMIT = 200;
const DESCRIPTION_CHARS = 120;
const ATTACH_CHARS = 40_000;

type Skill = Pick<SkillRecord, "id" | "name" | "description" | "agents" | "source"> & { content?: string };

export const isHeadlessClaudeDesign = (name: string) => /^(?:design|claude[ \t]+design)$/iu.test(name.replace(/^\/+|[`*]/gu, "").trim());

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Lead prompt section: every installed skill once, by name. */
export function skillCatalog(skills: readonly Skill[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const skill of skills) {
    if (isHeadlessClaudeDesign(skill.name)) continue;
    const key = skill.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const owners = [...new Set(skills.filter((other) => other.name.toLocaleLowerCase() === key).flatMap((other) => other.agents))];
    lines.push(`- ${skill.name}${owners.length ? ` [${owners.join(",")}]` : ""}${skill.description ? `: ${oneLine(skill.description, DESCRIPTION_CHARS)}` : ""}`);
    if (lines.length >= CATALOG_LIMIT) break;
  }
  if (!lines.length) return "";
  return `\n\n## 설치된 스킬
스킬은 담당이 직접 고른다. 사용자에게 어떤 스킬을 쓸지 묻거나 번호 목록으로 추천하지 않고, 선택을 기다리며 멈추지 않는다.
작업에 맞는 설치된 스킬이 있으면 아래 목록에서 가장 잘 맞는 것 1–2개를 골라 각 <<DELEGATE>> 브리프 첫 줄에 \`스킬: 고른이름1, 고른이름2\`로 쓰고 바로 진행한다. 고른 스킬은 진행 메시지에 \`스킬: 이름 — 한 줄 이유\`로 한 줄만 알린다(질문이 아니다). 같은 요청의 관련 후속 위임 브리프에도 같은 스킬 이름을 유지한다.
맞는 스킬이 없으면 스킬 줄 없이 그대로 진행한다. 사용자가 스킬 이름을 지정했거나 스킬을 쓰지 말라고 했으면 그 말을 그대로 따른다. 공간 기본 선호 스킬이 있으면 이번 작업에 맞을 때 그것을 먼저 고른다.
디자인·시안·목업·화면 개선 요청이면 목록의 디자인 스킬 중 맞는 것을 고르고, Claude 워커에게는 Artifact 도구가 있으면 Claude 아티팩트로 시안을 만들어 링크를 주게 한다(도구가 없으면 HTML 시안).
[claude] 같은 표시는 스킬을 기본으로 가진 CLI다. 다른 CLI 워커에게는 앱이 지침을 붙여 넘긴다. Claude Design \`/design\`은 disable-model-invocation이라 목록에서 제외한다.
${lines.join("\n")}`;
}

function requestedSkillNames(brief: string): string[] {
  const names: string[] = [];
  for (const match of brief.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?(?:사용할[ \t]*)?스킬[ \t]*[:：][ \t]*(.+)$/gmu)) {
    for (const raw of match[1].split(/[,，、]/u)) {
      const name = raw.replace(/[`*]/gu, "").trim().replace(/^\/+/u, "");
      if (name && !/^(없음|none|-)$/iu.test(name) && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 6);
}

/** Skill names from a brief's `스킬: a, b` line(s) that a headless worker can invoke. */
export function briefSkillNames(brief: string): string[] {
  return requestedSkillNames(brief).filter((name) => !isHeadlessClaudeDesign(name));
}

export function findBriefSkill(name: string, skills: readonly Skill[], agent: AgentId): Skill | undefined {
  const wanted = name.toLocaleLowerCase();
  const exact = skills.filter((skill) => skill.name.toLocaleLowerCase() === wanted);
  const aliases = wanted.includes(":") ? [] : skills.filter((skill) => skill.name.toLocaleLowerCase().split(":").at(-1) === wanted);
  const matches = exact.length ? exact : aliases;
  return matches.find((skill) => skill.agents.includes(agent)) ?? matches[0];
}

const OPEN_HOW: Record<AgentId, string> = {
  claude: "Skill 도구로 연다",
  codex: "스킬로 열어 그 SKILL.md 절차를 따른다",
  grok: "스킬로 열어 그 절차를 따른다",
};

/** Worker prompt section for the skills its brief names; "" when it names none. */
export function workerSkillInstructions(brief: string, skills: readonly Skill[], agent: AgentId): { text: string; attachedSkills: string[] } {
  const names = briefSkillNames(brief);
  const requestedClaudeDesign = requestedSkillNames(brief).some(isHeadlessClaudeDesign);
  if (!names.length && !requestedClaudeDesign) return { text: "", attachedSkills: [] };
  const native: string[] = [];
  const attached: Array<{ name: string; skill: Skill }> = [];
  const missing: string[] = [];
  for (const name of names) {
    const skill = findBriefSkill(name, skills, agent);
    if (!skill) missing.push(name);
    else if (skill.agents.includes(agent)) native.push(skill.name);
    else attached.push({ name, skill });
  }
  const parts: string[] = [];
  if (requestedClaudeDesign) parts.push("Claude Design `/design`은 disable-model-invocation 때문에 headless 모델이나 Skill 도구로 호출하지 않는다. 디자인은 브리프에 함께 적힌 로컬 스킬로 완성하고, 적힌 로컬 스킬이 없으면 프로젝트의 기존 패턴과 Claude 아티팩트(Artifact 도구가 있을 때) 또는 HTML·목업을 사용한다. 사용자가 자기 터미널에서 대화형 `/design`을 여는 것은 선택 가능한 수동 단계다.");
  if (native.length) parts.push(`작업을 시작하기 전에 다음 스킬을 ${OPEN_HOW[agent]}: ${native.map((name) => `\`${name}\``).join(", ")}. 구현 단계에서도 그 지침을 따르고, 스킬이 요구하는 준비 단계를 건너뛰지 않는다.`);
  let remaining = ATTACH_CHARS;
  const bodies: string[] = [];
  const attachedSkills: string[] = [];
  for (const { name, skill } of attached) {
    if (!skill.content || remaining <= 0) continue;
    const content = skill.content.slice(0, remaining);
    remaining -= content.length;
    attachedSkills.push(name);
    bodies.push(`--- ${skill.name} (${skill.source}) ---\n${content}`);
  }
  if (bodies.length) parts.push(`이 CLI에는 없는 스킬이라 지침을 붙인다. 그대로 따른다.\n${bodies.join("\n\n")}`);
  if (missing.length) parts.push(`설치되지 않은 스킬(무시하고, 보고에 적는다): ${missing.join(", ")}`);
  return { text: parts.length ? `\n\n## 이 작업에 쓸 스킬 (브리프에 적힘, 앱이 붙임)\n${parts.join("\n\n")}` : "", attachedSkills };
}

/** Text-only compatibility entry point for callers that do not verify invocation traces. */
export function workerSkillSection(brief: string, skills: readonly Skill[], agent: AgentId): string {
  return workerSkillInstructions(brief, skills, agent).text;
}
