/** Pure helpers injected into the in-page picker. Keep them free of closures so `.toString()` is runnable. */

/** Implicit ARIA role. An explicit role wins. Empty string means the node is not named in the snapshot by itself. */
export function accessibleRole(tag: string, type: string, roleAttr: string, editable: boolean): string {
  if (roleAttr) return roleAttr;
  const name = tag.toLowerCase();
  if (editable && name !== "input" && name !== "textarea") return "textbox";
  if (name === "a") return "link";
  if (name === "button" || name === "summary") return "button";
  if (name === "select") return "combobox";
  if (name === "textarea") return "textbox";
  if (name === "img") return "img";
  if (name === "nav") return "navigation";
  if (name === "main") return "main";
  if (name === "header") return "banner";
  if (name === "footer") return "contentinfo";
  if (name === "aside") return "complementary";
  if (name === "form") return "form";
  if (name === "dialog") return "dialog";
  if (/^h[1-6]$/.test(name)) return "heading";
  if (name === "input") {
    const kind = (type || "text").toLowerCase();
    if (kind === "hidden") return "";
    if (kind === "button" || kind === "submit" || kind === "reset" || kind === "image") return "button";
    if (kind === "checkbox") return "checkbox";
    if (kind === "radio") return "radio";
    if (kind === "file") return "input[file]";
    if (kind === "range") return "slider";
    return "textbox";
  }
  return "";
}

/** One snapshot line. `ref` keeps the `[e12] button "저장"` token agents already use. */
export function formatNode(depth: number, role: string, name: string, ref: string | undefined, states: string[]): string {
  const bits: string[] = [];
  if (ref) bits.push(`[${ref}]`);
  bits.push(role);
  if (name) bits.push(JSON.stringify(name));
  for (let i = 0; i < states.length; i++) bits.push(states[i]);
  let pad = "";
  for (let i = 0; i < depth; i++) pad += "  ";
  return pad + bits.join(" ");
}
