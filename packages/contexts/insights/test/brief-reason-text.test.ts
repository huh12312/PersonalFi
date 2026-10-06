// SPDX-License-Identifier: MIT
/**
 * G5-11: a not-computable retirement reason is shown in words. The route-level
 * claim (`apps/api/test/db/brief-routes.test.ts`) is the end-to-end one; this is
 * the table's own: every refusal the Brief's retirement port can carry through
 * by code has a sentence, and an unknown code never falls through as itself.
 */
import { describe, expect, it } from 'vitest';
import { REASON_FALLBACK_WORDS, retirementReasonInWords } from '../src/index.ts';

const KNOWN = [
  'no_dollar_figure',
  'no_baseline',
  'planning.scenario_no_baseline',
  'planning.projection_no_balances',
  'planning.projection_balances_unsealed',
  'planning.projection_spending_unknown',
  'planning.projection_currency_mismatch',
  'planning.projection_assumptions_stale',
];

describe('retirementReasonInWords', () => {
  it.each(KNOWN)('%s is a sentence, not a code', (code) => {
    const words = retirementReasonInWords(code);
    expect(words).not.toBe(code);
    expect(words).not.toMatch(/planning\.|_/);
    expect(words).not.toBe(REASON_FALLBACK_WORDS);
  });

  it('an unknown engine code falls back to a generic sentence, never to the code', () => {
    const words = retirementReasonInWords('planning.something_new_and_unmapped');
    expect(words).toBe(REASON_FALLBACK_WORDS);
    expect(words).not.toMatch(/planning\./);
  });
});
