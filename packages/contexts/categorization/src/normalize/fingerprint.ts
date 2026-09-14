// SPDX-License-Identifier: MIT
/**
 * The OpenRefine "fingerprint" key, reimplemented.
 *
 * 02 §4.2's verdict was "reimplement; BSD-3" — the algorithm is published and
 * trivial, and vendoring a Java clustering engine to get eight lines of string
 * handling would be absurd. The published recipe, in order:
 *
 *     trim -> lower case -> remove punctuation and control characters ->
 *     split on whitespace -> sort the tokens -> deduplicate -> rejoin with one
 *     space -> normalise to ASCII
 *
 * Sorting and deduplicating is what makes it worth having over a plain slug.
 * `SAFEWAY STORE SAFEWAY` and `STORE SAFEWAY` produce the same fingerprint, and
 * so do `JOE'S PIZZA & PASTA` and `PASTA PIZZA JOES` — which is exactly the
 * variation a bank introduces between two visits to one shop, and exactly the
 * variation a prefix or trigram index cannot see through.
 *
 * The order here differs from the published recipe in one place: ASCII folding
 * runs *first*, not last, because `fold()` also does NFKC, and a fullwidth digit
 * survives "remove punctuation" as a letter-like character that then sorts into
 * the wrong token. Folding first means every later step sees plain ASCII.
 *
 * **This is a key, not a name.** It is deliberately unreadable — `bottle blue
 * coffee` — and it is never shown to a user. `chooseCanonicalName` picks what a
 * human reads.
 */

import { fold } from './fold.ts';

/** Everything that is not a letter, a digit, or an ampersand. */
const NON_TOKEN = /[^\p{L}\p{N}&]+/gu;

/**
 * The fingerprint of one descriptor.
 *
 * Returns `''` for input that folds away to nothing (a descriptor of pure
 * punctuation, which real statements do contain). The caller treats an empty
 * fingerprint as "no key", never as a key that groups every such row together —
 * grouping on emptiness would put every unnameable transaction under one
 * merchant.
 */
export function fingerprint(raw: string): string {
  const folded = fold(raw).toLowerCase();
  const tokens = folded.split(NON_TOKEN).filter((token) => token !== '');
  if (tokens.length === 0) return '';
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * The n-gram fingerprint, for the case ordinary fingerprinting misses.
 *
 * OpenRefine's second keyer. It ignores word boundaries entirely — the string is
 * cut into overlapping n-grams, which are then sorted and deduplicated — so it
 * still matches when the *spacing* is what changed: `PETSMART` against `PET
 * SMART`, `ATANDT` against `AT AND T`. Two characters is OpenRefine's own
 * default and is what makes it tolerant enough to be useful; three is tight
 * enough to be nearly the same as the plain fingerprint.
 *
 * Used only as a second opinion during the fuzzy merge, never as the primary
 * grouping key: it over-matches happily, and over-merging two merchants is data
 * loss where under-merging is a UI annoyance (01 §5.2's rule, applied here).
 */
export function ngramFingerprint(raw: string, size = 2): string {
  const folded = fold(raw).toLowerCase().replaceAll(NON_TOKEN, '');
  if (folded.length === 0) return '';
  if (folded.length <= size) return folded;

  const grams = new Set<string>();
  for (let index = 0; index + size <= folded.length; index += 1) {
    grams.add(folded.slice(index, index + size));
  }
  return [...grams].sort().join('');
}
