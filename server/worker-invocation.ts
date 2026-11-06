import type { AgentId } from "./types.js";
import { briefSkillNames } from "./skill-routing.js";

interface InvocationEvidence { agent: AgentId; brief: string; skills: string; tools: string; output: string; attachedSkills?: readonly string[] }

/** Best effort only: absence of a visible tool trace is a verification gap, not proof of non-use. */
export function workerInvocationWarnings({ agent, brief, skills, tools, output, attachedSkills = [] }: InvocationEvidence): string[] {
  const warnings: string[] = [];
  // Claude Design is an interactive command, not a model-invocable skill.
  const names = briefSkillNames(brief);
  const needsSkill = names.length > 0
    ? names.some((name) => !attachedSkills.includes(name))
    : Boolean(skills.trim());
  const needsDesign = /\/design\b/iu.test(`${brief}\n${skills}`);
  const usedSkill = /(?:^|\n)(?:Skill\s*:|스킬 불러옴\s*:)|\bSKILL\.md\b/iu.test(tools);
  const designSkills = /(?:^|:)(?:frontend-design|impeccable|canvas-design|web-artifacts-builder)$/iu;
  const designArtifact = /(?:^|\n).*(?:Write|Edit|파일 쓰기|파일 수정)\s*:[^\n]*\.html?\b/iu.test(tools)
    || /(?:created|saved|wrote|generated|생성|저장)[^\n]*\.(?:html?|png|svg|pdf)\b/iu.test(output);
  const designSatisfied = designArtifact && names.length > 0 && names.every((name) => designSkills.test(name));
  if (needsSkill && !usedSkill && !designSatisfied) warnings.push("요청된 스킬의 Skill 호출 또는 SKILL.md 읽기를 출력·도구 기록에서 확인할 수 없습니다. CLI가 호출 기록을 내보내지 않았거나 스킬을 실행하지 않았을 수 있습니다. 사용 여부와 막힌 이유를 확인해 사용자에게 알리세요.");
  const failure = agent === "claude" ? `${output}\n${tools}`.split("\n").find((line, index, lines) => {
    const context = lines.slice(Math.max(0, index - 1), index + 2).join(" ");
    return (needsDesign || /(?:\/design\b|Claude Design|Skill[ :]+design)/iu.test(context)) && /(?:disable-model-invocation|cannot be used with Skill tool|consent.{0,60}(?:required|missing|needed|not (?:granted|given))|(?:requires?|needs?).{0,40}consent|run\s+\/design consent|(?:do not|don.t|does not|doesn.t) have access|access denied|permission denied|forbidden|\b403\b|not (?:available|authorized|enabled)|authentication required|동의.{0,30}(?:필요|없)|접근.{0,20}(?:거부|불가))/iu.test(line);
  }) : undefined;
  if (failure) warnings.push(`Claude /design 사용이 막혔습니다: ${failure.trim().slice(0, 400)}. /design은 사용자 터미널에서 수동으로 쓰는 선택 사항입니다. 재시도·재위임·실패 처리하지 말고, 선택한 로컬 스킬이 있으면 사용하고 없으면 프로젝트의 기존 패턴으로 HTML/목업 산출물을 완성하세요.`);
  return warnings;
}
