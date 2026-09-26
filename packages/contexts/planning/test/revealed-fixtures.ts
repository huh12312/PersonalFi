// SPDX-License-Identifier: MIT
/**
 * In-memory `CashflowReader` / `SpendingReader` fakes for WP 4.3's tests, and
 * the seed adapter the evidence walk uses.
 *
 * The fakes implement the port contracts literally — `inflows` returns every
 * positive row on the asked-for accounts in `[from, to]` inclusive,
 * `historyStarts` the earliest row per account — and nothing else, so a test
 * that goes red is red because of `src/revealed.ts`, not because a fake guessed.
 */
import {
  DateOnly,
  Money,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import type { SeedDataset } from '@core/seed';
import {
  defaultFlagsFor,
  defaultTaxBucketFor,
  type AccountKind,
  type CashflowAccount,
  type CashflowInflow,
  type CashflowReader,
  type RevealedPorts,
  type SpendingBudget,
  type SpendingClass,
  type SpendingLine,
  type SpendingPeriod,
  type SpendingReader,
} from '../src/ports.ts';

export const USER = 'a1930000-0000-7000-8000-00000000a043';

export function usd(text: string): MoneyType {
  return Money.parseAmount(text, 'USD');
}

export function day(text: string): DateOnlyType {
  return DateOnly.parse(text);
}

export function account(
  accountId: string,
  name: string,
  kind: AccountKind,
  subtype: string | null = null,
): CashflowAccount {
  return {
    accountId,
    name,
    kind,
    side: kind === 'credit' || kind === 'loan' ? 'liability' : 'asset',
    currency: 'USD',
    flags: defaultFlagsFor(kind),
    closedAt: null,
    taxBucket: defaultTaxBucketFor(kind, subtype),
  };
}

export interface InflowSpec {
  readonly id: string;
  readonly accountId: string;
  readonly date: string;
  readonly amount: string;
  readonly currency?: string;
  /** The account the paired outflow left from, when Phase 1's pairing matched one. */
  readonly counterpart?: string | null;
  readonly label?: string;
  readonly userExcluded?: boolean;
  readonly isRefund?: boolean;
}

export function inflow(spec: InflowSpec): CashflowInflow {
  return {
    transactionId: spec.id,
    accountId: spec.accountId,
    date: day(spec.date),
    amount: Money.parseAmount(spec.amount, spec.currency ?? 'USD'),
    label: spec.label ?? spec.id,
    userExcluded: spec.userExcluded ?? false,
    isRefund: spec.isRefund ?? false,
    transferCounterpartAccountId: spec.counterpart ?? null,
  };
}

/** `count` monthly inflows on `dayOfMonth`, starting at `firstMonth` (`YYYY-MM`). */
export function monthly(
  prefix: string,
  accountId: string,
  firstMonth: string,
  count: number,
  dayOfMonth: number,
  amount: string,
  counterpart: string | null,
): CashflowInflow[] {
  const start = day(`${firstMonth}-01`);
  return Array.from({ length: count }, (_, index) => {
    const month = DateOnly.addMonths(start, index);
    return inflow({
      id: `${prefix}-${month.slice(0, 7)}`,
      accountId,
      date: DateOnly.of(DateOnly.year(month), DateOnly.month(month), dayOfMonth),
      amount,
      counterpart,
      label: `${prefix} ${month.slice(0, 7)}`,
    });
  });
}

export function fakeCashflow(
  accounts: readonly CashflowAccount[],
  inflows: readonly CashflowInflow[],
  historyStarts?: ReadonlyMap<string, DateOnlyType>,
): CashflowReader {
  const starts = new Map<string, DateOnlyType>(historyStarts ?? []);
  if (historyStarts === undefined) {
    for (const row of inflows) {
      const known = starts.get(row.accountId);
      if (known === undefined || DateOnly.compare(row.date, known) < 0)
        starts.set(row.accountId, row.date);
    }
  }
  return {
    accounts: async () => accounts,
    historyStarts: async (_userId, accountIds) =>
      new Map([...starts].filter(([id]) => accountIds.includes(id))),
    inflows: async (_userId, accountIds, from, to) =>
      inflows.filter(
        (row) =>
          accountIds.includes(row.accountId) &&
          row.amount.minor > 0n &&
          DateOnly.compare(row.date, from) >= 0 &&
          DateOnly.compare(row.date, to) <= 0,
      ),
  };
}

export interface LineSpec {
  readonly categoryId: string;
  readonly name: string;
  readonly class: SpendingClass | null;
  /** Spend, positive; stored as negative activity (house sign convention). */
  readonly spend: string;
}

export function monthlyPeriods(
  firstMonth: string,
  count: number,
  linesFor: (monthStart: DateOnlyType, index: number) => readonly LineSpec[],
): SpendingPeriod[] {
  const start = day(`${firstMonth}-01`);
  return Array.from({ length: count }, (_, index) => {
    const startDate = DateOnly.addMonths(start, index);
    return {
      id: `period-${startDate.slice(0, 7)}`,
      startDate,
      endDate: DateOnly.addMonths(startDate, 1),
      lines: linesFor(startDate, index).map((spec): SpendingLine => ({
        id: `line-${spec.categoryId}-${startDate.slice(0, 7)}`,
        kind: 'category',
        categoryId: spec.categoryId,
        name: spec.name,
        activity: Money.negate(usd(spec.spend)),
        class: spec.class,
      })),
    };
  });
}

export function fakeSpending(
  budgets: readonly SpendingBudget[],
  periods: readonly SpendingPeriod[],
): SpendingReader {
  return {
    listBudgets: async () => budgets,
    listPeriods: async () =>
      periods.map(({ id, startDate, endDate }) => ({ id, startDate, endDate })),
    getPeriod: async ({ periodId }) => periods.find((period) => period.id === periodId) ?? null,
  };
}

export function ports(
  accounts: readonly CashflowAccount[],
  inflows: readonly CashflowInflow[],
  periods: readonly SpendingPeriod[] = [],
  historyStarts?: ReadonlyMap<string, DateOnlyType>,
): RevealedPorts {
  return {
    cashflow: fakeCashflow(accounts, inflows, historyStarts),
    spending: fakeSpending(
      periods.length === 0 ? [] : [{ id: 'budget-1', currency: 'USD' }],
      periods,
    ),
  };
}

// ---------------------------------------------------------------------------
// The Phase 0/1 demo seed, as the two ports would see it
// ---------------------------------------------------------------------------

/**
 * The class each seed merchant category would carry as a budget line. The
 * seed has no budget (`generateDemoData` predates `@ctx/budgeting`), so this
 * mapping is the fixture's, stated here once and quoted in the evidence:
 * the things a household must pay for are NEED; the rest are WANT.
 */
export const SEED_CATEGORY_CLASS: Readonly<Record<string, SpendingClass>> = Object.freeze({
  groceries: 'NEED',
  housing: 'NEED',
  utilities: 'NEED',
  insurance: 'NEED',
  health: 'NEED',
  transport: 'NEED',
  dining: 'WANT',
  shopping: 'WANT',
  entertainment: 'WANT',
  travel: 'WANT',
  subscriptions: 'WANT',
});

const SEED_KIND: Readonly<Record<string, { kind: AccountKind; subtype: string | null }>> = {
  checking: { kind: 'cash', subtype: 'checking' },
  savings: { kind: 'cash', subtype: 'savings' },
  credit_card: { kind: 'credit', subtype: 'credit card' },
  brokerage: { kind: 'investment', subtype: 'brokerage' },
  crypto_exchange: { kind: 'investment', subtype: 'crypto exchange' },
  mortgage: { kind: 'loan', subtype: 'mortgage' },
};

/**
 * What the composition root's bindings would return for this seed, built from
 * the seed's own ground truth: `labels.transfers` stands in for Phase 1's
 * pairing (it is what that pairing is graded against), `labels.refunds` for
 * the refund hint. Pending rows are dropped, as the binding drops them.
 */
export function seedPorts(dataset: SeedDataset): {
  readonly ports: RevealedPorts;
  readonly accounts: readonly CashflowAccount[];
  readonly inflows: readonly CashflowInflow[];
  readonly periods: readonly SpendingPeriod[];
} {
  const accounts = dataset.accounts.map((seedAccount) => {
    const shape = SEED_KIND[seedAccount.type] ?? { kind: 'other' as const, subtype: null };
    return account(seedAccount.id, seedAccount.name, shape.kind, shape.subtype);
  });
  const counterpartOf = new Map(
    dataset.labels.transfers.flatMap((pair) => [
      [pair.toTransactionId, pair.fromAccountId] as const,
      [pair.fromTransactionId, pair.toAccountId] as const,
    ]),
  );
  const refunds = new Set(dataset.labels.refunds.map((link) => link.refundTransactionId));
  const posted = dataset.transactions.filter((t) => t.status === 'posted');
  const starts = new Map<string, DateOnlyType>();
  for (const t of posted) {
    const known = starts.get(t.accountId);
    if (known === undefined || DateOnly.compare(t.postedOn, known) < 0)
      starts.set(t.accountId, t.postedOn);
  }
  const inflows = posted
    .filter((t) => BigInt(t.amount.minor) > 0n)
    .map((t) =>
      inflow({
        id: t.id,
        accountId: t.accountId,
        date: t.postedOn,
        amount: Money.formatAmount(Money.fromJSON(t.amount)),
        counterpart: counterpartOf.get(t.id) ?? null,
        label: t.descriptorRaw,
        isRefund: refunds.has(t.id),
      }),
    );

  const categoryOf = new Map(dataset.merchants.map((m) => [m.id, m.category] as const));
  const first = dataset.startMonth;
  const periods: SpendingPeriod[] = Array.from({ length: dataset.monthCount }, (_, index) => {
    const startDate = DateOnly.addMonths(first, index);
    const endDate = DateOnly.addMonths(startDate, 1);
    const totals = new Map<string, bigint>();
    for (const t of posted) {
      if (t.kind !== 'purchase' && t.kind !== 'payment' && t.kind !== 'refund') continue;
      if (DateOnly.compare(t.postedOn, startDate) < 0 || DateOnly.compare(t.postedOn, endDate) >= 0)
        continue;
      const category = t.merchantId === null ? undefined : categoryOf.get(t.merchantId);
      if (category === undefined || SEED_CATEGORY_CLASS[category] === undefined) continue;
      totals.set(category, (totals.get(category) ?? 0n) + BigInt(t.amount.minor));
    }
    const lines: SpendingLine[] = [...totals]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, minor]) => ({
        id: `line-${category}-${startDate.slice(0, 7)}`,
        kind: 'category',
        categoryId: `category-${category}`,
        name: category,
        activity: Money.of(minor, 'USD'),
        class: SEED_CATEGORY_CLASS[category] ?? null,
      }));
    return { id: `period-${startDate.slice(0, 7)}`, startDate, endDate, lines };
  });

  return {
    ports: {
      cashflow: fakeCashflow(accounts, inflows, starts),
      spending: fakeSpending([{ id: 'seed-budget', currency: 'USD' }], periods),
    },
    accounts,
    inflows,
    periods,
  };
}
