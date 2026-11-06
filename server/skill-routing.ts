import type { AgentId } from "./types.js";
import type { SkillRecord } from "./skills.js";

/** The lead recommends installed skills first; workers receive the user's choices in their brief. */

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
작업에 설치된 스킬이 도움이 되면 먼저 관련 스킬 2–3개를 정확한 설치 이름과 각각 한 줄 이유로 사용자에게 추천한다(관련 스킬이 하나뿐이면 하나와 스킬 없이 진행을 제시한다). 이름을 알리지 않고 자동으로 사용하지 않는다. 공간 기본 선호 스킬은 추천 판단에 참고할 뿐 자동 선택이 아니며, 이번 요청에서 쓸 이름을 알린다.
추천은 마지막에 연속된 1. 2. 3. 번호 목록으로 쓰고, 바로 앞이나 뒤 질문은 반드시 물음표(?)로 끝낸다. 목록 뒤에 다른 설명이나 위임 블록을 붙이지 말고 사용자 선택을 기다린다. 예:
이 작업에 어떤 스킬을 쓸까요?
1. 설치된-정확한-이름 — 이 작업에 도움이 되는 한 줄 이유
2. 다른-설치된-이름 — 다른 접근의 한 줄 이유
3. 스킬 없이 진행
사용자가 고른 뒤에만 각 <<DELEGATE>> 브리프 첫 줄에 \`스킬: 선택한이름1, 선택한이름2\`를 쓴다. 같은 요청의 관련 후속 위임 브리프에도 사용자가 선택한 스킬 이름을 유지한다. 버튼의 이름·이유 전체, 번호만 쓴 답, 직접 입력한 이름 모두 앞선 추천에 대응시킨다. 사용자가 처음부터 스킬 이름을 지정했다면 그 선택을 알리고 바로 진행한다. 스킬 없이 진행을 고르면 스킬 줄을 생략한다. 맞는 스킬이 없으면 추천이나 스킬 줄 없이 진행한다.
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
  if (requestedClaudeDesign) parts.push("Claude Design `/design`은 disable-model-invocation 때문에 headless 모델이나 Skill 도구로 호출하지 않는다. 디자인은 브리프에서 함께 선택한 로컬 스킬로 완성하고, 선택한 로컬 스킬이 없으면 프로젝트의 기존 패턴과 HTML·목업 아티팩트를 사용한다. 사용자가 자기 터미널에서 대화형 `/design`을 여는 것은 선택 가능한 수동 단계다.");
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
  return { text: parts.length ? `\n\n## 이 작업에 쓸 스킬 (사용자가 선택, 앱이 붙임)\n${parts.join("\n\n")}` : "", attachedSkills };
}

/** Text-only compatibility entry point for callers that do not verify invocation traces. */
export function workerSkillSection(brief: string, skills: readonly Skill[], agent: AgentId): string {
  return workerSkillInstructions(brief, skills, agent).text;
}
