// SPDX-License-Identifier: MIT
import { numeric } from 'drizzle-orm/pg-core';

/**
 * A heuristic's confidence in itself: `0.0000` to `1.0000`.
 *
 * `NUMERIC(5,4)` and not `DOUBLE PRECISION`. docs/CONVENTIONS.md allows floats
 * for "percentages and confidence scores", and arithmetically a float would be
 * fine here — nothing sums these, nothing compares them for equality, and a
 * rounding error in the fourth decimal of "how sure are we?" changes no answer.
 * The column type is still numeric because the migration gate
 * (`packages/db/test/migrate.test.ts`) bans `REAL`/`DOUBLE PRECISION`/`FLOAT`
 * across the whole schema rather than adjudicating each column, and a ban with a
 * growing exception list is one that stops catching the case it was written for:
 * a float creeping into a money column. Paying four bytes for a confidence score
 * is a better trade than teaching the gate to say "unless".
 *
 * `mode: 'number'` because a confidence score really is a number in the
 * application — it is multiplied, thresholded and sorted — unlike `Quantity`,
 * which stays a decimal string precisely because it must never become a float.
 *
 * Four decimals is already more precision than any of these heuristics can
 * justify; it exists so a score can be stored back unchanged after a round trip.
 */
export function confidenceColumn(name: string) {
  return numeric(name, { precision: 5, scale: 4, mode: 'number' });
}
