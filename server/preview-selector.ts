// Pure, self-contained functions. They are serialized with Function#toString into the
// script injected into previewed pages, so they must not reference outer identifiers.

export function cssSelectorFor(el: any, root: any): string {
  const esc = (value: string) => String(value).replace(/([^a-zA-Z0-9_\-\u00a0-\uffff])/g, "\\$1").replace(/^(\d)/, "\\3$1 ");
  const unique = (selector: string) => {
    try { return root.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const parts: string[] = [];
  let node = el;
  while (node && node.nodeType === 1) {
    const tag = String(node.tagName).toLowerCase();
    if (tag === "html") break;
    const id = node.id ? String(node.id) : "";
    if (id && id.length < 64 && !/^[\d]|:r[\da-z]*:|^radix-|^headlessui-/.test(id)) {
      const candidate = ["#" + esc(id), ...parts].join(" > ");
      if (unique(candidate)) return candidate;
    }
    for (const attr of ["data-testid", "data-test", "data-cy", "aria-label", "name"]) {
      const value = node.getAttribute ? node.getAttribute(attr) : null;
      if (!value || value.length > 80) continue;
      const candidate = [`${tag}[${attr}="${String(value).replace(/["\\]/g, "\\$&")}"]`, ...parts].join(" > ");
      if (unique(candidate)) return candidate;
    }
    let part = tag;
    const classes = Array.from((node.classList || []) as string[])
      .filter((name) => /^[a-zA-Z_-][\w-]*$/.test(name) && name.length < 40 && !/^(css|sc|jsx|svelte|emotion)-[\w]{4,}$/.test(name))
      .slice(0, 2);
    if (classes.length) part += "." + classes.map(esc).join(".");
    const parent = node.parentElement;
    if (parent && parent.children) {
      const siblings = Array.from(parent.children as any[]).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (unique(parts.join(" > "))) return parts.join(" > ");
    node = parent;
  }
  return parts.join(" > ") || String(el?.tagName ?? "*").toLowerCase();
}

export function trimOuterHtml(html: string, max = 1500): string {
  const compact = String(html).replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max) + ` …(+${compact.length - max}자 생략)`;
}
