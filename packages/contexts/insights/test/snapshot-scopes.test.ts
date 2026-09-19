// SPDX-License-Identifier: MIT
/**
 * `SnapshotBuilder` — the single implementation point for data minimisation.
 *
 * The two exit tests the plan names are the first two below. Both are claims
 * about *absence*, which is the hard kind to test, so each one asserts two
 * things: that the key is gone, and that the builder would have produced it had
 * the scope been granted. Without the second half, a builder that emitted
 * nothing at all would pass.
 *
 * **Sabotage record.** `'an ungranted scope yields no key in the snapshot'` was
 * run once with the builder's loop changed to iterate `SCOPE_CATALOGUE` instead
 * of the effective grant; `'transactions.raw is never emitted for an external
 * advisor'` was run once with `externalAllowed` ignored in
 * `scopesPermittedForKind`. Both red on the first try; both restored. Recorded
 * in docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { SCOPE_CATALOGUE, scopesPermittedForKind } from '../src/contract/scopes.ts';
import { AdvisorSnapshotSchema } from '../src/contract/snapshot.ts';
import { SnapshotBuilder, bucketOf, roundToMultiple } from '../src/snapshot/builder.ts';
import {
  inMemoryBudgetPort,
  inMemoryLedgerPort,
  inMemoryRecurringPort,
  type SnapshotPorts,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const TODAY = DateOnly.parse('2026-09-19');
const usd = (minor: bigint) => Money.of(minor, 'USD');
const TOKEN_KEY = deriveTokenKey('test-secret', '01930000-0000-7000-8000-000000000001');

/** Every Phase-2-sourced block has real data behind it, so absence is a choice. */
function fullPorts(): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: 'acct-1',
          type: 'checking',
          isCash: true,
          balance: usd(212_350n),
          apy: 0,
          closed: false,
        },
        {
          id: 'acct-2',
          type: 'savings',
          isCash: true,
          balance: usd(200_000n),
          apy: 0.0425,
          closed: false,
        },
        {
          id: 'acct-3',
          type: 'other',
          isCash: false,
          balance: usd(-150_000n),
          apy: null,
          closed: false,
        },
      ],
      netWorthTrend: [
        { month: '2026-08', netWorth: usd(250_000n) },
        { month: '2026-09', netWorth: usd(262_350n) },
      ],
      cashflow: [
        {
          month: '2026-09',
          income: usd(500_000n),
          expense: usd(310_000n),
          byCategory: [{ categoryId: 'cat-1', slug: 'food.dining', amount: usd(42_000n) }],
        },
      ],
      categorySpend: [{ categoryId: 'cat-1', slug: 'food.dining', count: 14, total: usd(42_000n) }],
      merchants: [{ merchantId: 'merch-1', count: 12, total: usd(22_788n) }],
      transactions: [
        {
          id: 'txn-1',
          date: DateOnly.parse('2026-09-01'),
          merchantId: 'merch-1',
          categorySlug: 'entertainment.streaming',
          amount: usd(-1899n),
        },
      ],
    }),
    budget: inMemoryBudgetPort({
      startDate: DateOnly.parse('2026-09-01'),
      endDate: DateOnly.parse('2026-10-01'),
      kind: 'CALENDAR_MONTH',
      currency: 'USD',
      readyToAssign: usd(15_000n),
      lines: [
        {
          id: 'line-1',
          categoryId: 'cat-1',
          categorySlug: 'food.dining',
          kind: 'CATEGORY',
          assigned: usd(40_000n),
          activity: usd(-42_000n),
          available: usd(-2000n),
          cashOverspend: usd(2000n),
          creditOverspend: usd(0n),
          neededThisPeriod: usd(40_000n),
          underfunded: usd(2000n),
        },
      ],
    }),
    recurring: inMemoryRecurringPort([
      {
        id: 'series-1',
        merchantId: 'merch-1',
        cadence: 'MONTHLY',
        type: 'SUBSCRIPTION',
        status: 'ACTIVE',
        userConfirmed: true,
        confidence: 0.94,
        typicalAmount: usd(1899n),
        observedMin: usd(1899n),
        observedMax: usd(1899n),
        nextDueDate: DateOnly.parse('2026-10-01'),
        firstSeen: DateOnly.parse('2025-10-01'),
        lastSeen: DateOnly.parse('2026-09-01'),
        periodsPerYear: 12,
        eligibleForImpact: true,
        priceChanges: [],
      },
    ]),
  };
}

async function build(
  kind: 'builtin' | 'local_model' | 'external',
  grantedScopes: readonly string[],
) {
  return new SnapshotBuilder(fullPorts()).build({
    userId: '01930000-0000-7000-8000-000000000001',
    kind,
    grantedScopes: grantedScopes as never,
    today: TODAY,
    baseCurrency: 'USD',
    tokenKey: TOKEN_KEY,
  });
}

describe('snapshot scopes', () => {
  it('an ungranted scope yields no key in the snapshot', async () => {
    const withBudget = await build('builtin', ['budgets.status', 'cash.summary']);
    // The positive half: the builder *can* produce this block from these ports.
    expect(Object.keys(withBudget.snapshot)).toContain('budgets_status');

    const withoutBudget = await build('builtin', ['cash.summary']);
    expect(Object.keys(withoutBudget.snapshot)).not.toContain('budgets_status');
    expect(Object.keys(withoutBudget.snapshot)).toEqual(['cash_summary']);
    // Not `null`, not `{}` — no key at all. An advisor cannot tell a `null`
    // block from an empty one and would reason about zero.
    expect('budgets_status' in withoutBudget.snapshot).toBe(false);
  });

  it('transactions.raw is never emitted for an external advisor', async () => {
    const builtin = await build('builtin', ['transactions.raw']);
    expect(Object.keys(builtin.snapshot)).toContain('transactions_raw');

    // Granted, explicitly, and still absent. The per-kind ceiling is applied to
    // the grant itself, so the request the advisor receives does not even claim
    // the scope.
    const external = await build('external', ['transactions.raw', 'cash.summary']);
    expect(Object.keys(external.snapshot)).not.toContain('transactions_raw');
    expect(external.grantedScopes).not.toContain('transactions.raw');
    expect(scopesPermittedForKind('external')).not.toContain('transactions.raw');
    expect(scopesPermittedForKind('external')).not.toContain('institutions.names');
  });

  it('a granted scope with no source behind it yields no key either', async () => {
    // `holdings.aggregate` is Phase 3's. A granted-but-unsourced scope must be
    // indistinguishable from an ungranted one, because an empty block is a
    // block an advisor will reason about.
    const built = await build('builtin', ['holdings.aggregate', 'goals.list', 'cash.summary']);
    expect(Object.keys(built.snapshot)).toEqual(['cash_summary']);
    expect(built.emittedScopes).toEqual(['cash.summary']);
    // The *grant* still names them: the user did grant them, and the request
    // should not pretend otherwise.
    expect(built.grantedScopes).toContain('holdings.aggregate');
  });

  it('a merchant is always tokenised, for every advisor kind', async () => {
    for (const kind of ['builtin', 'local_model', 'external'] as const) {
      const built = await build(kind, ['recurring.list']);
      const streams = (built.snapshot.recurring_list?.streams ?? []) as readonly {
        merchant_ref: string;
      }[];
      expect(streams[0]?.merchant_ref, kind).toMatch(/^MERCHANT_[0-9a-f]{12}$/);
      expect(streams[0]?.merchant_ref, kind).not.toContain('merch-1');
    }
  });

  it('an external advisor gets tokens where an in-process one gets uuids', async () => {
    const builtin = await build('builtin', ['cash.summary']);
    const external = await build('external', ['cash.summary']);
    expect(builtin.snapshot.cash_summary?.accounts[0]?.account_ref).toBe('acct-1');
    expect(external.snapshot.cash_summary?.accounts[0]?.account_ref).toMatch(/^ACCT_[0-9a-f]{12}$/);
  });

  it('networth.summary rounds to $100 and transactions.raw buckets the amount', async () => {
    const built = await build('builtin', ['networth.summary', 'transactions.raw']);
    // 212350 + 200000 = 412350 assets, 150000 liabilities ⇒ 262350 net worth.
    // Rounded to a multiple of 10_000 minor units, half-even: 260000.
    expect(built.snapshot.networth_summary?.net_worth.minor).toBe('260000');
    expect(built.snapshot.transactions_raw?.rows[0]?.amount_bucket).toBe('10-50');
    // The exact figure is not in the block at all.
    expect(JSON.stringify(built.snapshot.transactions_raw)).not.toContain('1899');
  });

  it('the emitted snapshot validates against the published schema', async () => {
    const built = await build(
      'builtin',
      SCOPE_CATALOGUE.map((definition) => definition.scope),
    );
    const parsed = AdvisorSnapshotSchema.safeParse(built.snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('two builds of the same data produce the same digest', async () => {
    // `input_digest` is how "show me exactly what we sent" stays answerable
    // without keeping the payload, so the builder has to be deterministic —
    // including its property order, which `canonicalJson` normalises.
    const first = await build('builtin', ['cash.summary', 'recurring.list']);
    const second = await build('builtin', ['recurring.list', 'cash.summary']);
    expect(first.inputDigest).toBe(second.inputDigest);
    expect(first.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a different user gets different merchant tokens for the same merchant', async () => {
    const mine = await build('builtin', ['recurring.list']);
    const theirs = await new SnapshotBuilder(fullPorts()).build({
      userId: '01930000-0000-7000-8000-000000000002',
      kind: 'builtin',
      grantedScopes: ['recurring.list'],
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: deriveTokenKey('test-secret', '01930000-0000-7000-8000-000000000002'),
    });
    expect(mine.snapshot.recurring_list?.streams[0]?.merchant_ref).not.toBe(
      theirs.snapshot.recurring_list?.streams[0]?.merchant_ref,
    );
  });

  it('emergency_fund_months is null unless cashflow.monthly was also granted', async () => {
    // A figure derived from another scope's data obeys that scope's grant. A
    // user who granted only `cash.summary` would otherwise be telling the
    // advisor their monthly burn, one division later.
    const cashOnly = await build('builtin', ['cash.summary']);
    expect(cashOnly.snapshot.cash_summary?.emergency_fund_months).toBeNull();

    const both = await build('builtin', ['cash.summary', 'cashflow.monthly']);
    expect(both.snapshot.cash_summary?.emergency_fund_months).not.toBeNull();
  });
});

describe('the minimisation levers', () => {
  it('rounds half-even, so a trend does not slope because of its rounding', () => {
    expect(roundToMultiple(15_000n, 10_000n)).toBe(20_000n);
    expect(roundToMultiple(25_000n, 10_000n)).toBe(20_000n);
    expect(roundToMultiple(-15_000n, 10_000n)).toBe(-20_000n);
    expect(roundToMultiple(1234n, 1n)).toBe(1234n);
  });

  it('buckets on magnitude, exhaustively, with no upper bound on the last rung', () => {
    expect(bucketOf(usd(999n))).toBe('0-10');
    expect(bucketOf(usd(-4500n))).toBe('10-50');
    expect(bucketOf(usd(5000n))).toBe('50-200');
    expect(bucketOf(usd(99_999_999n))).toBe('5000+');
  });

  it('every catalogue row that mentions merchants tokenises them', () => {
    for (const definition of SCOPE_CATALOGUE) {
      if (!/merchant/i.test(definition.yields + definition.drops)) continue;
      expect(definition.minimisation.tokeniseMerchants, definition.scope).toBe(true);
    }
  });
});
