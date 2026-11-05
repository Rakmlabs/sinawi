import { resolveSessionFile } from "./session-files.js";

/** Evidence mentioned in a brief or report; ignore prose and remote URLs. */
export async function existingEvidence(text: string, cwd: string, roots: string[]): Promise<string[]> {
  const paths = [...new Set(text.match(/(?:file:\/\/)?[^\s`"'<>()[\]]+\.(?:png|jpe?g|webp|gif|txt|log|md|json)(?=$|[\s`"'<>()[\],:;])/giu) ?? [])];
  const files = await Promise.all(paths.slice(0, 60).map(async (path) => {
    if (/^https?:\/\//iu.test(path)) return;
    return resolveSessionFile(cwd, path, roots).then((file) => file.file).catch(() => undefined);
  }));
  return [...new Set(files.filter((file): file is string => Boolean(file)))].sort();
}

/** Per user turn, shared by tag-based replans and delegate_task. Screenshots alone are not progress. */
export class VerifyEvidenceGuard {
  private briefs = new Map<string, number>();
  private screenshots = new Map<string, number>();

  async check(brief: string, cwd: string, roots: string[]): Promise<void> {
    // Ordinary implementation retries have their own goal/stall budgets. This guard only
    // limits screenshot passes. Generic "check"/"verify" work can name real repo files too.
    // Repeated read commands are handled by the lead's runtime StallDetector.
    if (!/(?:\bscreenshot\b|스크린샷)/iu.test(brief)) return;
    const files = (await existingEvidence(brief, cwd, roots)).filter((file) => /\.(?:png|jpe?g|webp|gif)$/iu.test(file));
    const signature = brief.replace(/\s+/gu, " ").trim();
    if ((this.briefs.get(signature) ?? 0) >= 2 || files.some((file) => (this.screenshots.get(file) ?? 0) >= 2)) {
      throw new Error(`같은 증거 검증을 2회 반복해 재위임을 멈췄습니다.${files.length ? ` 이미 있는 증거: ${files.join(", ")}.` : ""} 확인된 결과를 수용하거나, 다른 진단·방법과 새 증거로 브리프를 바꾸세요. 판단이 남으면 사용자에게 질문하거나 병합할 브랜치를 보고하세요.`);
    }
    this.briefs.set(signature, (this.briefs.get(signature) ?? 0) + 1);
    for (const file of files) this.screenshots.set(file, (this.screenshots.get(file) ?? 0) + 1);
  }
}
