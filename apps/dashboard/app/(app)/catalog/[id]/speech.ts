/**
 * What Quick edit hears, turned into what it should do.
 *
 * Pure, so it can be reasoned about without a microphone. Chrome's speech
 * recognition usually writes numbers as digits ("2", "10") but not always,
 * and short words get misheard ("two" as "to", "four" as "for"), so both
 * spellings are accepted. One phrase can carry several things: "2 10" is two
 * boxes then ten singles.
 */
export type SpokenCommand =
  | { kind: "number"; value: number }
  | { kind: "skip" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "back" }
  | { kind: "boxSize" }
  | { kind: "close" };

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/**
 * Words that are numbers only when said on their own. "To" alone is nearly
 * always a misheard "two"; inside "go to the next one" it is not.
 */
const MISHEARD: Record<string, number> = {
  oh: 0, none: 0, nothing: 0, won: 1, to: 2, too: 2, tree: 3, free: 3,
  for: 4, fore: 4, sex: 6, ate: 8,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Phrases first, longest first, so "next variant" never reads as "next" plus a stray word. */
const PHRASES: [RegExp, SpokenCommand][] = [
  [/\b(next|forward) (variant|flavou?r|item|one)\b/g, { kind: "next" }],
  [/\b(previous|last|prior) (variant|flavou?r|item|one)\b/g, { kind: "previous" }],
  [/\bgo back\b/g, { kind: "back" }],
  [/\bbox size\b|\bcarton size\b|\bper box\b/g, { kind: "boxSize" }],
  [/\bsave and close\b|\bsave\b|\bclose\b|\bstop\b|\bfinish\b/g, { kind: "close" }],
  [/\bskip( it| this)?\b|\bpass\b|\bnot sure\b/g, { kind: "skip" }],
];

export function parseSpoken(transcript: string): SpokenCommand[] {
  let text = ` ${transcript.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;

  // Replace each phrase with a placeholder token, keeping order in the sentence.
  const found: SpokenCommand[] = [];
  for (const [pattern, command] of PHRASES) {
    text = text.replace(pattern, () => {
      found.push(command);
      return ` §${found.length - 1} `;
    });
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length === 1 && words[0]! in MISHEARD) {
    return [{ kind: "number", value: MISHEARD[words[0]!]! }];
  }

  const out: SpokenCommand[] = [];
  let pending: number | null = null;
  const flush = () => {
    if (pending !== null) out.push({ kind: "number", value: pending });
    pending = null;
  };

  for (const token of words) {
    if (token.startsWith("§")) {
      flush();
      const command = found[Number(token.slice(1))];
      if (command) out.push(command);
      continue;
    }
    if (/^\d+$/.test(token)) {
      flush();
      out.push({ kind: "number", value: Number(token) });
      continue;
    }
    if (token === "hundred" && pending !== null && pending < 10) {
      pending *= 100;
      continue;
    }
    if (token === "and" && pending !== null && pending >= 100) continue;
    if (token in TENS) {
      if (pending !== null && pending >= 100 && pending % 100 === 0) pending += TENS[token]!;
      else {
        flush();
        pending = TENS[token]!;
      }
      continue;
    }
    if (token in TEENS) {
      if (pending !== null && pending >= 100 && pending % 100 === 0) pending += TEENS[token]!;
      else {
        flush();
        pending = TEENS[token]!;
      }
      continue;
    }
    if (token in UNITS) {
      const value = UNITS[token]!;
      if (pending !== null && pending % 10 === 0 && pending >= 20 && pending % 100 !== 0) pending += value;
      else if (pending !== null && pending >= 100 && pending % 100 === 0) pending += value;
      else {
        flush();
        pending = value;
      }
      continue;
    }
    // Anything else ("boxes", "singles", "uh") ends a number without being one.
    flush();
  }
  flush();
  return out;
}
