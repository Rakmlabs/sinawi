import { Children, isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { FileChip, ImageGrid, LinkCard } from "./media-ui";
import { WebLink } from "./WebLink";
import { clusterGallery, imageMedia, isUnfurlLink, localMediaRef, parseGalleryPayload } from "./viewer-model";
import { t, useLang } from "./i18n";

type CodeProps = { className?: string; children?: ReactNode };

function CodeBlock({ className, children }: CodeProps) {
  const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
  const code = String(children ?? "").replace(/\n$/, "");
  return <div className="code-block">
    <div className="code-toolbar">
      <span className="code-language">{language ?? "text"}</span>
      <CopyButton text={code} ariaLabel={t("markdown.copyCode")} showLabel />
    </div>
    <pre><code className={className}>{code}{"\n"}</code></pre>
  </div>;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  if (typeof src !== "string" || !src) return null;
  return <ImageGrid items={[imageMedia(src, alt ?? "")]} />;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const label = nodeText(children);
  const local = href ? localMediaRef(href, label) : undefined;
  if (local) return <FileChip item={local} />;
  if (!href) return <>{children}</>;
  return <>
    <WebLink href={href}>{children}</WebLink>
    {isUnfurlLink(href, label) && <LinkCard href={href} />}
  </>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const child = Children.only(children);
  if (isValidElement(child)) {
    const props = (child as ReactElement<CodeProps>).props;
    if (/language-orchestra-gallery/.test(props.className ?? "")) return <ImageGrid items={parseGalleryPayload(String(props.children ?? ""))} />;
    return <CodeBlock className={props.className}>{props.children}</CodeBlock>;
  }
  return <pre>{children}</pre>;
}

// Stable module-level references: inline objects/functions would remount <img> on every parent render.
const remarkPlugins = [remarkGfm];
const components = { img: MarkdownImage, a: MarkdownLink, pre: MarkdownPre };
const urlTransform = (url: string, key: string) => key === "src" && url.startsWith("file:///") ? url : defaultUrlTransform(url);

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useLang(); // memo would otherwise skip the re-render a language switch needs
  return <div className="markdown"><ReactMarkdown remarkPlugins={remarkPlugins} urlTransform={urlTransform} components={components}>{clusterGallery(text)}</ReactMarkdown></div>;
});
