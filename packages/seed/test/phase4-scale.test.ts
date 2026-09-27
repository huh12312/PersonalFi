// SPDX-License-Identifier: MIT
/**
 * WP 4.13's exit test: the scale seed's shape, its determinism, and that it
 * leaves `generatePhase3Investments` — the *correctness* seed — untouched.
 *
 * No `@ctx/*` import here at all: `phase4-scale.ts` emits generic shapes on
 * purpose (its own header explains why), so this file needs nothing beyond
 * `@core/seed` itself to grade it.
 */
import { describe, expect, it } from 'vitest';
import {
  SCALE_DAY_COUNT,
  SCALE_POSITION_COUNT,
  SCALE_TAX_BUCKETS,
  generatePhase3Investments,
  generatePhase4Scale,
} from '../src/index.ts';

describe('generatePhase4Scale', () => {
  it(
    'the scale seed generates 200 positions and five years of daily snapshots, ' +
      'byte-identically for a fixed seed',
    () => {
      const a = generatePhase4Scale(1);
      const b = generatePhase4Scale(1);
      const c = generatePhase4Scale(2);

      // --- the dispatch's own counts, asserted before anything else ---------
      expect(SCALE_POSITION_COUNT).toBe(200);
      expect(a.holdings).toHaveLength(200);
      expect(a.securities).toHaveLength(200);
      expect(new Set(a.holdings.map((h) => h.securityId)).size).toBe(200);

      expect(SCALE_DAY_COUNT).toBe(1_825);
      expect(a.days).toHaveLength(1_825);
      expect(a.days[a.days.length - 1]).toBe(a.asOf);

      // "at least four tax buckets"
      const bucketsPresent = new Set(a.accounts.map((account) => account.bucket));
      for (const bucket of SCALE_TAX_BUCKETS) expect(bucketsPresent.has(bucket)).toBe(true);
      expect(bucketsPresent.size).toBeGreaterThanOrEqual(4);

      // "five years of daily holdings_snapshots, prices and net_worth_daily"
      expect(a.prices).toHaveLength(a.securities.length * a.days.length);
      expect(a.holdingsSnapshots).toHaveLength(a.holdings.length * a.days.length);
      expect(a.netWorthDaily).toHaveLength(a.days.length);

      // a multi-currency account with a real FX series, one declared gap
      const cadAccounts = a.accounts.filter((account) => account.currency === 'CAD');
      expect(cadAccounts.length).toBeGreaterThanOrEqual(1);
      expect(a.fx).toHaveLength(a.days.length - 1);
      expect(a.fx.some((point) => point.date === a.fxGap.date)).toBe(false);
      expect(a.days.includes(a.fxGap.date)).toBe(true);

      // a plan: goals, contributions, life events
      expect(a.goals.length).toBeGreaterThanOrEqual(2);
      expect(a.contributions.length).toBeGreaterThanOrEqual(2);
      expect(a.lifeEvents.length).toBeGreaterThanOrEqual(2);
      const goalIds = new Set(a.goals.map((goal) => goal.id));
      for (const contribution of a.contributions) {
        expect(goalIds.has(contribution.goalId)).toBe(true);
      }

      // net worth per day reconciles to its own per-account breakdown
      for (const point of [a.netWorthDaily[0], a.netWorthDaily.at(-1)]) {
        const summed = point?.byAccount.reduce((sum, entry) => sum + BigInt(entry.baseMinor), 0n);
        expect(summed?.toString()).toBe(point?.assetsMinor);
        expect(point?.netWorthMinor).toBe(point?.assetsMinor); // no liabilities modelled here
      }

      // --- determinism: identical seed -> identical bytes; a different seed doesn't ---
      const jsonA = JSON.stringify(a);
      const jsonB = JSON.stringify(b);
      const jsonC = JSON.stringify(c);
      expect(jsonB).toBe(jsonA);
      expect(jsonC).not.toBe(jsonA);
    },
    30_000,
  );

  it('leaves the Phase 3 correctness seed untouched', () => {
    // Called in both orders, around a phase4-scale generation, to show neither
    // generator's PRNG stream or output is disturbed by the other's existing.
    const before = JSON.stringify(generatePhase3Investments(1));
    generatePhase4Scale(1);
    const after = JSON.stringify(generatePhase3Investments(1));
    expect(after).toBe(before);
  });
});
