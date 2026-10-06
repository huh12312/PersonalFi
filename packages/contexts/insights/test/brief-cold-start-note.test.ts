// SPDX-License-Identifier: MIT
/**
 * G5-8 (Phase 5 gate, C5-9): the cold-start note must agree with the items it
 * heads. The gate printed "trend-based findings — spending creep … — are not yet
 * assessable; only what a single snapshot can show is included" above two
 * `spending.category_creep` items. `historyDays` counts days since the holder's
 * first *advisor run*, not how many months of transactions the install holds;
 * a rule that compares months reads the latter, so it legitimately fires on day
 * one of a holder with imported history, and the Brief ranks it. The note
 * therefore says what a young advisor history actually costs (few earlier weeks
 * to compare with) and does not claim trend
 * findings are absent.
 */
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { assembleBrief, COLD_START_NOTE } from '../src/brief/assembly.ts';
import type { BriefCandidate } from '../src/brief/candidate.ts';

const creep: BriefCandidate = {
  insightId: 'insight-creep',
  advisorId: 'builtin.spending.category_creep',
  key: 'spending.category_creep.dining.restaurants',
  type: 'spending.category_creep',
  severity: 'notable',
  title: 'A category has been running higher than usual',
  summaryMd: 'dining.restaurants has run higher.',
  confidence: 1,
  horizon: 'this_year',
  annualizedImpact: Money.of(300_000n, 'USD'),
  oneTimeImpact: null,
  actionKinds: ['suggest_only'],
  evidence: [
    {
      position: 0,
      kind: 'metric',
      label: 'A recent month',
      value: null,
      sourceRef: 'snapshot:cashflow_monthly.months[0].by_category[0].amount.minor',
      resolvedDisplay: null,
      href: null,
    },
  ],
  inputDigest: `sha256:${'a'.repeat(64)}`,
};

function assemble(historyDays: number) {
  return assembleBrief({
    candidates: [creep],
    advisorKindOf: () => 'builtin',
    dismissRateOf: () => 0,
    carriedIdentities: new Set(),
    currencyCode: 'USD',
    historyDays,
  });
}

describe('the Brief cold-start note (G5-8)', () => {
  it('a cold-start Brief that ranks a spending-creep item does not claim trend findings are excluded', () => {
    const brief = assemble(3);
    expect(brief.coldStart).toBe(true);
    expect(brief.ranked.map((item) => item.candidate.type)).toEqual(['spending.category_creep']);
    expect(brief.coldStartNote).not.toBeNull();
    expect(brief.coldStartNote).not.toMatch(/not yet assessable/i);
    expect(brief.coldStartNote).not.toMatch(/only what a single snapshot/i);
  });

  it('says what a young advisor history does cost: few earlier weeks to compare with', () => {
    expect(COLD_START_NOTE).toMatch(/earlier weeks/i);
  });

  it('a Brief with 30 or more days of history carries no note', () => {
    const brief = assemble(30);
    expect(brief.coldStart).toBe(false);
    expect(brief.coldStartNote).toBeNull();
  });
});
