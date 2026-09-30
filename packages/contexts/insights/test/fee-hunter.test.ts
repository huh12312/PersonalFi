// SPDX-License-Identifier: MIT
/**
 * WP 5.7 — `builtin.spending.fee_hunter`, `fees.summary`.
 *
 * A dedicated fixture, for the same reason `test/anomaly.test.ts` has one:
 * the exact totals and the avoidable/interest split are chosen and
 * hand-verified here.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { spendingFeeHunter } from '../src/advisors/builtin/anomaly/fees.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { AdvisorRequest } from '../src/contract/request.ts';
import type { AdvisorManifest } from '../src/contract/manifest.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { SnapshotBuilder } from '../src/snapshot/builder.ts';
import {
  emptyPorts,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  type FakeLedgerData,
  type InsightsHoldings,
  type InsightsPosition,
  type InsightsTransaction,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const USER_ID = '01930000-0000-7000-8000-0000000000c1';
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

// Two ATM fees on one account ($3.50 + $4.00), one foreign-transaction fee on
// a second account ($6.25), and a year of interest charges ($120.00) — which
// must never be counted as avoidable.
const FEE_ROWS: readonly InsightsTransaction[] = [
  txn({
    id: 'txn-atm-1',
    date: '2026-03-01',
    merchantId: 'm-atm',
    categorySlug: 'fees_and_services.atm_fees',
    amountMinor: -350n,
    accountId: 'acct-checking',
  }),
  txn({
    id: 'txn-atm-2',
    date: '2026-06-01',
    merchantId: 'm-atm',
    categorySlug: 'fees_and_services.atm_fees',
    amountMinor: -400n,
    accountId: 'acct-checking',
  }),
  txn({
    id: 'txn-foreign-1',
    date: '2026-07-01',
    merchantId: 'm-shop',
    categorySlug: 'fees_and_services.foreign_fees',
    amountMinor: -625n,
    accountId: 'acct-card',
  }),
  txn({
    id: 'txn-interest-1',
    date: '2026-04-01',
    merchantId: null,
    categorySlug: 'fees_and_services.interest_charges',
    amountMinor: -12_000n,
    accountId: 'acct-card',
  }),
];

function positionOf(annualFeeCostMinor: bigint | null): InsightsPosition {
  return {
    securityId: 'sec-1',
    symbol: 'FUND',
    assetClass: 'equity',
    accountType: 'taxable',
    quantity: '10',
    costBasis: usd(100_000n),
    marketValue: usd(120_000n),
    unrealized: usd(20_000n),
    oldestLotDays: 400,
    isCrypto: false,
    isStablecoin: false,
    employerStock: false,
    expenseRatio: 0.0075,
    peerExpenseRatio: 0.0003,
    annualFeeCost: annualFeeCostMinor === null ? null : usd(annualFeeCostMinor),
    highFee: true,
    lots: [],
  };
}

function holdingsOf(annualFeeCostMinor: bigint): InsightsHoldings {
  return {
    currency: USD,
    aggregate: {
      investableTotal: usd(120_000n),
      unclassifiedPct: 0,
      byAssetClass: [],
      positions: [],
      targets: [],
      accountTypeMix: {},
      idleCash: null,
      cryptoCustody: null,
    },
    positions: [positionOf(annualFeeCostMinor), positionOf(null)],
  };
}

function ledgerOf(rows: readonly InsightsTransaction[]): FakeLedgerData {
  return { transactions: rows };
}

async function buildFees(
  rows: readonly InsightsTransaction[],
  scopes: readonly ('fees.summary' | 'holdings.detail')[],
  holdings: InsightsHoldings | null = null,
): Promise<AdvisorSnapshot['fees_summary']> {
  const builder = new SnapshotBuilder({
    ...emptyPorts(),
    ledger: inMemoryLedgerPort(ledgerOf(rows)),
    investments: inMemoryInvestmentsPort({ holdings }),
  });
  const built = await builder.build({
    userId: USER_ID,
    kind: 'builtin',
    grantedScopes: [...scopes],
    today: DateOnly.parse(TODAY),
    baseCurrency: USD,
    tokenKey: deriveTokenKey('wp-5-7-fee-hunter-test', USER_ID),
  });
  return built.snapshot.fees_summary;
}

function requestFor(manifest: AdvisorManifest, snapshot: AdvisorSnapshot): AdvisorRequest {
  return {
    contract_version: 1,
    request_id: '01930000-0000-7000-8000-0000000000d1',
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: `${TODAY}T08:00:00.000Z`,
    base_currency: USD,
    time_zone: 'America/New_York',
    today: TODAY,
    granted_scopes: [...manifest.requires_scopes],
    input_digest: `sha256:${'c'.repeat(64)}`,
    limits: {
      max_insights: manifest.limits.max_insights,
      max_response_bytes: manifest.limits.max_response_bytes,
      deadline: `${TODAY}T08:05:00.000Z`,
    },
    snapshot,
  };
}

describe('fees.summary — totals by type and by account', () => {
  it('fees are totalled by type and by account over twelve months, the worst offender named, and interest excluded from avoidable', async () => {
    const block = await buildFees(FEE_ROWS, ['fees.summary']);
    expect(block).not.toBeNull();
    expect(block?.window_months).toBe(12);

    const byType = new Map(block?.by_type.map((row) => [row.type, row]));
    expect(byType.get('fees_and_services.atm_fees')?.total.minor).toBe('750');
    expect(byType.get('fees_and_services.atm_fees')?.count).toBe(2);
    expect(byType.get('fees_and_services.atm_fees')?.avoidable).toBe(true);
    expect(byType.get('fees_and_services.foreign_fees')?.total.minor).toBe('625');
    expect(byType.get('fees_and_services.foreign_fees')?.avoidable).toBe(true);
    expect(byType.get('fees_and_services.interest_charges')?.total.minor).toBe('12000');
    expect(byType.get('fees_and_services.interest_charges')?.avoidable).toBe(false);

    const byAccount = new Map(
      (block?.by_account ?? []).map((row) => [row.account_ref, row] as const),
    );
    expect(byAccount.get('acct-checking')?.total.minor).toBe('750');
    expect(byAccount.get('acct-checking')?.count).toBe(2);
    expect(byAccount.get('acct-card')?.total.minor).toBe('12625');

    // The rule sums the avoidable subset, names the worst offender, and
    // states the cost -- interest never enters the sum or the naming.
    const context = contextOf(requestFor(spendingFeeHunter.manifest, { fees_summary: block }));
    const insights = spendingFeeHunter.evaluate(context).insights;
    expect(insights).toHaveLength(1);
    const insight = insights[0];
    expect(insight?.impact.annualized?.minor).toBe('1375'); // 750 + 625, never the 12000 interest
    expect(insight?.summary_md).toContain('$13.75');
    expect(insight?.summary_md).toContain('ATM fees');
    expect(insight?.summary_md).not.toContain('120.00');
  });

  it('expense-ratio drag comes from holdings.detail and is never recomputed', async () => {
    const withoutDetail = await buildFees(FEE_ROWS, ['fees.summary']);
    expect(withoutDetail?.expense_ratio_drag).toBeNull();

    const holdings = holdingsOf(9_000n); // $90.00 -- one position's own annual_fee_cost
    const withDetail = await buildFees(FEE_ROWS, ['fees.summary', 'holdings.detail'], holdings);
    expect(withDetail?.expense_ratio_drag?.minor).toBe('9000');

    // The figure is `holdings.detail`'s own `annual_fee_cost`, summed --
    // never a second `market_value x expense_ratio` computed here.
    expect(withDetail?.expense_ratio_drag?.minor).toBe(
      holdings.positions
        .reduce((sum, position) => sum + (position.annualFeeCost?.minor ?? 0n), 0n)
        .toString(),
    );
  });
});
