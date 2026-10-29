// The rule that decides, at send time, whether a message asks for file changes: one function, no model.
// A message to a profile that cannot write, asking for a change, would only come back BLOCKED after a dispatch; it is refused when it is sent.

/** Edit verbs and their forms (edit, create, write, implement, fix, change, modify, add, rename, delete, refactor). */
const VERB = /^(?:edit(?:s|ed|ing)?|creat(?:e|es|ed|ing)|writ(?:e|es|ing)|wrote|written|implement(?:s|ed|ing)?|fix(?:es|ed|ing)?|chang(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|add(?:s|ed|ing)?|renam(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|refactor(?:s|ed|ing)?)$/;
/** What a change is asked of: the words file, files, test, tests, module, function, branch, commit, or a name ending .ts, .py or .md. */
const OBJECT = /^(?:files?|tests?|module|function|branch|commit|(?:.*)?\.(?:ts|py|md))$/;
/** How many words apart (the next word is 1) a verb and an object may be. */
export const WITHIN_WORDS = 6;
export const WRITE_RULE = `an edit verb (edit, create, write, implement, fix, change, modify, add, rename, delete, refactor, in any form) within ${WITHIN_WORDS} words of file, files, test, tests, module, function, branch, commit, .ts, .py or .md, case-insensitive, excluding verbs negated in the same clause by do not, don't, never, no or without`;

/** The words of `text`, lowercase, with the punctuation around each stripped (an inner dot stays, so `lib/x.ts` is one word). */
const words = (text: string): string[] => text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z0-9.]+|[^a-z0-9]+$/g, "")).filter(Boolean);

/** Negation covers coordinated verbs until clause punctuation or a contrasting instruction. */
function negatedVerbs(text: string): Set<number> {
  const negated = new Set<number>();
  let index = 0, negative = false, previous = "";
  for (const part of text.toLowerCase().split(/(\s+)/)) {
    if (part.includes("\n") || /^[;:!?]/.test(part)) {
      negative = false;
    }
    const w = words(part)[0];
    if (!w) {
      if (/[,;:!?]/.test(part)) { negative = false; }
      continue;
    }
    if (/^(?:but|however|yet)$/.test(w)) {
      negative = false;
    }
    if (/^(?:never|no|without|don['’]t)$/.test(w) || (w === "not" && previous === "do")) {
      negative = true;
    }
    if (VERB.test(w) && negative) negated.add(index);
    previous = w; index++;
    if (/[;:!?.][\)\]"']*$/.test(part) || (/,$/.test(part) && !VERB.test(w))) {
      negative = false;
    }
  }
  return negated;
}

/** The first pair of words (verb, object) in `text` that the write rule matches, or undefined when the text does not ask for file changes. */
export function asksForChanges(text: string): { verb: string; object: string } | undefined {
  const w = words(text);
  const negated = negatedVerbs(text);
  for (let i = 0; i < w.length; i++) {
    if (!VERB.test(w[i]!) || negated.has(i)) continue;
    for (let j = Math.max(0, i - WITHIN_WORDS); j <= Math.min(w.length - 1, i + WITHIN_WORDS); j++) {
      if (j !== i && OBJECT.test(w[j]!)) return { verb: w[i]!, object: w[j]! };
    }
  }
  return undefined;
}
