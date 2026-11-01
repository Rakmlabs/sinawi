import type { SkillInfo } from "./types.js";

export const videoKeywords = [
  "영상", "동영상", "쇼츠", "릴스", "광고 영상", "video", "shorts", "reels", "립싱크", "image to video",
];
export const imageTextKeywords = [
  "로고", "타이포", "글자", "텍스트", "한글", "목업", "mockup", "스크린샷", "앱스토어", "인포그래픽", "다이어그램", "도식",
  "상세페이지", "배너 문구", "포스터 문구", "정확히 수정", "infographic", "diagram", "logo",
];
export const imageVisualKeywords = [
  "이미지", "그림", "사진", "실사", "인물", "캐릭터", "분위기", "무드", "시네마틱", "일러스트", "썸네일", "배경", "변형",
  "image", "photo", "picture", "illustration",
];
export const marketingShortsKeywords = ["쇼츠", "릴스", "광고 영상", "마케팅 영상", "shorts", "reels"];
export const mediaGenerationKeywords = [...videoKeywords, ...imageTextKeywords, ...imageVisualKeywords];
export const mediaUnavailableMessage = "이미지/영상 작업의 Grok 조정자를 사용할 수 없습니다: 로그인·남은 한도를 확인하세요.";

/** Element/screenshot attachments carry page HTML and styles; they must never trigger media routing. */
export function stripPreviewAttachments(prompt: string): string {
  return prompt.replace(/```orchestra-attachments[\s\S]*?(?:```|$)/g, " ");
}

function includesKeyword(prompt: string, keywords: string[]): boolean {
  const text = stripPreviewAttachments(prompt).toLocaleLowerCase();
  return keywords.some((keyword) => {
    if (!/^[a-z_ ]+$/.test(keyword)) return text.includes(keyword);
    return new RegExp(`\\b${keyword}\\b`, "i").test(text);
  });
}

export function mediaGenerationRequired(prompt: string): boolean {
  return includesKeyword(prompt, mediaGenerationKeywords);
}

export function marketingShortsRequired(prompt: string): boolean {
  return includesKeyword(prompt, marketingShortsKeywords);
}

export function mediaSkills(prompt: string, skills: SkillInfo[]): string[] {
  if (!marketingShortsRequired(prompt)) return [];
  return skills.filter((skill) => [skill.id, skill.name].some((name) => /(?:^|[:/])marketing-shorts$/i.test(name))).map((skill) => skill.id);
}

export function isMediaRule(id: string): boolean {
  return ["media-generation", "marketing-shorts", "video", "image", "image-text", "image-visual"].includes(id);
}

export function mediaRouteRequired(input: string, rules: readonly { id: string; keywords: string[] }[]): boolean {
  const prompt = stripPreviewAttachments(input);
  if (/(?:docker\s+image|video\s+player|photo\s+storage\s+metadata|css\s+clip-path)/iu.test(prompt)) return false;
  return mediaGenerationRequired(prompt) || rules.some((rule) => isMediaRule(rule.id) && rule.keywords.some((keyword) => {
    const regex = keyword.trim().match(/^\/(.+)\/([dgimsuvy]*)$/u);
    if (regex) {
      try { return new RegExp(regex[1], regex[2].replace(/[gy]/gu, "")).test(prompt); }
      catch { return false; }
    }
    if (!keyword.trim() || keyword.trim().startsWith("/")) return false;
    const literal = keyword.trim();
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[a-z0-9 ]+$/i.test(literal)
      ? new RegExp(`\\b${escaped}\\b`, "i").test(prompt)
      : prompt.toLocaleLowerCase().includes(literal.toLocaleLowerCase());
  }));
}
