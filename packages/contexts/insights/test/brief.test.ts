// SPDX-License-Identifier: MIT
/**
 * `assembleBrief` (05-phase-5-dispatch.md §3 WP 5.6; 07 §3.2; 09 ADV-1, S1,
 * E11), pure — no database. `test/db/brief.test.ts` proves persistence and
 * idempotence over a real one.
 */
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { assembleBrief, type AssembleBriefInput } from '../src/brief/assembly.ts';
import type { BriefCandidate } from '../src/brief/candidate.ts';

const USD = 'USD';
const money = (cents: bigint | number) => Money.of(BigInt(cents), USD);

let sequence = 0;

function candidate(overrides: Partial<BriefCandidate> = {}): BriefCandidate {
  sequence += 1;
  return {
    insightId: overrides.insightId ?? `insight-${String(sequence)}`,
    advisorId: overrides.advisorId ?? 'builtin.spending.fee_hunter',
    key: overrides.key ?? `spending.fee_hunter.example-${String(sequence)}`,
    type: overrides.type ?? 'spending.fee_hunter',
    severity: overrides.severity ?? 'notable',
    title: overrides.title ?? 'A finding',
    summaryMd: overrides.summaryMd ?? 'A summary.',
    confidence: overrides.confidence ?? 1,
    horizon: overrides.horizon ?? 'this_year',
    annualizedImpact:
      overrides.annualizedImpact !== undefined ? overrides.annualizedImpact : money(70_000),
    oneTimeImpact: overrides.oneTimeImpact !== undefined ? overrides.oneTimeImpact : null,
    actionKinds: overrides.actionKinds ?? ['suggest_only'],
    evidence: overrides.evidence ?? [
      {
        position: 0,
        kind: 'metric',
        label: 'Amount',
        value: '1',
        sourceRef: 'snapshot:cash_summary.as_of',
        resolvedDisplay: null,
        href: null,
      },
    ],
    inputDigest: overrides.inputDigest ?? `sha256:${'a'.repeat(64)}`,
  };
}

function baseInput(
  candidates: readonly BriefCandidate[],
  overrides: Partial<AssembleBriefInput> = {},
): AssembleBriefInput {
  return {
    candidates,
    advisorKindOf: overrides.advisorKindOf ?? (() => 'builtin'),
    dismissRateOf: overrides.dismissRateOf ?? (() => 0),
    carriedIdentities: overrides.carriedIdentities ?? new Set(),
    currencyCode: overrides.currencyCode ?? USD,
    historyDays: overrides.historyDays ?? 60,
  };
}

describe('assembleBrief', () => {
  it('the Brief holds at most five actions ranked by dollar impact times confidence, not by severity', () => {
    // 07 §3.2's own worry, put to the test: a bigger, calmer finding must
    // outrank — and, at five slots, may exclude entirely — a smaller, urgent
    // one that still claims a figure. `rank()`'s severity term would do the
    // opposite; this ranking has none.
    const bigButUnremarkable = candidate({
      key: 'investing.expense_ratio.a',
      type: 'investing.expense_ratio',
      severity: 'info',
      annualizedImpact: money(100_000), // $1,000
    });
    const urgentButSmall = candidate({
      key: 'debt.missed_payment.a',
      type: 'debt.missed_payment',
      severity: 'urgent',
      annualizedImpact: money(6_000), // $60 — above the $50 floor, but the smallest here
    });
    const others = [
      candidate({ key: 'c.3', type: 'crypto.idle_stablecoins', annualizedImpact: money(90_000) }),
      candidate({ key: 'c.4', type: 'debt.rate_above_market', annualizedImpact: money(80_000) }),
      candidate({ key: 'c.5', type: 'retirement.savings_rate', annualizedImpact: money(70_000) }),
      candidate({ key: 'c.6', type: 'investing.idle_cash', annualizedImpact: money(65_000) }),
    ];

    const result = assembleBrief(baseInput([bigButUnremarkable, urgentButSmall, ...others]));

    expect(result.ranked).toHaveLength(5);
    expect(result.ranked.map((item) => item.candidate.key)).not.toContain(urgentButSmall.key);
    expect(result.ranked[0]?.candidate.key).toBe(bigButUnremarkable.key);
    const scores = result.ranked.map((item) => item.score ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('no rule family takes more than two of the five', () => {
    const spending1 = candidate({
      key: 'spending.a',
      type: 'spending.category_anomaly',
      annualizedImpact: money(100_000),
    });
    const spending2 = candidate({
      key: 'spending.b',
      type: 'spending.fee_hunter',
      annualizedImpact: money(90_000),
    });
    // Third-highest score overall, but the third 'spending' rule — E11's rule
    // has to skip it, not just rank it last.
    const spending3 = candidate({
      key: 'spending.c',
      type: 'spending.new_merchant_high_charge',
      annualizedImpact: money(80_000),
    });
    const debt1 = candidate({
      key: 'debt.a',
      type: 'debt.rate_above_market',
      annualizedImpact: money(70_000),
    });
    const investing1 = candidate({
      key: 'investing.a',
      type: 'investing.idle_cash',
      annualizedImpact: money(60_000),
    });
    const crypto1 = candidate({
      key: 'crypto.a',
      type: 'crypto.idle_stablecoins',
      annualizedImpact: money(5_500),
    });

    const result = assembleBrief(
      baseInput([spending1, spending2, spending3, debt1, investing1, crypto1]),
    );

    expect(result.ranked).toHaveLength(5);
    const families = result.ranked.map((item) => item.candidate.type.split('.')[0]);
    expect(families.filter((family) => family === 'spending')).toHaveLength(2);
    expect(result.ranked.map((item) => item.candidate.key)).not.toContain(spending3.key);
  });

  it('an urgent finding with no dollar figure goes to the attention strip and is never dropped by a key tie-break', () => {
    const overdraft = candidate({
      key: 'a.overdraft_ahead',
      type: 'cash.projected_shortfall',
      severity: 'urgent',
      annualizedImpact: null,
      oneTimeImpact: null,
    });
    // Five ranked candidates, each its own family, each with a key that
    // sorts ahead of the attention item's alphabetically and a score high
    // enough to fill every one of the five slots — the shape wp4.9 §12 item
    // 1 found `rank()`'s bare key tie-break losing a slot under. There is no
    // combined list here for a tie-break to operate on.
    const keyedFamilies: ReadonlyArray<readonly [string, string]> = [
      ['b.one', 'investing.drift'],
      ['c.two', 'debt.rate_above_market'],
      ['d.three', 'crypto.idle_stablecoins'],
      ['e.four', 'retirement.savings_rate'],
      ['f.five', 'spending.fee_hunter'],
    ];
    const rankedCandidates = keyedFamilies.map(([key, type], index) =>
      candidate({
        key,
        type,
        annualizedImpact: money(100_000 - index * 1_000),
      }),
    );

    const result = assembleBrief(baseInput([overdraft, ...rankedCandidates]));

    expect(result.ranked).toHaveLength(5);
    expect(result.ranked.map((item) => item.candidate.key)).not.toContain(overdraft.key);
    expect(result.attention.map((item) => item.candidate.key)).toContain(overdraft.key);
  });

  it('a week with nothing material says so and invents no filler', () => {
    const belowFloorOnly = candidate({ key: 'x.trivial', annualizedImpact: money(300) }); // $3

    const result = assembleBrief(baseInput([belowFloorOnly]));

    expect(result.ranked).toHaveLength(0);
    expect(result.nothingMaterial).toBe(true);
    expect(result.attention).toHaveLength(0);
  });

  it('a finding carried from last week is marked carried, not new', () => {
    const carried = candidate({
      advisorId: 'builtin.spending.fee_hunter',
      key: 'spending.fee_hunter.a',
      annualizedImpact: money(80_000),
    });
    const fresh = candidate({
      advisorId: 'builtin.debt.rate_above_market',
      key: 'debt.rate_above_market.a',
      type: 'debt.rate_above_market',
      annualizedImpact: money(50_000),
    });
    const carriedIdentities = new Set([`${carried.advisorId}|${carried.key}`]);

    const result = assembleBrief(baseInput([carried, fresh], { carriedIdentities }));

    const carriedItem = result.ranked.find((item) => item.candidate.key === carried.key);
    const freshItem = result.ranked.find((item) => item.candidate.key === fresh.key);
    expect(carriedItem?.carried).toBe(true);
    expect(freshItem?.carried).toBe(false);
  });

  it('no Brief headline is a compounded speculative return', () => {
    const stated = money(150_000); // $1,500, exactly as the finding claims it
    const item = candidate({ annualizedImpact: stated });

    const result = assembleBrief(baseInput([item]));

    const ranked = result.ranked[0];
    // The headline figure survives assembly byte-for-byte: no growth rate,
    // no compounding, nothing applied to it.
    expect(ranked?.candidate.annualizedImpact).toEqual(stated);
    // And the ranking factor it was scored on is the claimed figure itself.
    expect(ranked?.scoreFactors?.effectiveImpactMinor).toBe('150000');
  });
});
