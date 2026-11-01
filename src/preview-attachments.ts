export type ElementCapture = {
  url: string; title?: string; comment?: string; selector: string; tag: string; text?: string; outerHTML: string;
  styles: Record<string, string>; rect: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number; scrollX: number; scrollY: number; dpr: number };
  react?: { name?: string; chain?: string[]; source?: string; stack?: string };
  screenshot?: string;
};

export type ComposerAttachment = {
  id: string;
  kind: "element" | "image" | "file";
  label: string;
  /** data: URL thumbnail for hover preview only; never sent to the server prompt. */
  preview?: string;
  screenshotPath?: string;
  viewportPath?: string;
  element?: Omit<ElementCapture, "screenshot">;
  size?: number;
  progress?: number;
  error?: string;
};

export function displayUrl(href: string, proxyOrigin?: string, targetOrigin?: string): string {
  if (proxyOrigin && targetOrigin && href.startsWith(proxyOrigin)) return targetOrigin + href.slice(proxyOrigin.length);
  return href;
}

export function attachmentLabel(capture: Pick<ElementCapture, "tag" | "selector" | "react" | "comment">): string {
  const base = capture.react?.name ? `<${capture.react.name}>` : capture.selector.split(" > ").at(-1) ?? capture.tag;
  return base.length > 40 ? base.slice(0, 39) + "…" : base;
}

function line(label: string, value: string | undefined) { return value ? `${label}: ${value}\n` : ""; }

/** Structured block appended to the prompt. The fence language lets the server ignore it for routing. */
export function formatAttachmentBlock(items: ComposerAttachment[]): string {
  if (!items.length) return "";
  let out = "```orchestra-attachments\n";
  out += `# 사용자가 첨부한 화면 요소 ${items.length}개. 스크린샷 파일은 직접 열어서 확인할 수 있다.\n`;
  items.forEach((item, index) => {
    out += `\n## [${index + 1}] ${item.kind === "image" ? "첨부한 이미지" : item.kind === "file" ? `첨부한 파일 ${item.label}` : item.label}\n`;
    if (item.kind === "image" || item.kind === "file") {
      out += line("파일", item.screenshotPath);
      return;
    }
    const el = item.element;
    if (!el) return;
    out += line("메모", el.comment?.trim() || undefined);
    out += line("페이지", el.url);
    out += line("selector", el.selector);
    if (el.react?.name) out += line("React 컴포넌트", (el.react.chain?.length ? el.react.chain : [el.react.name]).join(" ← "));
    out += line("소스", el.react?.source ?? el.react?.stack);
    out += `위치/크기: x=${el.rect.x} y=${el.rect.y} ${el.rect.width}×${el.rect.height}px${el.viewport ? ` (뷰포트 ${el.viewport.width}×${el.viewport.height}, 스크롤 ${el.viewport.scrollY})` : ""}\n`;
    out += line("텍스트", el.text ? JSON.stringify(el.text) : undefined);
    const styles = Object.entries(el.styles ?? {}).map(([key, value]) => `${key}: ${value}`).join("; ");
    out += line("주요 스타일", styles || undefined);
    out += line("요소 캡처", item.screenshotPath);
    out += line("전체 화면 캡처", item.viewportPath);
    out += `outerHTML:\n${el.outerHTML.replace(/```/g, "ˋˋˋ")}\n`;
  });
  return out + "```";
}

export function promptWithAttachments(prompt: string, items: ComposerAttachment[]): string {
  const block = formatAttachmentBlock(items);
  const text = prompt.trim() || (items.length ? "첨부한 요소를 확인해 줘." : "");
  return block ? `${text}\n\n${block}` : text;
}
