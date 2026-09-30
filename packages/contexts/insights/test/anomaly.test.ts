// SPDX-License-Identifier: MIT
/**
 * WP 5.7 — S1 and S5, `transactions.anomalies`, proved over a dedicated
 * fixture rather than the shared `test/advisors/seed.ts` one, so the exact
 * dollar figures at the $25 floor and the 3-deviation threshold are chosen
 * and hand-verified here rather than incidental to a fixture other rules
 * also depend on.
 *
 * Every category below is designed so exactly one condition is the reason a
 * candidate does or does not qualify:
 *
 *   * `test.positive` — five identical $50.00 charges (MAD exactly zero) and
 *     one $80.00 outlier: a $30.00 deviation clears both the $25 floor and
 *     `>3 robust deviations` (trivially, over a zero MAD).
 *   * `test.floor_only` — a spread baseline (median $50.05, MAD $0.15) and a
 *     candidate $24.00 over it: `2400 > 3 × 15` clears the deviation test
 *     comfortably, and `2400 < 2500` fails the $25 floor. Raises nothing.
 *   * `test.multiple_only` — a wider spread (median $65.00, MAD $15.00) and a
 *     candidate $43.50 over it: `4350 > 2500` clears the floor, and
 *     `4350 < 4500` (`3 × 1500`) fails the deviation test. Raises nothing.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import {
  spendingCategoryAnomaly,
  spendingNewMerchantHighCharge,
} from '../src/advisors/builtin/anomaly/anomaly.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { AdvisorRequest } from '../src/contract/request.ts';
import type { AdvisorManifest } from '../src/contract/manifest.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { SnapshotBuilder } from '../src/snapshot/builder.ts';
import {
  emptyPorts,
  inMemoryLedgerPort,
  type FakeLedgerData,
  type InsightsTransaction,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const USER_ID = '01930000-0000-7000-8000-0000000000a1';
const TODAY = '2026-09-19';
const USD = 'USD';

function usd(minor: bigint): Money {
  return Money.of(minor, USD);
}

function txn(input: {
  readonly id: string;
  readonly date: string;
  readonly merchantId: string | null;
  readonly categorySlug: string | null;
  readonly amountMinor: bigint;
  readonly accountId?: string;
}): InsightsTransaction {
  return {
    id: input.id,
    date: input.date as InsightsTransaction['date'],
    merchantId: input.merchantId,
    categorySlug: input.categorySlug,
    amount: usd(input.amountMinor),
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
  };
}

/**
 * Five identical $50.00 charges and one $80.00 outlier. MAD is exactly zero,
 * so the deviation test (`> 3 × 0`) is cleared by any positive deviation and
 * the $25 floor is the only real gate — the common real-world case for a
 * category with little natural spread.
 */
const POSITIVE_ROWS: readonly InsightsTransaction[] = [
  txn({
    id: 'txn-pos-0',
    date: '2026-04-01',
    merchantId: 'm-pos',
    categorySlug: 'test.positive',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-pos-1',
    date: '2026-05-01',
    merchantId: 'm-pos',
    categorySlug: 'test.positive',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-pos-2',
    date: '2026-06-01',
    merchantId: 'm-pos',
    categorySlug: 'test.positive',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-pos-3',
    date: '2026-07-01',
    merchantId: 'm-pos',
    categorySlug: 'test.positive',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-pos-4',
    date: '2026-08-01',
    merchantId: 'm-pos',
    categorySlug: 'test.positive',
    amountMinor: -5_000n,
  }),
  // The outlier: $80.00, a $30.00 deviation from the $50.00 median.
  txn({
    id: 'txn-pos-outlier',
    date: '2026-09-01',
    merchantId: 'm-pos-outlier',
    categorySlug: 'test.positive',
    amountMinor: -8_000n,
  }),
];

/** Median $50.05, MAD $0.15. A $24.00 deviation clears the deviation test and fails the floor. */
const FLOOR_ONLY_ROWS: readonly InsightsTransaction[] = [
  txn({
    id: 'txn-floor-0',
    date: '2026-04-02',
    merchantId: 'm-floor',
    categorySlug: 'test.floor_only',
    amountMinor: -4_980n,
  }),
  txn({
    id: 'txn-floor-1',
    date: '2026-05-02',
    merchantId: 'm-floor',
    categorySlug: 'test.floor_only',
    amountMinor: -4_990n,
  }),
  txn({
    id: 'txn-floor-2',
    date: '2026-06-02',
    merchantId: 'm-floor',
    categorySlug: 'test.floor_only',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-floor-3',
    date: '2026-07-02',
    merchantId: 'm-floor',
    categorySlug: 'test.floor_only',
    amountMinor: -5_010n,
  }),
  txn({
    id: 'txn-floor-4',
    date: '2026-08-02',
    merchantId: 'm-floor',
    categorySlug: 'test.floor_only',
    amountMinor: -5_020n,
  }),
  // Median so far (of the five) is 5000; the candidate's own deviation
  // (2400) is the largest so it does not shift the two middle order
  // statistics used for the median or the MAD. Deviation: 7405 - 5005 = 2400.
  txn({
    id: 'txn-floor-candidate',
    date: '2026-09-02',
    merchantId: 'm-floor-cand',
    categorySlug: 'test.floor_only',
    amountMinor: -7_405n,
  }),
];

/** Median $65.00, MAD $15.00. A $43.50 deviation clears the floor and fails 3 × MAD ($45.00). */
const MULTIPLE_ONLY_ROWS: readonly InsightsTransaction[] = [
  txn({
    id: 'txn-mult-0',
    date: '2026-04-03',
    merchantId: 'm-mult',
    categorySlug: 'test.multiple_only',
    amountMinor: -4_000n,
  }),
  txn({
    id: 'txn-mult-1',
    date: '2026-05-03',
    merchantId: 'm-mult',
    categorySlug: 'test.multiple_only',
    amountMinor: -5_000n,
  }),
  txn({
    id: 'txn-mult-2',
    date: '2026-06-03',
    merchantId: 'm-mult',
    categorySlug: 'test.multiple_only',
    amountMinor: -6_000n,
  }),
  txn({
    id: 'txn-mult-3',
    date: '2026-07-03',
    merchantId: 'm-mult',
    categorySlug: 'test.multiple_only',
    amountMinor: -7_000n,
  }),
  txn({
    id: 'txn-mult-4',
    date: '2026-08-03',
    merchantId: 'm-mult',
    categorySlug: 'test.multiple_only',
    amountMinor: -8_000n,
  }),
  txn({
    id: 'txn-mult-candidate',
    date: '2026-09-03',
    merchantId: 'm-mult-cand',
    categorySlug: 'test.multiple_only',
    amountMinor: -10_850n,
  }),
];

function ledgerOf(rows: readonly InsightsTransaction[]): FakeLedgerData {
  return { transactions: rows };
}

async function buildAnomalies(
  rows: readonly InsightsTransaction[],
): Promise<AdvisorSnapshot['transactions_anomalies']> {
  const builder = new SnapshotBuilder({
    ...emptyPorts(),
    ledger: inMemoryLedgerPort(ledgerOf(rows)),
  });
  const built = await builder.build({
    userId: USER_ID,
    kind: 'builtin',
    grantedScopes: ['transactions.anomalies'],
    today: DateOnly.parse(TODAY),
    baseCurrency: USD,
    tokenKey: deriveTokenKey('wp-5-7-anomaly-test', USER_ID),
  });
  return built.snapshot.transactions_anomalies;
}

function requestFor(manifest: AdvisorManifest, snapshot: AdvisorSnapshot): AdvisorRequest {
  return {
    contract_version: 1,
    request_id: '01930000-0000-7000-8000-0000000000b1',
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: `${TODAY}T08:00:00.000Z`,
    base_currency: USD,
    time_zone: 'America/New_York',
    today: TODAY,
    granted_scopes: [...manifest.requires_scopes],
    input_digest: `sha256:${'a'.repeat(64)}`,
    limits: {
      max_insights: manifest.limits.max_insights,
      max_response_bytes: manifest.limits.max_response_bytes,
      deadline: `${TODAY}T08:05:00.000Z`,
    },
    snapshot,
  };
}

describe('S1 — a category outlier', () => {
  it('a charge more than three robust deviations above its twelve-month norm and above the $25 floor raises S1 with the baseline shown', async () => {
    const block = await buildAnomalies(POSITIVE_ROWS);
    expect(block).not.toBeNull();
    const flagged = block?.rows.find((row) => row.category_slug === 'test.positive');
    expect(flagged, 'the $80.00 outlier should be flagged').toBeDefined();
    expect(flagged?.amount.minor).toBe('-8000');
    expect(flagged?.baseline_median?.minor).toBe('5000');

    const context = contextOf(
      requestFor(spendingCategoryAnomaly.manifest, { transactions_anomalies: block }),
    );
    const output = spendingCategoryAnomaly.evaluate(context);
    expect(output.insights).toHaveLength(1);
    expect(output.insights[0]?.summary_md).toContain('$50.00');
    expect(output.insights[0]?.summary_md).toContain('$80.00');
  });

  it('a $24 outlier and a 2.9-deviation charge raise nothing', async () => {
    const floorBlock = await buildAnomalies(FLOOR_ONLY_ROWS);
    const multipleBlock = await buildAnomalies(MULTIPLE_ONLY_ROWS);

    // Both blocks may be `null` (nothing qualified) or carry rows that never
    // include the two candidates under test — either is the same claim.
    if (floorBlock !== null && floorBlock !== undefined) {
      expect(
        floorBlock.rows.find((row) => row.category_slug === 'test.floor_only'),
        'the $24.00-deviation charge clears the deviation test but not the $25 floor',
      ).toBeUndefined();
    }

    if (multipleBlock !== null && multipleBlock !== undefined) {
      expect(
        multipleBlock.rows.find((row) => row.category_slug === 'test.multiple_only'),
        'the 2.9-deviation charge clears the $25 floor but not 3 robust deviations',
      ).toBeUndefined();
    }

    // And neither rule proposes anything for either scenario.
    for (const block of [floorBlock, multipleBlock]) {
      const context = contextOf(
        requestFor(spendingCategoryAnomaly.manifest, { transactions_anomalies: block }),
      );
      expect(spendingCategoryAnomaly.evaluate(context).insights).toEqual([]);
    }
  });

  it('an unflagged transaction never appears in the anomalies block', async () => {
    const block = await buildAnomalies(POSITIVE_ROWS);
    expect(block).not.toBeNull();
    const refs = new Set((block?.rows ?? []).map((row) => row.transaction_ref));
    // None of the five identical, unremarkable $50.00 charges may appear —
    // only the outlier they set the baseline for.
    expect(block?.rows.length).toBe(1);
    // The refs set holds only the outlier's own tokenised reference.
    expect(refs.size).toBe(1);
  });

  it('a pending charge that posts raises one anomaly, not two', async () => {
    // D10: the surrogate id survives the pending -> posted transition, so
    // the same transaction evaluated on two different days is still one row
    // under one id — and `insightOf`'s key is built from that id alone, so
    // the two runs produce the exact same insight key regardless of the
    // amount having settled in between.
    const pendingRows = [
      ...POSITIVE_ROWS.slice(0, 5),
      txn({
        id: 'txn-pending-then-posted',
        date: '2026-09-10',
        merchantId: 'm-pending',
        categorySlug: 'test.positive',
        amountMinor: -8_000n, // pending estimate: $80.00
      }),
    ];
    const postedRows = [
      ...POSITIVE_ROWS.slice(0, 5),
      txn({
        id: 'txn-pending-then-posted',
        date: '2026-09-10',
        merchantId: 'm-pending',
        categorySlug: 'test.positive',
        amountMinor: -8_050n, // posted, finalised: $80.50 -- still an anomaly
      }),
    ];

    const pendingBlock = await buildAnomalies(pendingRows);
    const postedBlock = await buildAnomalies(postedRows);

    const pendingContext = contextOf(
      requestFor(spendingCategoryAnomaly.manifest, { transactions_anomalies: pendingBlock }),
    );
    const postedContext = contextOf(
      requestFor(spendingCategoryAnomaly.manifest, { transactions_anomalies: postedBlock }),
    );
    const pendingInsights = spendingCategoryAnomaly.evaluate(pendingContext).insights;
    const postedInsights = spendingCategoryAnomaly.evaluate(postedContext).insights;

    expect(pendingInsights).toHaveLength(1);
    expect(postedInsights).toHaveLength(1);
    // Same id, same key -- the store upserts this as one row, not two.
    expect(postedInsights[0]?.key).toBe(pendingInsights[0]?.key);
  });
});

describe('S5 — a first-time high charge', () => {
  it("a first-time charge over $250 raises S5, and a repeat merchant's charge does not", async () => {
    const rows: InsightsTransaction[] = [
      txn({
        id: 'txn-new-merchant',
        date: '2026-09-05',
        merchantId: 'm-new',
        categorySlug: 'test.new_merchant',
        amountMinor: -30_000n, // $300.00, first time
      }),
      txn({
        id: 'txn-repeat-merchant-a',
        date: '2026-01-05',
        merchantId: 'm-repeat',
        categorySlug: 'test.new_merchant',
        amountMinor: -30_000n,
      }),
      txn({
        id: 'txn-repeat-merchant-b',
        date: '2026-09-06',
        merchantId: 'm-repeat',
        categorySlug: 'test.new_merchant',
        amountMinor: -30_000n, // not the merchant's first appearance
      }),
    ];
    const block = await buildAnomalies(rows);
    expect(block).not.toBeNull();

    const context = contextOf(
      requestFor(spendingNewMerchantHighCharge.manifest, { transactions_anomalies: block }),
    );
    const insights = spendingNewMerchantHighCharge.evaluate(context).insights;
    const keys = insights.map((insight) => insight.key);
    // Both merchants' *first* appearance over $250 raises S5 — `m-new`'s only
    // charge, and `m-repeat`'s earlier one. The later `m-repeat` charge does
    // not: it is not that merchant's first appearance in the window.
    expect(keys.some((key) => key.includes('txn-new-merchant'))).toBe(true);
    expect(keys.some((key) => key.includes('txn-repeat-merchant-a'))).toBe(true);
    expect(keys.some((key) => key.includes('txn-repeat-merchant-b'))).toBe(false);
    expect(insights).toHaveLength(2);
  });
});
