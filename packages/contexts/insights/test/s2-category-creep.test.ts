// SPDX-License-Identifier: MIT
/**
 * C5-8, the S2 half (Phase 5 gate G5-10; Phase 4 G4-19's remainder): S2
 * (`builtin.spending.category_creep`) cites distinct recent and baseline rows
 * and does not rank a single purchase as creep.
 *
 * The gate's walk data: a category spending about $95-$129 a month, then one
 * $1,299 charge in the latest complete month. The rule printed "about $433.00 a
 * month lately, against $108.25 … about $3,897.00 a year at the new pace" and
 * cited the same month's `sourceRef` as both "A recent month" and "A month in
 * the baseline". Both halves go through the production rule over a snapshot the
 * real `SnapshotBuilder` produced (C5-11), never a hand-built result.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { TODAY, USD, seedSnapshot } from './advisors/seed.ts';

const ADVISOR_ID = 'builtin.spending.category_creep';
const SLUG = 'dining.restaurants';

function evaluate(snapshot: AdvisorSnapshot) {
  const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === ADVISOR_ID);
  if (entry === undefined) throw new Error(`no advisor ${ADVISOR_ID}`);
  return entry.rule.evaluate({ snapshot, today: TODAY, period: '2026-09', baseCurrency: USD });
}

/**
 * The drift seed's cashflow block with `SLUG`'s amount in every month replaced by
 * `minorOf(month)`. Months are `2025-06` … `2026-09`; as of `TODAY` the complete
 * ones end at `2026-08`, so the latest three are Jun, Jul, Aug 2026.
 */
async function snapshotWithDining(minorOf: (month: string) => number): Promise<AdvisorSnapshot> {
  const snapshot = await seedSnapshot('drift', ['cashflow.monthly']);
  const block = snapshot.cashflow_monthly;
  if (block === undefined) throw new Error('the seed has no cashflow block');
  return {
    ...snapshot,
    cashflow_monthly: {
      ...block,
      months: block.months.map((month) => ({
        ...month,
        by_category: month.by_category.map((row) =>
          row.category_slug === SLUG
            ? { ...row, amount: { ...row.amount, minor: String(minorOf(month.month)) } }
            : row,
        ),
      })),
    },
  };
}

/** $95-$129 a month, cycling — the gate's walk shape. */
const ORDINARY = [9_500, 12_900, 10_400, 11_200, 9_900, 12_100];
function ordinary(month: string): number {
  return ORDINARY[Number(month.slice(5)) % ORDINARY.length] ?? 10_000;
}

describe('S2 category creep (C5-8, G5-10)', () => {
  it('a single large purchase in the latest month is not creep', async () => {
    const snapshot = await snapshotWithDining((month) =>
      month === '2026-08' ? 129_900 : ordinary(month),
    );
    const output = evaluate(snapshot);
    expect(output.insights.map((insight) => insight.key)).toEqual([]);
  }, 30_000);

  it('a single large purchase in the earliest of the three recent months is not creep either', async () => {
    const snapshot = await snapshotWithDining((month) =>
      month === '2026-06' ? 129_900 : ordinary(month),
    );
    expect(evaluate(snapshot).insights).toEqual([]);
  }, 30_000);

  it('two genuinely higher months out of three still fire, and the sentence names the window it compared', async () => {
    const snapshot = await snapshotWithDining((month) =>
      month === '2026-07' || month === '2026-08' ? 30_000 : 10_000,
    );
    const output = evaluate(snapshot);
    expect(output.insights.map((insight) => insight.key)).toEqual([
      `spending.category_creep.${SLUG}`,
    ]);
    expect(output.insights[0]?.summary_md).toContain('across the six months before');
  }, 30_000);

  it('the recent and baseline evidence rows are disjoint, and no row is cited twice', async () => {
    const snapshot = await seedSnapshot('drift', ['cashflow.monthly']);
    const output = evaluate(snapshot);
    const insight = output.insights.find((item) => item.key === `spending.category_creep.${SLUG}`);
    if (insight === undefined) throw new Error('the drift seed no longer produces S2');

    const recent = insight.evidence
      .filter((row) => row.label === 'A recent month')
      .map((row) => row.source_ref);
    const baseline = insight.evidence
      .filter((row) => row.label === 'A month in the baseline')
      .map((row) => row.source_ref);
    expect(recent.length).toBeGreaterThan(0);
    expect(baseline.length).toBeGreaterThan(0);
    expect(recent.filter((ref) => baseline.includes(ref))).toEqual([]);
    // Every cited row is distinct: a row appears once in the whole panel.
    const all = insight.evidence.map((row) => row.source_ref);
    expect(new Set(all).size).toBe(all.length);
  }, 30_000);
});
