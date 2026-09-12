// SPDX-License-Identifier: MIT
import { DateOnly, Money } from '@core/kernel';
import { MERCHANT_CATALOG, renderDescriptor } from './merchants.ts';
import { chance, randomDecimal, randomInt, randomUuid, type Rng } from './prng.ts';
import type {
  AccountType,
  RecurringCadence,
  SeedAccount,
  SeedMerchant,
  SeedRecurringSeries,
  SeedRefundLink,
  SeedTransaction,
  SeedTransferPair,
  TransactionKind,
} from './types.ts';

type DateOnlyType = DateOnly;

export interface GenerateTransactionsResult {
  readonly transactions: SeedTransaction[];
  readonly recurringSeries: SeedRecurringSeries[];
  readonly transfers: SeedTransferPair[];
  readonly refunds: SeedRefundLink[];
}

/**
 * Merchants dedicated to a recurring series, keyed by canonical name — excluded
 * from the one-off discretionary-purchase pool so a subscription never
 * accidentally shows up twice, once as itself and once as "random spending".
 */
const RECURRING_MERCHANTS = [
  'Netflix',
  'Spotify',
  'iCloud',
  'Adobe Creative Cloud',
  'PG&E',
  'Comcast Xfinity',
  'AT&T Wireless',
  'Chase Mortgage',
  'Planet Fitness',
  'State Farm Insurance',
  'Acme Corp Payroll',
] as const;

const PAYROLL_MERCHANT_NAME = 'Acme Corp Payroll';

function findAccount(accounts: readonly SeedAccount[], type: AccountType): SeedAccount {
  const found = accounts.find((account) => account.type === type);
  if (found === undefined) throw new Error(`no seeded account of type ${type}`);
  return found;
}

function daysInWindow(start: DateOnlyType, end: DateOnlyType): DateOnlyType[] {
  const days: DateOnlyType[] = [];
  let cursor = start;
  while (DateOnly.compare(cursor, end) <= 0) {
    days.push(cursor);
    cursor = DateOnly.addDays(cursor, 1);
  }
  return days;
}

function money(amount: string, currency: string): SeedTransaction['amount'] {
  return Money.toJSON(Money.parseAmount(amount, currency));
}

/** `pendingOn`/`status` for a transaction posted on `postedOn`, given "today". */
function lifecycle(
  rng: Rng,
  postedOn: DateOnlyType,
  today: DateOnlyType,
  hasPendingStage: boolean,
): Pick<SeedTransaction, 'pendingOn' | 'status' | 'postedOn'> {
  const daysUntilToday = DateOnly.differenceInDays(postedOn, today);
  if (daysUntilToday <= 1) {
    // Within the trailing day of the window: still sitting pending, not yet posted.
    return { pendingOn: postedOn, postedOn, status: 'pending' };
  }
  if (!hasPendingStage) return { pendingOn: null, postedOn, status: 'posted' };
  const lag = randomInt(rng, 0, 2);
  return { pendingOn: DateOnly.addDays(postedOn, -lag), postedOn, status: 'posted' };
}

function makeTransaction(
  rng: Rng,
  today: DateOnlyType,
  input: {
    accountId: string;
    merchantId: string | null;
    kind: TransactionKind;
    amount: string;
    currency: string;
    postedOn: DateOnlyType;
    descriptorRaw: string;
    hasPendingStage?: boolean;
  },
): SeedTransaction {
  return {
    id: randomUuid(rng),
    accountId: input.accountId,
    merchantId: input.merchantId,
    kind: input.kind,
    amount: money(input.amount, input.currency),
    descriptorRaw: input.descriptorRaw,
    ...lifecycle(rng, input.postedOn, today, input.hasPendingStage ?? true),
  };
}

/** One fixed-day-of-month recurring definition, before it is materialised. */
interface RecurringPlan {
  readonly merchantName: (typeof RECURRING_MERCHANTS)[number];
  readonly cadence: RecurringCadence;
  readonly accountType: AccountType;
  readonly kind: TransactionKind;
  readonly dayOfMonth: number;
  readonly amountSign: 1 | -1;
  readonly priceIncreaseAtMonth: number | null;
  readonly newAmount: string | null;
  readonly dormantAfterMonth: number | null;
}

const RECURRING_PLANS: readonly RecurringPlan[] = [
  {
    merchantName: 'Netflix',
    cadence: 'monthly',
    accountType: 'credit_card',
    kind: 'purchase',
    dayOfMonth: 3,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    merchantName: 'Spotify',
    cadence: 'monthly',
    accountType: 'credit_card',
    kind: 'purchase',
    dayOfMonth: 5,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    merchantName: 'iCloud',
    cadence: 'monthly',
    accountType: 'credit_card',
    kind: 'purchase',
    dayOfMonth: 7,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    // The canonical "price went up" series (07 §5.1 price-change detection).
    merchantName: 'Adobe Creative Cloud',
    cadence: 'monthly',
    accountType: 'credit_card',
    kind: 'purchase',
    dayOfMonth: 12,
    amountSign: -1,
    priceIncreaseAtMonth: 12,
    newAmount: '64.99',
    dormantAfterMonth: null,
  },
  {
    merchantName: 'PG&E',
    cadence: 'monthly',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 15,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    merchantName: 'Comcast Xfinity',
    cadence: 'monthly',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 18,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    merchantName: 'AT&T Wireless',
    cadence: 'monthly',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 20,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    merchantName: 'Chase Mortgage',
    cadence: 'monthly',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 1,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
  {
    // The canonical "went dormant" series (07 §5.1 dormancy detection).
    merchantName: 'Planet Fitness',
    cadence: 'monthly',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 10,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: 15,
  },
  {
    merchantName: 'State Farm Insurance',
    cadence: 'annual',
    accountType: 'checking',
    kind: 'payment',
    dayOfMonth: 1,
    amountSign: -1,
    priceIncreaseAtMonth: null,
    newAmount: null,
    dormantAfterMonth: null,
  },
] as const;

function monthOffsets(cadence: RecurringCadence, monthCount: number): number[] {
  if (cadence === 'annual') {
    const offsets: number[] = [];
    for (let m = 0; m < monthCount; m += 12) offsets.push(m);
    return offsets;
  }
  return Array.from({ length: monthCount }, (_, m) => m);
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, DateOnly.daysInMonth(year, month));
}

function materializeRecurring(
  rng: Rng,
  plan: RecurringPlan,
  merchant: SeedMerchant,
  accounts: readonly SeedAccount[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
): { series: SeedRecurringSeries; transactions: SeedTransaction[] } {
  const account = findAccount(accounts, plan.accountType);
  const currency = account.currency;
  const template = MERCHANT_CATALOG.find((m) => m.canonicalName === plan.merchantName);
  if (template === undefined) throw new Error(`no catalog entry for ${plan.merchantName}`);

  const initialAmount = (plan.amountSign * template.amountRange[0]).toFixed(2);
  const transactions: SeedTransaction[] = [];

  for (const monthOffset of monthOffsets(plan.cadence, monthCount)) {
    if (plan.dormantAfterMonth !== null && monthOffset > plan.dormantAfterMonth) continue;
    const anchor = DateOnly.addMonths(startMonth, monthOffset);
    const day = clampDay(DateOnly.year(anchor), DateOnly.month(anchor), plan.dayOfMonth);
    const postedOn = DateOnly.of(DateOnly.year(anchor), DateOnly.month(anchor), day);
    if (DateOnly.compare(postedOn, today) > 0) continue;

    const amount =
      plan.priceIncreaseAtMonth !== null &&
      plan.newAmount !== null &&
      monthOffset >= plan.priceIncreaseAtMonth
        ? (plan.amountSign * Number(plan.newAmount)).toFixed(2)
        : plan.cadence === 'annual' || template.amountRange[0] === template.amountRange[1]
          ? initialAmount
          : (
              plan.amountSign * randomInt(rng, template.amountRange[0], template.amountRange[1])
            ).toFixed(2);

    transactions.push(
      makeTransaction(rng, today, {
        accountId: account.id,
        merchantId: merchant.id,
        kind: plan.kind,
        amount,
        currency,
        postedOn,
        descriptorRaw: renderDescriptor(rng, template),
      }),
    );
  }

  const dormantAfter =
    plan.dormantAfterMonth === null
      ? null
      : DateOnly.of(
          DateOnly.year(DateOnly.addMonths(startMonth, plan.dormantAfterMonth)),
          DateOnly.month(DateOnly.addMonths(startMonth, plan.dormantAfterMonth)),
          clampDay(
            DateOnly.year(DateOnly.addMonths(startMonth, plan.dormantAfterMonth)),
            DateOnly.month(DateOnly.addMonths(startMonth, plan.dormantAfterMonth)),
            plan.dayOfMonth,
          ),
        );

  const series: SeedRecurringSeries = {
    id: randomUuid(rng),
    merchantId: merchant.id,
    accountId: account.id,
    cadence: plan.cadence,
    transactionIds: transactions.map((t) => t.id),
    initialAmount,
    currency,
    priceIncrease:
      plan.priceIncreaseAtMonth === null || plan.newAmount === null
        ? null
        : {
            effectiveOn: DateOnly.of(
              DateOnly.year(DateOnly.addMonths(startMonth, plan.priceIncreaseAtMonth)),
              DateOnly.month(DateOnly.addMonths(startMonth, plan.priceIncreaseAtMonth)),
              clampDay(
                DateOnly.year(DateOnly.addMonths(startMonth, plan.priceIncreaseAtMonth)),
                DateOnly.month(DateOnly.addMonths(startMonth, plan.priceIncreaseAtMonth)),
                plan.dayOfMonth,
              ),
            ),
            newAmount: plan.newAmount,
          },
    dormantAfter,
  };

  return { series, transactions };
}

function materializePayroll(
  rng: Rng,
  merchant: SeedMerchant,
  accounts: readonly SeedAccount[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
): { series: SeedRecurringSeries; transactions: SeedTransaction[] } {
  const template = MERCHANT_CATALOG.find((m) => m.canonicalName === PAYROLL_MERCHANT_NAME);
  if (template === undefined) throw new Error(`no catalog entry for ${PAYROLL_MERCHANT_NAME}`);
  const checking = findAccount(accounts, 'checking');
  const amount = template.amountRange[0].toFixed(2);
  const end = DateOnly.endOfMonth(DateOnly.addMonths(startMonth, monthCount - 1));
  const transactions: SeedTransaction[] = [];
  let cursor = startMonth;
  while (DateOnly.compare(cursor, end) <= 0 && DateOnly.compare(cursor, today) <= 0) {
    transactions.push(
      makeTransaction(rng, today, {
        accountId: checking.id,
        merchantId: merchant.id,
        kind: 'deposit',
        amount,
        currency: checking.currency,
        postedOn: cursor,
        descriptorRaw: renderDescriptor(rng, template),
        hasPendingStage: false,
      }),
    );
    cursor = DateOnly.addDays(cursor, 14);
  }

  const series: SeedRecurringSeries = {
    id: randomUuid(rng),
    merchantId: merchant.id,
    accountId: checking.id,
    cadence: 'biweekly',
    transactionIds: transactions.map((t) => t.id),
    initialAmount: amount,
    currency: checking.currency,
    priceIncrease: null,
    dormantAfter: null,
  };

  return { series, transactions };
}

function generateOneOffPurchases(
  rng: Rng,
  accounts: readonly SeedAccount[],
  merchants: readonly SeedMerchant[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
): { transactions: SeedTransaction[]; monthlyCardSpend: Map<number, number> } {
  const checking = findAccount(accounts, 'checking');
  const creditCard = findAccount(accounts, 'credit_card');
  const discretionary = MERCHANT_CATALOG.filter(
    (t) => !(RECURRING_MERCHANTS as readonly string[]).includes(t.canonicalName),
  );
  const merchantByName = new Map(merchants.map((m) => [m.canonicalName, m]));

  const end = DateOnly.endOfMonth(DateOnly.addMonths(startMonth, monthCount - 1));
  const transactions: SeedTransaction[] = [];
  const monthlyCardSpend = new Map<number, number>();

  for (const day of daysInWindow(startMonth, end)) {
    if (DateOnly.compare(day, today) > 0) break;
    // Roughly 1-3 discretionary purchases every other day on average.
    if (!chance(rng, 0.55)) continue;
    const purchaseCount = randomInt(rng, 1, 2);
    for (let i = 0; i < purchaseCount; i += 1) {
      const template = discretionary[randomInt(rng, 0, discretionary.length - 1)];
      if (template === undefined) continue;
      const merchant = merchantByName.get(template.canonicalName);
      if (merchant === undefined) continue;
      const onCard = chance(rng, 0.65);
      const account = onCard ? creditCard : checking;
      const amountValue = randomDecimal(rng, template.amountRange[0], template.amountRange[1]);
      const amount = `-${amountValue}`;
      const monthIndex =
        (DateOnly.year(day) - DateOnly.year(startMonth)) * 12 +
        (DateOnly.month(day) - DateOnly.month(startMonth));

      if (onCard) {
        monthlyCardSpend.set(
          monthIndex,
          (monthlyCardSpend.get(monthIndex) ?? 0) + Number(amountValue),
        );
      }

      transactions.push(
        makeTransaction(rng, today, {
          accountId: account.id,
          merchantId: merchant.id,
          kind: 'purchase',
          amount,
          currency: account.currency,
          postedOn: day,
          descriptorRaw: renderDescriptor(rng, template),
        }),
      );
    }
  }

  return { transactions, monthlyCardSpend };
}

function generateTransfers(
  rng: Rng,
  accounts: readonly SeedAccount[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
  monthlyCardSpend: ReadonlyMap<number, number>,
): { transactions: SeedTransaction[]; transfers: SeedTransferPair[] } {
  const checking = findAccount(accounts, 'checking');
  const savings = findAccount(accounts, 'savings');
  const creditCard = findAccount(accounts, 'credit_card');
  const brokerage = findAccount(accounts, 'brokerage');

  const transactions: SeedTransaction[] = [];
  const transfers: SeedTransferPair[] = [];

  function addTransferPair(
    fromAccount: SeedAccount,
    toAccount: SeedAccount,
    amountDecimal: string,
    postedOn: DateOnlyType,
  ): void {
    const fromTxn = makeTransaction(rng, today, {
      accountId: fromAccount.id,
      merchantId: null,
      kind: 'transfer',
      amount: `-${amountDecimal}`,
      currency: fromAccount.currency,
      postedOn,
      descriptorRaw: `TRANSFER TO ${toAccount.name.toUpperCase()}`,
      hasPendingStage: false,
    });
    const toTxn = makeTransaction(rng, today, {
      accountId: toAccount.id,
      merchantId: null,
      kind: 'transfer',
      amount: amountDecimal,
      currency: toAccount.currency,
      postedOn,
      descriptorRaw: `TRANSFER FROM ${fromAccount.name.toUpperCase()}`,
      hasPendingStage: false,
    });
    transactions.push(fromTxn, toTxn);
    transfers.push({
      id: randomUuid(rng),
      fromTransactionId: fromTxn.id,
      toTransactionId: toTxn.id,
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amount: money(amountDecimal, fromAccount.currency),
    });
  }

  for (let monthOffset = 0; monthOffset < monthCount; monthOffset += 1) {
    const anchor = DateOnly.addMonths(startMonth, monthOffset);
    const year = DateOnly.year(anchor);
    const month = DateOnly.month(anchor);

    // Monthly savings sweep, the 28th (or the month's last day if shorter).
    const sweepOn = DateOnly.of(year, month, clampDay(year, month, 28));
    if (DateOnly.compare(sweepOn, today) <= 0) {
      addTransferPair(checking, savings, '500.00', sweepOn);
    }

    // Credit-card statement payment: pay off last month's spend, on the 25th.
    if (monthOffset > 0) {
      const payOn = DateOnly.of(year, month, clampDay(year, month, 25));
      const owed = monthlyCardSpend.get(monthOffset - 1) ?? 0;
      if (owed > 0 && DateOnly.compare(payOn, today) <= 0) {
        addTransferPair(checking, creditCard, owed.toFixed(2), payOn);
      }
    }

    // Twice a year, fund the brokerage account from savings.
    if (monthOffset % 6 === 0 && monthOffset > 0) {
      const investOn = DateOnly.of(year, month, clampDay(year, month, 5));
      if (DateOnly.compare(investOn, today) <= 0) {
        addTransferPair(savings, brokerage, '2000.00', investOn);
      }
    }
  }

  return { transactions, transfers };
}

function generateRefunds(
  rng: Rng,
  today: DateOnlyType,
  purchases: readonly SeedTransaction[],
): { transactions: SeedTransaction[]; refunds: SeedRefundLink[] } {
  const eligible = purchases.filter((t) => t.kind === 'purchase' && t.status === 'posted');
  const refundCount = Math.min(10, Math.floor(eligible.length / 40));
  const transactions: SeedTransaction[] = [];
  const refunds: SeedRefundLink[] = [];
  if (eligible.length === 0) return { transactions, refunds };

  for (let i = 0; i < refundCount; i += 1) {
    const index = randomInt(rng, 0, eligible.length - 1);
    const purchase = eligible[index];
    if (purchase === undefined) continue;
    const original = Money.fromJSON(purchase.amount);
    const full = chance(rng, 0.6);
    const refundMinor = full ? -original.minor : (-original.minor * 3n) / 4n;
    if (refundMinor <= 0n) continue;
    const refundDate = DateOnly.addDays(purchase.postedOn, randomInt(rng, 2, 10));
    if (DateOnly.compare(refundDate, today) > 0) continue;

    const refundTxn = makeTransaction(rng, today, {
      accountId: purchase.accountId,
      merchantId: purchase.merchantId,
      kind: 'refund',
      amount: '0.00',
      currency: original.currency,
      postedOn: refundDate,
      descriptorRaw: `REFUND ${purchase.descriptorRaw}`,
      hasPendingStage: false,
    });
    // Overwrite the placeholder amount with the exact minor-unit refund (Money
    // arithmetic keeps this exact; building the decimal string from a bigint
    // avoids reintroducing float error for an odd partial-refund amount).
    const exact: SeedTransaction = {
      ...refundTxn,
      amount: Money.toJSON(Money.of(refundMinor, original.currency)),
    };

    transactions.push(exact);
    refunds.push({
      id: randomUuid(rng),
      purchaseTransactionId: purchase.id,
      refundTransactionId: exact.id,
    });
  }

  return { transactions, refunds };
}

export function generateTransactions(
  rng: Rng,
  accounts: readonly SeedAccount[],
  merchants: readonly SeedMerchant[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
): GenerateTransactionsResult {
  const merchantByName = new Map(merchants.map((m) => [m.canonicalName, m]));
  const recurringSeries: SeedRecurringSeries[] = [];
  const recurringTransactions: SeedTransaction[] = [];

  for (const plan of RECURRING_PLANS) {
    const merchant = merchantByName.get(plan.merchantName);
    if (merchant === undefined) throw new Error(`missing merchant for ${plan.merchantName}`);
    const { series, transactions } = materializeRecurring(
      rng,
      plan,
      merchant,
      accounts,
      startMonth,
      monthCount,
      today,
    );
    recurringSeries.push(series);
    recurringTransactions.push(...transactions);
  }

  const payrollMerchant = merchantByName.get(PAYROLL_MERCHANT_NAME);
  if (payrollMerchant === undefined)
    throw new Error(`missing merchant for ${PAYROLL_MERCHANT_NAME}`);
  const payroll = materializePayroll(rng, payrollMerchant, accounts, startMonth, monthCount, today);
  recurringSeries.push(payroll.series);
  recurringTransactions.push(...payroll.transactions);

  const { transactions: oneOffTransactions, monthlyCardSpend } = generateOneOffPurchases(
    rng,
    accounts,
    merchants,
    startMonth,
    monthCount,
    today,
  );

  const { transactions: transferTransactions, transfers } = generateTransfers(
    rng,
    accounts,
    startMonth,
    monthCount,
    today,
    monthlyCardSpend,
  );

  const { transactions: refundTransactions, refunds } = generateRefunds(
    rng,
    today,
    oneOffTransactions,
  );

  const transactions = [
    ...recurringTransactions,
    ...oneOffTransactions,
    ...transferTransactions,
    ...refundTransactions,
  ].sort(
    (a, b) => DateOnly.compare(a.postedOn, b.postedOn) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return { transactions, recurringSeries, transfers, refunds };
}
