/**
 * A deliberately small syntax tinter for chat code blocks: comments, strings, numbers, keywords and
 * literals. No grammar per language — just enough colour to scan a snippet. Joining the tokens'
 * text always gives back the input exactly, so copy and layout never depend on it.
 */

export type CodeTokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "literal";
export type CodeToken = { kind: CodeTokenKind; text: string };

const KEYWORDS = new Set([
  // JS/TS
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "enum",
  "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "of", "return", "static", "switch", "throw", "try", "type", "typeof", "var", "void",
  "while", "yield", "as",
  // Python / Rust / Go / shell, the common ones
  "def", "elif", "except", "lambda", "pass", "raise", "with", "fn", "impl", "match", "mod", "mut", "pub", "struct",
  "trait", "use", "where", "func", "go", "package", "defer", "then", "fi", "esac", "done", "echo", "export",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "this", "self"]);

// Languages where `#` starts a comment (and `//` does not).
const HASH_COMMENT = /^(?:sh|bash|zsh|shell|console|py|python|rb|ruby|yaml|yml|toml|ini|conf|dockerfile|make|makefile|r|perl)$/i;
const NO_TINT = /^(?:text|txt|plain|plaintext|md|markdown|diff|patch|log|output)$/i;

function scanner(language: string): RegExp {
  const hash = HASH_COMMENT.test(language);
  const comment = hash ? String.raw`#[^\n]*` : String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
  return new RegExp(
    [
      `(?<comment>${comment})`,
      String.raw`(?<string>"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\x60(?:[^\x60\\]|\\.)*\x60?)`,
      String.raw`(?<number>\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b)`,
      String.raw`(?<word>[A-Za-z_$][\w$]*)`,
    ].join("|"),
    "g",
  );
}

export function highlightCode(code: string, language = ""): CodeToken[] {
  if (!code) return [];
  if (NO_TINT.test(language) || code.length > 20_000) return [{ kind: "plain", text: code }];
  const tokens: CodeToken[] = [];
  const push = (kind: CodeTokenKind, text: string) => {
    if (!text) return;
    const last = tokens.at(-1);
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };
  let index = 0;
  for (const match of code.matchAll(scanner(language))) {
    push("plain", code.slice(index, match.index));
    const groups = match.groups ?? {};
    const text = match[0];
    if (groups.comment) push("comment", text);
    else if (groups.string) push("string", text);
    else if (groups.number) push("number", text);
    else if (LITERALS.has(text)) push("literal", text);
    else if (KEYWORDS.has(text)) push("keyword", text);
    else push("plain", text);
    index = match.index + text.length;
  }
  push("plain", code.slice(index));
  return tokens;
}
