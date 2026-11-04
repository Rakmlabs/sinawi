/**
 * Korean particles that depend on the word before them: 이/가, 을/를, 은/는, 과/와, 아/야, 으로/로.
 * A name from data ("담당", "백엔드", "Claude", "API") decides the particle, so a template never
 * hard-codes one ("담당가"). Also usable from the UI (src/i18n.ts `{name:이/가}`).
 */
export type JosaPair = "이/가" | "을/를" | "은/는" | "과/와" | "아/야" | "으로/로";

const PAIRS: Record<JosaPair, [withFinal: string, withoutFinal: string]> = {
  "이/가": ["이", "가"],
  "을/를": ["을", "를"],
  "은/는": ["은", "는"],
  "과/와": ["과", "와"],
  "아/야": ["아", "야"],
  "으로/로": ["으로", "로"],
};

export const isJosaPair = (value: string): value is JosaPair => value in PAIRS;

/** Digits as read in Korean (영, 일, 이, 삼, 사, 오, 육, 칠, 팔, 구): ends in a consonant, and that consonant is ㄹ. */
const DIGIT_FINAL: Record<string, [boolean, boolean]> = {
  0: [true, false], 1: [true, true], 2: [false, false], 3: [true, false], 4: [false, false],
  5: [false, false], 6: [true, false], 7: [true, true], 8: [true, true], 9: [false, false],
};

/**
 * Whether the word, read aloud, ends in a consonant (받침), and whether that consonant is ㄹ.
 * Trailing quotes, brackets and a trailing "(...)" are skipped: "'백엔드' (ab12)" reads as "백엔드".
 * Undefined when there is nothing to judge by (symbols only).
 */
export function finalConsonant(word: string): { final: boolean; rieul: boolean } | undefined {
  let text = word.trim();
  for (;;) {
    const next = text.replace(/\s*[([{][^()[\]{}]*[)\]}]$/u, "").replace(/['"’”」』>»\s.,!?…·]+$/u, "");
    if (next === text) break;
    text = next;
  }
  const last = text.at(-1);
  if (!last) return undefined;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return { final: jong !== 0, rieul: jong === 8 };
  }
  if (/\d/u.test(last)) {
    const [final, rieul] = DIGIT_FINAL[last];
    return { final, rieul };
  }
  if (/[a-z]/iu.test(last)) {
    const tail = /[a-z]+$/iu.exec(text)?.[0] ?? last;
    // An acronym is read letter by letter: only L(엘), M(엠), N(엔), R(알) end in a consonant.
    if (tail.length >= 2 && tail === tail.toUpperCase()) {
      const upper = last.toUpperCase();
      return { final: "LMNR".includes(upper), rieul: upper === "L" || upper === "R" };
    }
    const lower = tail.toLowerCase();
    if (lower.length === 1) return { final: "lmnr".includes(lower), rieul: lower === "l" || lower === "r" };
    // A word: closed by l, m, n, ng, k, p, t, b (app → 앱, chat → 챗, Grok → 그록); e, r, x, s… open.
    const final = /(?:[lmnkptb]|ng)$/u.test(lower);
    return { final, rieul: final && lower.endsWith("l") };
  }
  return undefined;
}

/** The particle for the word: josa("담당", "이/가") → "이". Unknown words get "이(가)". */
export function josa(word: string, pair: JosaPair): string {
  const [withFinal, withoutFinal] = PAIRS[pair];
  const sound = finalConsonant(word);
  if (!sound) return pair === "으로/로" ? "(으)로" : `${withFinal}(${withoutFinal})`;
  if (pair === "으로/로") return sound.final && !sound.rieul ? withFinal : withoutFinal;
  return sound.final ? withFinal : withoutFinal;
}

/** The word with its particle: withJosa("담당", "이/가") → "담당이". */
export const withJosa = (word: string, pair: JosaPair) => `${word}${josa(word, pair)}`;
