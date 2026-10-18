// SPDX-License-Identifier: MIT
/** Test-only fixtures for the dashboard widgets (WP 10.9): every field the wire shape requires. */
import type {
  Account,
  BudgetLine,
  BudgetPeriod,
  Goal,
  GetRecurringUpcomingResponse,
  RecurringProjectedCharge,
} from '../../../api/generated/types.gen.ts';

export function usd(minor: string | number) {
  return { minor: String(minor), currency: 'USD' };
}

export function budgetLine(overrides: Partial<BudgetLine> & Pick<BudgetLine, 'id'>): BudgetLine {
  return {
    kind: 'category',
    categoryId: `cat_${overrides.id}`,
    creditAccountId: null,
    name: null,
    carryover: usd(0),
    assigned: usd(0),
    activity: usd(0),
    available: usd(0),
    cashOverspend: usd(0),
    creditOverspend: usd(0),
    rolloverPolicy: 'RESET',
    goalType: 'NONE',
    neededThisPeriod: usd(0),
    underfunded: usd(0),
    priority: 0,
    class: null,
    transferExcludedCount: 0,
    refundNettedCount: 0,
    ...overrides,
  };
}

/** An envelope with `assigned` funding and `spent` out, `available` as the server would compute it. */
export function envelope(id: string, name: string, assigned: number, spent: number): BudgetLine {
  return budgetLine({
    id,
    name,
    assigned: usd(assigned),
    activity: usd(-spent),
    available: usd(assigned - spent),
    cashOverspend: usd(Math.max(spent - assigned, 0) * -1),
  });
}

export function budgetPeriod(lines: BudgetLine[], readyToAssign = 25_000): BudgetPeriod {
  return {
    id: 'period_1',
    budgetId: 'budget_1',
    kind: 'monthly',
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    sequence: 1,
    status: 'open',
    readyToAssign: usd(readyToAssign),
    income: usd(500_000),
    dirty: false,
    toStayOnTrack: usd(0),
    totalCategoryAvailable: usd(0),
    totalCreditCardPaymentAvailable: usd(0),
    budgetedExpenses: usd(0),
    plannedSavings: usd(0),
    rolledOver: usd(0),
    lines,
  };
}

export function goal(overrides: Partial<Goal> & Pick<Goal, 'id' | 'name'>): Goal {
  return {
    kind: 'emergency_fund',
    target: usd(1_000_000),
    targetDate: '2027-06-30',
    priority: 1,
    fundedFromAccountIds: [],
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function account(
  id: string,
  balanceMinor: number | null,
  extra: Partial<Account> = {},
): Account {
  return {
    id,
    connectionId: 'conn_1',
    provider: 'manual',
    name: `Account ${id}`,
    officialName: null,
    type: 'depository',
    subtype: null,
    classification: 'asset',
    currency: 'USD',
    mask: null,
    closedAt: null,
    includeInNetWorth: true,
    balance:
      balanceMinor === null
        ? null
        : {
            current: usd(balanceMinor),
            available: null,
            limit: null,
            asOf: '2026-03-17T00:00:00.000Z',
            source: 'provider',
          },
    ...extra,
  } as Account;
}

export function charge(
  date: string,
  expectedMinor: number,
  overrides: Partial<RecurringProjectedCharge> = {},
): RecurringProjectedCharge {
  const amount = usd(expectedMinor);
  return {
    seriesId: `series_${date}_${String(expectedMinor)}`,
    streamKey: 'stream',
    merchantId: `merchant_${String(Math.abs(expectedMinor))}`,
    type: 'subscription',
    cadence: 'monthly',
    sign: expectedMinor < 0 ? 'OUTFLOW' : 'INFLOW',
    status: 'confirmed',
    userConfirmed: true,
    confidence: 0.95,
    slot: 0,
    date,
    earliest: date,
    latest: date,
    uncertaintyDays: 0,
    expected: amount,
    low: amount,
    high: amount,
    ...overrides,
  };
}

/** A calendar from `from`, one entry per day, with the charges given on their dates. */
export function calendar(
  from: string,
  days: number,
  charges: RecurringProjectedCharge[],
): GetRecurringUpcomingResponse {
  const start = Date.parse(`${from}T00:00:00Z`);
  const entries = Array.from({ length: days }, (_unused, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const today = charges.filter((entry) => entry.date === date);
    const out = today.filter((entry) => entry.sign === 'OUTFLOW');
    const inn = today.filter((entry) => entry.sign === 'INFLOW');
    const sum = (list: RecurringProjectedCharge[]) =>
      usd(list.reduce((total, entry) => total + Number(entry.expected.minor), 0));
    return { date, outflow: sum(out), inflow: sum(inn), charges: today };
  });
  return {
    from,
    to: entries.at(-1)?.date ?? from,
    currency: 'USD',
    chargeCount: charges.length,
    days: entries,
  };
}
