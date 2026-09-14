// SPDX-License-Identifier: MIT
/**
 * Levenshtein distance, written here rather than installed.
 *
 * Decision D15 deny-lists `Levenshtein`, `python-Levenshtein` and `fuzzywuzzy`
 * (all GPL), and 02 §4.2's permissive alternatives — `fastest-levenshtein`,
 * `Fuse.js` — would each be a new runtime dependency in a repo whose threat model
 * is a malicious dependency reading the KEK (risk R1). The algorithm is thirty
 * lines and has not changed since 1965. This is the cheaper trade.
 *
 * Two properties that make it safe to call inside a clustering loop:
 *
 *   * **Bounded.** `maxDistance` is not a post-filter. The inner loop tracks the
 *     smallest value in the current row and abandons the computation the moment
 *     it exceeds the bound, returning `maxDistance + 1`. Comparing two 40-character
 *     descriptors with a bound of 3 costs a few hundred operations instead of
 *     sixteen hundred, and clustering is O(n²) in candidates, so the constant is
 *     what decides whether this is viable at all.
 *   * **Two rows, not a matrix.** Memory is O(min(a, b)), and the shorter string
 *     is always the one indexed, so the allocation is bounded by the shorter
 *     input rather than by whichever argument the caller happened to put first.
 */

/**
 * Edit distance between `a` and `b`, capped at `maxDistance`.
 *
 * Returns `maxDistance + 1` to mean "further apart than you asked about" — a
 * sentinel rather than `Infinity` so the result stays a small integer that a
 * caller can compare without a special case.
 */
export function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
  if (maxDistance < 0) return a === b ? 0 : 1;
  if (a === b) return 0;

  // Length alone can rule a pair out before a single cell is computed, and in a
  // clustering pass most pairs are ruled out exactly here.
  const lengthGap = Math.abs(a.length - b.length);
  if (lengthGap > maxDistance) return maxDistance + 1;

  // Index the shorter string so the row allocation is min(|a|, |b|) + 1.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 0) return long.length <= maxDistance ? long.length : maxDistance + 1;

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let index = 0; index <= short.length; index += 1) previous[index] = index;

  for (let row = 1; row <= long.length; row += 1) {
    current[0] = row;
    let rowMinimum = row;
    const longCharacter = long.charCodeAt(row - 1);

    for (let column = 1; column <= short.length; column += 1) {
      const substitution =
        (previous[column - 1] as number) + (short.charCodeAt(column - 1) === longCharacter ? 0 : 1);
      const deletion = (previous[column] as number) + 1;
      const insertion = (current[column - 1] as number) + 1;
      const value = Math.min(substitution, deletion, insertion);
      current[column] = value;
      if (value < rowMinimum) rowMinimum = value;
    }

    // Every cell in a later row is at least this row's minimum, so once the
    // minimum is past the bound the answer can only be "too far".
    if (rowMinimum > maxDistance) return maxDistance + 1;

    const swap = previous;
    previous = current;
    current = swap;
  }

  const result = previous[short.length] as number;
  return result > maxDistance ? maxDistance + 1 : result;
}

/**
 * Distance as a 0–1 similarity, where 1 is identical.
 *
 * Normalised by the *longer* string, which is the conservative choice: matching
 * `CVS` against `CVS PHARMACY LOCATION 4471` scores 0.11, not 1.0, so a short
 * merchant name cannot swallow a long one during a fuzzy merge. Two empty
 * strings are defined as identical rather than as a division by zero.
 */
export function similarity(
  a: string,
  b: string,
  maxDistance = Math.max(a.length, b.length),
): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const distance = boundedLevenshtein(a, b, Math.min(maxDistance, longest));
  if (distance > maxDistance) return 0;
  return 1 - distance / longest;
}
