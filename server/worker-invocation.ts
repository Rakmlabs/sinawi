import type { AgentId } from "./types.js";
import { briefSkillNames } from "./skill-routing.js";

interface InvocationEvidence { agent: AgentId; brief: string; skills: string; tools: string; output: string }

/** Best effort only: absence of a visible tool trace is a verification gap, not proof of non-use. */
export function workerInvocationWarnings({ agent, brief, skills, tools, output }: InvocationEvidence): string[] {
  const warnings: string[] = [];
  const needsSkill = briefSkillNames(brief).length > 0 || Boolean(skills.trim());
  const needsDesign = /\/design\b/iu.test(`${brief}\n${skills}`);
  const usedSkill = /(?:^|\n)(?:Skill\s*:|스킬 불러옴\s*:)|\bSKILL\.md\b/iu.test(tools);
  const usedDesign = /(?:^|\n)(?:Skill\s*:\s*(?:\{[^\n]*["']skill["']\s*:\s*["']\/?design["']|\/?design\b)|스킬 불러옴\s*:\s*\/?design\b|(?:SlashCommand\s*:\s*)?\/design\b)/iu.test(tools);
  if (needsSkill && !usedSkill) warnings.push("요청된 스킬의 Skill 호출 또는 SKILL.md 읽기를 출력·도구 기록에서 확인할 수 없습니다. CLI가 호출 기록을 내보내지 않았거나 스킬을 실행하지 않았을 수 있습니다. 사용 여부와 막힌 이유를 확인해 사용자에게 알리세요.");
  const failure = agent === "claude" ? `${output}\n${tools}`.split("\n").find((line, index, lines) => {
    const context = lines.slice(Math.max(0, index - 1), index + 2).join(" ");
    return (needsDesign || /(?:\/design\b|Claude Design)/iu.test(context)) && /(?:consent.{0,60}(?:required|missing|needed|not (?:granted|given))|(?:requires?|needs?).{0,40}consent|run\s+\/design consent|(?:do not|don.t|does not|doesn.t) have access|access denied|permission denied|forbidden|\b403\b|not (?:available|authorized|enabled)|authentication required|동의.{0,30}(?:필요|없)|접근.{0,20}(?:거부|불가))/iu.test(line);
  }) : undefined;
  if (failure) warnings.push(`Claude /design 사용이 막혔습니다: ${failure.trim().slice(0, 400)}. 사용자 터미널의 Claude에서 /design consent를 실행하고, 계정의 Claude Design 접근 권한을 확인해야 합니다.`);
  else if (needsDesign && !usedDesign) warnings.push("요청된 /design 호출을 출력·도구 기록에서 확인할 수 없습니다. CLI가 호출 기록을 내보내지 않았거나 /design을 실행하지 않았을 수 있습니다. 사용자 터미널의 Claude에서 /design consent가 필요한지와 접근 권한을 확인하세요.");
  return warnings;
}
