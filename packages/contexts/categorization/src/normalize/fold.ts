// SPDX-License-Identifier: MIT
/**
 * Unicode repair, before any regex gets to look at a descriptor.
 *
 * Two steps, in this order, and the order is the whole point:
 *
 *  1. **NFKC** — compatibility composition. This is what turns `ＭＣＤＯＮＡＬＤ`
 *     (fullwidth, which a Japanese-issued card statement really does send) into
 *     `MCDONALD`, `ﬁ` into `fi`, and `№` into `No`. A descriptor-stripping regex
 *     written against ASCII sees none of that without it, so the merchant splits
 *     in two and nobody can work out why.
 *  2. **Diacritic folding** — decompose to NFD and drop the combining marks, so
 *     `CAFÉ MONTMARTRE` and `CAFE MONTMARTRE` land on one key. Banks are
 *     inconsistent about accents on the same merchant between two statements,
 *     which is the actual failure this fixes.
 *
 * NFKC *before* NFD matters: NFKC is where `ﬁ` becomes `fi`, and NFD alone would
 * leave the ligature intact for the rest of the pipeline to trip over.
 *
 * Typographic punctuation is mapped to ASCII separately, because `’` in
 * `TRADER JOE’S` is not a combining mark and survives both normalisation forms.
 * A merchant whose apostrophe changes shape between statements is one merchant.
 */

/** Combining marks: the `Mn` (nonspacing) and `Mc` (spacing combining) classes. */
const COMBINING_MARKS = /\p{Mn}|\p{Mc}/gu;

/**
 * Quotes, dashes and spaces that mean the same as an ASCII character.
 *
 * Written as an explicit table rather than a `\p{Pd}`-style class because the
 * replacement differs per character — an em dash becomes a hyphen, a non-breaking
 * space becomes a space — and a class cannot express that.
 */
const PUNCTUATION_FOLD: ReadonlyMap<string, string> = new Map([
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['‛', "'"],
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['′', "'"],
  ['″', '"'],
  ['‐', '-'],
  ['‑', '-'],
  ['‒', '-'],
  ['–', '-'],
  ['—', '-'],
  ['―', '-'],
  ['−', '-'],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  ['⁄', '/'],
]);

/**
 * Control and format characters that carry no meaning in a payee name but do
 * change a string comparison. `\p{Cf}` covers the bidi overrides and the
 * zero-width joiner; a zero-width space inside a merchant name is invisible in
 * every UI and still makes two rows fail to group.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u200B-\u200D\uFEFF]/gu;

/**
 * NFKC, strip the invisible, fold the punctuation, strip the diacritics,
 * collapse the whitespace. Idempotent: `fold(fold(x)) === fold(x)`, which
 * `descriptor.test.ts` asserts as a property, because every later stage may be run
 * against input that has already been through here.
 */
export function fold(raw: string): string {
  // Whitespace becomes a space *before* control characters are deleted. A tab
  // and a newline are both `\p{Cc}`, so stripping the class first would turn
  // `BLUE\tBOTTLE` into `BLUEBOTTLE` — a different merchant, produced by a rule
  // that was only meant to remove things nobody can see.
  const composed = raw.normalize('NFKC').replaceAll(/\s/gu, ' ').replaceAll(INVISIBLE, '');

  let mapped = '';
  for (const character of composed) mapped += PUNCTUATION_FOLD.get(character) ?? character;

  return mapped.normalize('NFD').replaceAll(COMBINING_MARKS, '').replaceAll(/\s+/gu, ' ').trim();
}

/** `fold`, then upper case. The form every descriptor rule is written against. */
export function foldUpper(raw: string): string {
  return fold(raw).toUpperCase();
}
