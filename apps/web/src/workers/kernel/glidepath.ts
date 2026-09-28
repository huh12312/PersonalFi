// SPDX-License-Identifier: MIT
/**
 * Glidepaths — a verbatim port of
 * `packages/contexts/planning/src/engine/glidepath.ts` (07 §5.9). See
 * `prng.ts`'s header for why this is a port rather than an import. Every
 * knot and rule below is copied unchanged from the server file; only this
 * comment is new.
 */

export type EngineGlidepath =
  | { readonly kind: 'age_based' }
  | { readonly kind: 'target_date' }
  | { readonly kind: 'rising_equity' }
  | { readonly kind: 'static'; readonly equityShare: number };

export type GlidepathFunction = (age: number, retireAge: number) => number;

export const AGE_BASED_RULE = Object.freeze({
  offsetYears: 110,
  minimumEquity: 0.3,
  maximumEquity: 0.9,
});

export const TARGET_DATE_KNOTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-25, 0.9] as const),
  Object.freeze([0, 0.5] as const),
  Object.freeze([7, 0.3] as const),
]);

export const RISING_EQUITY_RULE = Object.freeze({
  equityAtRetirement: 0.4,
  equityAfterRise: 0.7,
  riseOverYears: 15,
  descentOverYears: 10,
});

function clamp(share: number, low: number, high: number): number {
  return share < low ? low : share > high ? high : share;
}

function interpolate(knots: readonly (readonly [number, number])[], x: number): number {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (first === undefined || last === undefined) throw new Error('a glidepath needs knots');
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index];
    const left = knots[index - 1];
    if (right === undefined || left === undefined) break;
    if (x <= right[0]) {
      const span = right[0] - left[0];
      return left[1] + ((x - left[0]) / span) * (right[1] - left[1]);
    }
  }
  return last[1];
}

export function ageBasedEquity(age: number): number {
  return clamp(
    (AGE_BASED_RULE.offsetYears - age) / 100,
    AGE_BASED_RULE.minimumEquity,
    AGE_BASED_RULE.maximumEquity,
  );
}

export function targetDateEquity(age: number, retireAge: number): number {
  return interpolate(TARGET_DATE_KNOTS, age - retireAge);
}

export function risingEquity(age: number, retireAge: number): number {
  const rule = RISING_EQUITY_RULE;
  const descentStart = retireAge - rule.descentOverYears;
  if (age <= descentStart) return ageBasedEquity(age);
  if (age < retireAge) {
    const from = ageBasedEquity(descentStart);
    return from + ((age - descentStart) / rule.descentOverYears) * (rule.equityAtRetirement - from);
  }
  const risen = Math.min(1, (age - retireAge) / rule.riseOverYears);
  return rule.equityAtRetirement + risen * (rule.equityAfterRise - rule.equityAtRetirement);
}

export function glidepathFunction(glidepath: EngineGlidepath): GlidepathFunction {
  switch (glidepath.kind) {
    case 'age_based':
      return (age) => ageBasedEquity(age);
    case 'target_date':
      return targetDateEquity;
    case 'rising_equity':
      return risingEquity;
    case 'static': {
      const share = glidepath.equityShare;
      if (!(share >= 0 && share <= 1)) {
        throw new RangeError(`a static equity share must be within [0, 1], got ${String(share)}`);
      }
      return () => share;
    }
  }
}
