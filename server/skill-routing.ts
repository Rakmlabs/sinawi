import type { AgentId } from "./types.js";
import type { SkillRecord } from "./skills.js";

/**
 * Skills the lead picks for each brief. The lead sees what is installed (name and a line of
 * description) and writes `스킬: a, b` at the top of a brief; the app hands those skills to the
 * worker: a skill the worker's CLI has natively is named so the worker opens it, any other skill's
 * instructions are attached. The user does not have to name skills for them to be used.
 */

const CATALOG_LIMIT = 200;
const DESCRIPTION_CHARS = 120;
const ATTACH_CHARS = 40_000;

type Skill = Pick<SkillRecord, "id" | "name" | "description" | "agents" | "source"> & { content?: string };

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Lead prompt section: every installed skill once, by name. */
export function skillCatalog(skills: readonly Skill[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const skill of skills) {
    const key = skill.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${skill.name}${skill.description ? `: ${oneLine(skill.description, DESCRIPTION_CHARS)}` : ""}`);
    if (lines.length >= CATALOG_LIMIT) break;
  }
  if (!lines.length) return "";
  return `\n\n## 설치된 스킬
사용자가 스킬 이름을 말하지 않아도, 위임할 작업에 맞는 스킬이 아래에 있으면 고른다. 각 <<DELEGATE>> 브리프 첫 줄에 \`스킬: 이름1, 이름2\`처럼 정확한 이름으로 적는다(최대 4개). 앱이 그 스킬을 워커에게 넘긴다. 맞는 스킬이 없으면 이 줄을 쓰지 않는다.
${lines.join("\n")}`;
}

/** Skill names from a brief's `스킬: a, b` line(s). */
export function briefSkillNames(brief: string): string[] {
  const names: string[] = [];
  for (const match of brief.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?(?:사용할[ \t]*)?스킬[ \t]*[:：][ \t]*(.+)$/gmu)) {
    for (const raw of match[1].split(/[,，、]/u)) {
      const name = raw.replace(/[`*]/gu, "").trim().replace(/^\/+/u, "");
      if (name && !/^(없음|none|-)$/iu.test(name) && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 6);
}

function findSkill(name: string, skills: readonly Skill[], agent: AgentId): Skill | undefined {
  const wanted = name.toLocaleLowerCase();
  const matches = skills.filter((skill) => {
    const own = skill.name.toLocaleLowerCase();
    return own === wanted || own.split(":").at(-1) === wanted || wanted.split(":").at(-1) === own;
  });
  return matches.find((skill) => skill.agents.includes(agent)) ?? matches[0];
}

const OPEN_HOW: Record<AgentId, string> = {
  claude: "Skill 도구로 연다",
  codex: "스킬로 열어 그 SKILL.md 절차를 따른다",
  grok: "스킬로 열어 그 절차를 따른다",
};

/** Worker prompt section for the skills its brief names; "" when it names none. */
export function workerSkillSection(brief: string, skills: readonly Skill[], agent: AgentId): string {
  const names = briefSkillNames(brief);
  if (!names.length) return "";
  const native: string[] = [];
  const attached: Skill[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const skill = findSkill(name, skills, agent);
    if (!skill) missing.push(name);
    else if (skill.agents.includes(agent)) native.push(skill.name);
    else attached.push(skill);
  }
  const parts: string[] = [];
  if (native.length) parts.push(`작업을 시작하기 전에 다음 스킬을 ${OPEN_HOW[agent]}: ${native.map((name) => `\`${name}\``).join(", ")}. 구현 단계에서도 그 지침을 따르고, 스킬이 요구하는 준비 단계를 건너뛰지 않는다.`);
  let remaining = ATTACH_CHARS;
  const bodies: string[] = [];
  for (const skill of attached) {
    if (!skill.content || remaining <= 0) continue;
    const content = skill.content.slice(0, remaining);
    remaining -= content.length;
    bodies.push(`--- ${skill.name} (${skill.source}) ---\n${content}`);
  }
  if (bodies.length) parts.push(`이 CLI에는 없는 스킬이라 지침을 붙인다. 그대로 따른다.\n${bodies.join("\n\n")}`);
  if (missing.length) parts.push(`설치되지 않은 스킬(무시하고, 보고에 적는다): ${missing.join(", ")}`);
  return parts.length ? `\n\n## 이 작업에 쓸 스킬 (총괄이 고름, 앱이 붙임)\n${parts.join("\n\n")}` : "";
}
