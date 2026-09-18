// SPDX-License-Identifier: MIT
/**
 * The synthetic corpus — 07 §2.12 tier 2, with its injected realities.
 *
 * > 5,000 streams with injected reality: weekend/holiday shifts, one skipped
 * > period (failed payment + retry 3 days later), mid-stream price hikes,
 * > merchant descriptor changes, card migrations, proration on plan change,
 * > annual→monthly switches, refunds, duplicate charges, and **30% pure-noise
 * > merchants that must NOT be detected**.
 *
 * Every one of those is here and enumerated in `REALITY_NOTES`, which the
 * evidence file prints as a table so the corpus can be audited without reading
 * this generator. The scale is 36 months and ~90 merchants rather than 5,000
 * streams, because the gate has to run in a unit-test project on every push and
 * a corpus nobody waits for is a corpus nobody runs.
 *
 * ## The generator knows nothing about the detector
 *
 * Dates here are stepped with `DateOnly.addMonths` / `addDays` from the kernel —
 * the same calendar every bank uses — and **not** with `cadence.ts`'s `slotOf`.
 * If the two disagree about Jan 31 + 1 month, the corpus is what says so. A
 * generator that imported the scorer's own schedule builder could only ever
 * confirm that the scorer agrees with itself.
 *
 * ## The honest caveat
 *
 * A corpus written by the same hand as the detector is a *floor*, not a proof:
 * it cannot contain a failure mode its author did not think of. That is why the
 * adversarial corpus exists, why the operating point is chosen from a swept
 * curve rather than asserted, and why 07 §2.12's tier 1 — 24 months of real,
 * hand-labelled history — stays on the plan as a carried item.
 */

import { DateOnly, Money } from '@core/kernel';
import type {
  AmountModel,
  Cadence,
  MerchantClass,
  MerchantFacts,
  RecurringInput,
  StreamType,
} from '../../src/index.ts';
import { mulberry32, type Rng } from './rng.ts';

export type Reality =
  | 'WEEKEND_SHIFT'
  | 'SKIPPED_PERIOD'
  | 'FAILED_RETRY'
  | 'PRICE_HIKE'
  | 'DESCRIPTOR_CHANGE'
  | 'CARD_MIGRATION'
  | 'PRORATION'
  | 'ANNUAL_TO_MONTHLY'
  | 'REFUND'
  | 'DUPLICATE_CHARGE'
  | 'DORMANCY'
  | 'NOISE_MERCHANT'
  | 'HABIT_MERCHANT'
  | 'AMBIGUOUS_MERCHANT';

export const REALITY_NOTES: ReadonlyArray<{
  readonly reality: Reality;
  readonly injection: string;
  readonly theEngineMust: string;
}> = Object.freeze([
  {
    reality: 'WEEKEND_SHIFT',
    injection: 'a slot landing on Sat/Sun posts on the following Monday, for 4 streams in 5',
    theEngineMust: 'score it as tight, not late — tolerance widens forward only',
  },
  {
    reality: 'SKIPPED_PERIOD',
    injection: 'one scheduled occurrence never happens',
    theEngineMust: 'lose coverage, keep the stream, and not re-anchor',
  },
  {
    reality: 'FAILED_RETRY',
    injection: 'one occurrence posts three days late (failed payment, retried)',
    theEngineMust: 'match it inside tolerance and widen the MAD band by a day, not re-anchor',
  },
  {
    reality: 'PRICE_HIKE',
    injection: 'a mid-stream rise of 18–50%; the 50% case splits the amount buckets',
    theEngineMust: 'stay one stream, emit one two-sided changepoint, re-baseline the amount',
  },
  {
    reality: 'DESCRIPTOR_CHANGE',
    injection: 'the descriptor changes mid-stream while the merchant identity does not',
    theEngineMust:
      'be unable to tell — the engine sees only merchantId (D25), which is the point',
  },
  {
    reality: 'CARD_MIGRATION',
    injection: 'the account changes mid-stream after a one-period gap (card reissued)',
    theEngineMust: 'keep one stream, propose CARD_MIGRATION, and not call it a cancellation',
  },
  {
    reality: 'PRORATION',
    injection: 'one charge at a third of the usual amount, then the old amount resumes',
    theEngineMust: 'not call it a price change (both-sides stability fails)',
  },
  {
    reality: 'ANNUAL_TO_MONTHLY',
    injection: 'an annual plan stops and a monthly plan at the same merchant begins',
    theEngineMust: 'produce two streams, not one merged nonsense cadence',
  },
  {
    reality: 'REFUND',
    injection: 'an inflow from a merchant that also bills the account',
    theEngineMust: 'not type it RECURRING_INCOME (sign split, then the refund suppression)',
  },
  {
    reality: 'DUPLICATE_CHARGE',
    injection: 'the same charge twice on the same day',
    theEngineMust: 'keep both ids, count the date once, flag the duplicate',
  },
  {
    reality: 'DORMANCY',
    injection: 'two streams stop four to seven months before "today"',
    theEngineMust: 'climb the ladder to LIKELY_CANCELED/CANCELED and stop forecasting',
  },
  {
    reality: 'NOISE_MERCHANT',
    injection: '30% of merchants are pure noise: 1–6 unrelated purchases',
    theEngineMust: 'detect nothing — this is the precision denominator',
  },
  {
    reality: 'AMBIGUOUS_MERCHANT',
    injection: 'three charges a month apart at varying amounts, from an unclassified payee',
    theEngineMust:
      'be genuinely uncertain — these are the corpus\'s hard negatives and they are what the ' +
      'operating-point sweep is choosing against',
  },
  {
    reality: 'HABIT_MERCHANT',
    injection: 'coffee and groceries, 2–3 times a week at varying amounts',
    theEngineMust: 'type FREQUENT_MERCHANT, never a subscription',
  },
]);

export interface GoldStream {
  readonly goldId: string;
  readonly merchantId: string;
  readonly cadence: Cadence;
  readonly amountModel: AmountModel;
  readonly expectedTypes: readonly StreamType[];
  readonly transactionIds: readonly string[];
  /** Magnitude of the last charge — the level a detector should report. */
  readonly finalAmountMinor: bigint;
  readonly realities: readonly Reality[];
  /** Declared price changes: what a perfect detector would report. */
  readonly priceChanges: readonly { readonly effectiveDate: DateOnly; readonly toMinor: bigint }[];
  /** The next charge after the corpus horizon, for next-due MAE. */
  readonly trueNextDue: DateOnly | null;
  readonly dormant: boolean;
}

export interface Corpus {
  readonly inputs: readonly RecurringInput[];
  readonly gold: readonly GoldStream[];
  readonly facts: ReadonlyMap<string, MerchantFacts>;
  readonly today: DateOnly;
  readonly realityCounts: ReadonlyMap<Reality, number>;
  readonly merchantCount: number;
  readonly noiseMerchantCount: number;
}

const START = DateOnly.parse('2023-09-15');
const END = DateOnly.parse('2026-09-15');
export const SYNTHETIC_TODAY = DateOnly.parse('2026-09-15');
export const SYNTHETIC_SEED = 20260916;

const CHECKING = 'acc-checking';
const VISA = 'acc-visa';
const VISA_REISSUED = 'acc-visa-reissued';

interface Plan {
  readonly key: string;
  readonly merchantId: string;
  readonly cadence: Cadence;
  readonly anchor: string;
  readonly amount: string;
  readonly klass: MerchantClass;
  readonly serviceNode?: string;
  readonly bundleSku?: string;
  /** Relative amplitude of per-occurrence amount noise. 0 is a fixed price. */
  readonly variability?: number;
  readonly inflow?: boolean;
  readonly account?: string;
  readonly postsOnWeekend?: boolean;
  readonly secondDayOfMonth?: number;
  readonly stopAfter?: number;
  readonly hikeAt?: number;
  readonly hikePercent?: number;
  readonly migrateAt?: number;
  readonly migrateTo?: string;
  readonly prorationAt?: number;
  readonly skipAt?: number;
  readonly retryAt?: number;
  readonly duplicateAt?: number;
  readonly refundAt?: number;
  readonly startAtMonth?: number;
  readonly realities?: readonly Reality[];
}

/**
 * The catalogue. Amounts and cadences are ordinary; what matters is the spread
 * across all eight cadences and the realities bolted onto individual plans.
 */
const PLANS: readonly Plan[] = Object.freeze([
  // --- monthly fixed subscriptions -----------------------------------------
  { key: 's01', merchantId: 'mer-0001', cadence: 'MONTHLY', anchor: '2023-09-17', amount: '17.99', klass: 'SUBSCRIPTION', serviceNode: 'media/video', hikeAt: 14, hikePercent: 22, realities: ['PRICE_HIKE'] },
  { key: 's02', merchantId: 'mer-0002', cadence: 'MONTHLY', anchor: '2023-09-21', amount: '10.99', klass: 'SUBSCRIPTION', serviceNode: 'media/music', refundAt: 9, realities: ['REFUND'] },
  { key: 's03', merchantId: 'mer-0003', cadence: 'MONTHLY', anchor: '2023-09-29', amount: '2.99', klass: 'SUBSCRIPTION', serviceNode: 'cloud/storage', skipAt: 11, realities: ['SKIPPED_PERIOD'] },
  { key: 's04', merchantId: 'mer-0004', cadence: 'MONTHLY', anchor: '2023-10-01', amount: '15.49', klass: 'SUBSCRIPTION', serviceNode: 'media/video', duplicateAt: 7, realities: ['DUPLICATE_CHARGE'] },
  { key: 's05', merchantId: 'mer-0005', cadence: 'MONTHLY', anchor: '2023-09-18', amount: '9.99', klass: 'SUBSCRIPTION', serviceNode: 'productivity/ai', realities: ['DESCRIPTOR_CHANGE'] },
  { key: 's06', merchantId: 'mer-0006', cadence: 'MONTHLY', anchor: '2023-09-25', amount: '5.99', klass: 'SUBSCRIPTION', serviceNode: 'security/vpn' },
  { key: 's07', merchantId: 'mer-0007', cadence: 'MONTHLY', anchor: '2023-10-03', amount: '12.99', klass: 'SUBSCRIPTION', serviceNode: 'media/video', account: VISA, migrateAt: 19, migrateTo: VISA_REISSUED, realities: ['CARD_MIGRATION'] },
  { key: 's08', merchantId: 'mer-0008', cadence: 'MONTHLY', anchor: '2023-09-30', amount: '31.00', klass: 'SUBSCRIPTION', retryAt: 13, realities: ['FAILED_RETRY'] },
  { key: 's09', merchantId: 'mer-0009', cadence: 'MONTHLY', anchor: '2023-10-05', amount: '9.99', klass: 'SUBSCRIPTION', hikeAt: 20, hikePercent: 50, realities: ['PRICE_HIKE'] },
  { key: 's10', merchantId: 'mer-0010', cadence: 'MONTHLY', anchor: '2023-09-16', amount: '49.99', klass: 'SUBSCRIPTION', serviceNode: 'fitness' },
  { key: 's11', merchantId: 'mer-0011', cadence: 'MONTHLY', anchor: '2023-10-08', amount: '14.99', klass: 'SUBSCRIPTION', prorationAt: 16, realities: ['PRORATION'] },
  { key: 's12', merchantId: 'mer-0012', cadence: 'MONTHLY', anchor: '2023-09-19', amount: '6.99', klass: 'SUBSCRIPTION', serviceNode: 'news' },
  { key: 's13', merchantId: 'mer-0013', cadence: 'MONTHLY', anchor: '2023-10-11', amount: '22.00', klass: 'SUBSCRIPTION', serviceNode: 'productivity/ai' },
  { key: 's14', merchantId: 'mer-0014', cadence: 'MONTHLY', anchor: '2023-08-31', amount: '8.99', klass: 'SUBSCRIPTION' },
  { key: 's15', merchantId: 'mer-0015', cadence: 'MONTHLY', anchor: '2023-10-15', amount: '19.99', klass: 'SUBSCRIPTION', serviceNode: 'media/video', bundleSku: 'trio-bundle' },
  { key: 's16', merchantId: 'mer-0016', cadence: 'MONTHLY', anchor: '2023-09-22', amount: '3.99', klass: 'SUBSCRIPTION', serviceNode: 'cloud/storage' },
  { key: 's17', merchantId: 'mer-0017', cadence: 'MONTHLY', anchor: '2023-10-18', amount: '11.00', klass: 'SUBSCRIPTION', stopAfter: 29, realities: ['DORMANCY'] },
  { key: 's18', merchantId: 'mer-0018', cadence: 'MONTHLY', anchor: '2023-09-27', amount: '7.49', klass: 'SUBSCRIPTION', serviceNode: 'media/music' },

  // --- monthly variable bills ----------------------------------------------
  { key: 'b01', merchantId: 'mer-0020', cadence: 'MONTHLY', anchor: '2023-09-20', amount: '142.00', klass: 'UTILITY', variability: 0.18 },
  { key: 'b02', merchantId: 'mer-0021', cadence: 'MONTHLY', anchor: '2023-09-24', amount: '88.50', klass: 'UTILITY', variability: 0.22 },
  { key: 'b03', merchantId: 'mer-0022', cadence: 'MONTHLY', anchor: '2023-10-02', amount: '61.00', klass: 'UTILITY', variability: 0.12 },
  { key: 'b04', merchantId: 'mer-0023', cadence: 'MONTHLY', anchor: '2023-09-26', amount: '75.00', klass: 'UTILITY', variability: 0.08, postsOnWeekend: true },
  { key: 'b05', merchantId: 'mer-0024', cadence: 'MONTHLY', anchor: '2023-10-06', amount: '210.00', klass: 'UTILITY', variability: 0.16, stopAfter: 31, realities: ['DORMANCY'] },

  // --- loans and taxes ------------------------------------------------------
  { key: 'l01', merchantId: 'mer-0030', cadence: 'MONTHLY', anchor: '2023-10-01', amount: '2412.55', klass: 'LOAN' },
  { key: 'l02', merchantId: 'mer-0031', cadence: 'MONTHLY', anchor: '2023-09-28', amount: '389.12', klass: 'LOAN' },
  { key: 'x01', merchantId: 'mer-0032', cadence: 'QUARTERLY', anchor: '2023-09-15', amount: '3500.00', klass: 'TAX' },

  // --- weekly / biweekly / semimonthly -------------------------------------
  { key: 'w01', merchantId: 'mer-0040', cadence: 'WEEKLY', anchor: '2023-09-19', amount: '24.00', klass: 'SUBSCRIPTION', serviceNode: 'fitness' },
  { key: 'w02', merchantId: 'mer-0041', cadence: 'WEEKLY', anchor: '2023-09-21', amount: '35.00', klass: 'UTILITY', variability: 0.1 },
  { key: 'w03', merchantId: 'mer-0042', cadence: 'BIWEEKLY', anchor: '2023-09-22', amount: '55.00', klass: 'SUBSCRIPTION' },
  { key: 'i01', merchantId: 'mer-0043', cadence: 'BIWEEKLY', anchor: '2023-09-22', amount: '2845.19', klass: 'PAYROLL', inflow: true, account: CHECKING, variability: 0.02 },
  { key: 'i02', merchantId: 'mer-0044', cadence: 'SEMIMONTHLY', anchor: '2023-10-01', secondDayOfMonth: 15, amount: '1420.00', klass: 'PAYROLL', inflow: true, account: CHECKING, variability: 0.03 },
  { key: 'i03', merchantId: 'mer-0045', cadence: 'MONTHLY', anchor: '2023-09-25', amount: '210.00', klass: 'PAYROLL', inflow: true, account: CHECKING, variability: 0.05 },

  // --- longer cadences ------------------------------------------------------
  { key: 'q01', merchantId: 'mer-0050', cadence: 'QUARTERLY', anchor: '2023-10-04', amount: '149.00', klass: 'SUBSCRIPTION' },
  { key: 'q02', merchantId: 'mer-0051', cadence: 'QUARTERLY', anchor: '2023-09-18', amount: '86.00', klass: 'UTILITY', variability: 0.14 },
  { key: 'm01', merchantId: 'mer-0052', cadence: 'BIMONTHLY', anchor: '2023-09-29', amount: '64.00', klass: 'UTILITY', variability: 0.1 },
  { key: 'm02', merchantId: 'mer-0053', cadence: 'BIMONTHLY', anchor: '2023-10-12', amount: '39.00', klass: 'SUBSCRIPTION' },
  { key: 'h01', merchantId: 'mer-0054', cadence: 'SEMIANNUAL', anchor: '2023-10-09', amount: '612.00', klass: 'UTILITY', variability: 0.05 },
  { key: 'h02', merchantId: 'mer-0055', cadence: 'SEMIANNUAL', anchor: '2023-09-23', amount: '240.00', klass: 'SUBSCRIPTION' },
  { key: 'a01', merchantId: 'mer-0056', cadence: 'ANNUAL', anchor: '2023-10-14', amount: '99.00', klass: 'SUBSCRIPTION', serviceNode: 'cloud/storage' },
  { key: 'a02', merchantId: 'mer-0057', cadence: 'ANNUAL', anchor: '2023-09-26', amount: '139.00', klass: 'SUBSCRIPTION' },
  { key: 'a03', merchantId: 'mer-0058', cadence: 'ANNUAL', anchor: '2023-10-20', amount: '1200.00', klass: 'UTILITY' },

  // --- annual -> monthly switch, one merchant, two plans --------------------
  { key: 'v01', merchantId: 'mer-0060', cadence: 'ANNUAL', anchor: '2023-09-20', amount: '119.88', klass: 'SUBSCRIPTION', stopAfter: 3, realities: ['ANNUAL_TO_MONTHLY'] },
  { key: 'v02', merchantId: 'mer-0060', cadence: 'MONTHLY', anchor: '2025-10-20', amount: '12.99', klass: 'SUBSCRIPTION', realities: ['ANNUAL_TO_MONTHLY'] },

  // --- habits: frequent, never a subscription -------------------------------
  { key: 'f01', merchantId: 'mer-0070', cadence: 'WEEKLY', anchor: '2023-09-18', amount: '6.25', klass: 'RETAIL', variability: 0.3, realities: ['HABIT_MERCHANT'] },
  { key: 'f02', merchantId: 'mer-0071', cadence: 'WEEKLY', anchor: '2023-09-23', amount: '82.00', klass: 'RETAIL', variability: 0.35, realities: ['HABIT_MERCHANT'] },
]);

function amountMinor(major: string): bigint {
  return Money.parseAmount(major, 'USD').minor;
}

function isWeekend(date: DateOnly): boolean {
  const dow = DateOnly.dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** The generator's own calendar. Deliberately not the engine's `slotOf`. */
function slot(plan: Plan, index: number): DateOnly {
  const anchor = DateOnly.parse(plan.anchor);
  switch (plan.cadence) {
    case 'WEEKLY':
      return DateOnly.addDays(anchor, 7 * index);
    case 'BIWEEKLY':
      return DateOnly.addDays(anchor, 14 * index);
    case 'SEMIMONTHLY': {
      const base = DateOnly.addMonths(DateOnly.startOfMonth(anchor), Math.floor(index / 2));
      const dom = index % 2 === 0 ? DateOnly.day(anchor) : (plan.secondDayOfMonth ?? 15);
      const limit = DateOnly.daysInMonth(DateOnly.year(base), DateOnly.month(base));
      return DateOnly.of(DateOnly.year(base), DateOnly.month(base), Math.min(dom, limit));
    }
    case 'MONTHLY':
      return DateOnly.addMonths(anchor, index);
    case 'BIMONTHLY':
      return DateOnly.addMonths(anchor, 2 * index);
    case 'QUARTERLY':
      return DateOnly.addMonths(anchor, 3 * index);
    case 'SEMIANNUAL':
      return DateOnly.addMonths(anchor, 6 * index);
    case 'ANNUAL':
      return DateOnly.addMonths(anchor, 12 * index);
  }
}

function jitterAmount(base: bigint, variability: number, rng: Rng): bigint {
  if (variability === 0) return base;
  const swing = (rng.next() * 2 - 1) * variability;
  const delta = BigInt(Math.round(Number(base) * swing));
  const value = base + delta;
  return value > 0n ? value : base;
}

interface Emitted {
  readonly inputs: RecurringInput[];
  readonly gold: GoldStream;
}

function emitPlan(plan: Plan, rng: Rng, counter: { value: number }): Emitted {
  const inputs: RecurringInput[] = [];
  const goldIds: string[] = [];
  const priceChanges: { effectiveDate: DateOnly; toMinor: bigint }[] = [];
  const base = amountMinor(plan.amount);
  const sign = plan.inflow === true ? 1n : -1n;
  const postsOnWeekend = plan.postsOnWeekend ?? false;
  const realities = new Set<Reality>(plan.realities ?? []);
  let trueNextDue: DateOnly | null = null;
  let finalAmountMinor = base;

  for (let index = 0; index < 500; index += 1) {
    const scheduled = slot(plan, index);
    if (DateOnly.isAfter(scheduled, END)) {
      trueNextDue = scheduled;
      break;
    }
    if (plan.stopAfter !== undefined && index >= plan.stopAfter) break;
    if (plan.skipAt === index) continue;
    if (DateOnly.isBefore(scheduled, START)) continue;

    let posted = scheduled;
    if (!postsOnWeekend && isWeekend(posted)) {
      while (isWeekend(posted)) posted = DateOnly.addDays(posted, 1);
      realities.add('WEEKEND_SHIFT');
    }
    // Billers run a day late, never a day early.
    if (rng.chance(0.14)) posted = DateOnly.addDays(posted, 1);
    if (plan.retryAt === index) posted = DateOnly.addDays(posted, 3);

    const hiked =
      plan.hikeAt !== undefined && index >= plan.hikeAt
        ? base + (base * BigInt(plan.hikePercent ?? 20)) / 100n
        : base;
    if (plan.hikeAt === index) priceChanges.push({ effectiveDate: posted, toMinor: hiked });

    let value = jitterAmount(hiked, plan.variability ?? 0, rng);
    if (plan.prorationAt === index) value = value / 3n;

    counter.value += 1;
    finalAmountMinor = value;
    const id = `txn-${String(counter.value).padStart(5, '0')}`;
    goldIds.push(id);
    inputs.push({
      transactionId: id,
      merchantId: plan.merchantId,
      accountId:
        plan.migrateAt !== undefined && index >= plan.migrateAt
          ? (plan.migrateTo ?? VISA_REISSUED)
          : (plan.account ?? VISA),
      amount: Money.of(sign * value, 'USD'),
      date: posted,
      pending: false,
      isTransfer: false,
    });

    if (plan.duplicateAt === index) {
      counter.value += 1;
      const duplicateId = `txn-${String(counter.value).padStart(5, '0')}`;
      goldIds.push(duplicateId);
      inputs.push({
        transactionId: duplicateId,
        merchantId: plan.merchantId,
        accountId: plan.account ?? VISA,
        amount: Money.of(sign * value, 'USD'),
        date: posted,
        pending: false,
        isTransfer: false,
      });
    }

    if (plan.refundAt === index) {
      counter.value += 1;
      inputs.push({
        transactionId: `txn-${String(counter.value).padStart(5, '0')}`,
        merchantId: plan.merchantId,
        accountId: plan.account ?? VISA,
        amount: Money.of(-sign * (value / 2n), 'USD'),
        date: DateOnly.addDays(posted, 4),
        pending: false,
        isTransfer: false,
      });
    }

    // The card reissue costs one period: the old card declines, the new one
    // enrols, and the month in between simply does not happen.
    if (plan.migrateAt === index + 1) index += 1;
  }

  const variability = plan.variability ?? 0;
  const amountModel: AmountModel = variability === 0 ? 'FIXED' : variability <= 0.35 ? 'VARIABLE' : 'IRREGULAR';
  const expectedTypes: readonly StreamType[] =
    plan.klass === 'RETAIL'
      ? ['FREQUENT_MERCHANT', 'ONE_OFF']
      : plan.inflow === true
        ? ['RECURRING_INCOME']
        : plan.klass === 'LOAN'
          ? ['LOAN_PAYMENT']
          : amountModel === 'FIXED'
            ? ['SUBSCRIPTION', 'RECURRING_BILL']
            : ['RECURRING_BILL'];

  return {
    inputs,
    gold: {
      goldId: plan.key,
      merchantId: plan.merchantId,
      cadence: plan.cadence,
      amountModel,
      expectedTypes,
      transactionIds: goldIds,
      finalAmountMinor,
      realities: [...realities].sort(),
      priceChanges,
      trueNextDue,
      dormant: plan.stopAfter !== undefined,
    },
  };
}

function noiseMerchants(rng: Rng, counter: { value: number }, count: number): RecurringInput[] {
  const inputs: RecurringInput[] = [];
  const span = DateOnly.differenceInDays(START, END);
  for (let index = 0; index < count; index += 1) {
    const merchantId = `noise-${String(index).padStart(4, '0')}`;
    const charges = rng.int(1, 6);
    for (let charge = 0; charge < charges; charge += 1) {
      counter.value += 1;
      inputs.push({
        transactionId: `txn-${String(counter.value).padStart(5, '0')}`,
        merchantId,
        accountId: rng.chance(0.5) ? VISA : CHECKING,
        amount: Money.of(BigInt(-rng.int(380, 21_500)), 'USD'),
        date: DateOnly.addDays(START, rng.int(0, span)),
        pending: false,
        isTransfer: false,
      });
    }
  }
  return inputs;
}

/**
 * The hard negatives: a payee that charged three times, a month apart, for
 * different amounts. A roofer on a payment plan, three months of a course, a
 * vet. There is no answer from shape alone — which is the point. They are what
 * stops the corpus from being a lap of honour, and what the operating-point
 * sweep is actually trading recall against.
 */
function ambiguousMerchants(rng: Rng, counter: { value: number }, count: number): RecurringInput[] {
  const inputs: RecurringInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const merchantId = `ambiguous-${String(index).padStart(4, '0')}`;
    const base = rng.int(4_500, 38_000);
    let date = DateOnly.addDays(START, rng.int(30, 700));
    for (let charge = 0; charge < 3; charge += 1) {
      counter.value += 1;
      const swing = (rng.next() * 2 - 1) * 0.25;
      inputs.push({
        transactionId: `txn-${String(counter.value).padStart(5, '0')}`,
        merchantId,
        accountId: VISA,
        amount: Money.of(BigInt(-Math.round(base * (1 + swing))), 'USD'),
        date,
        pending: false,
        isTransfer: false,
      });
      date = DateOnly.addDays(date, 30 + rng.int(-4, 4));
    }
  }
  return inputs;
}

/** 2–3 visits a week at a varying amount: a habit, and never a subscription. */
function habitMerchants(rng: Rng, counter: { value: number }): RecurringInput[] {
  const inputs: RecurringInput[] = [];
  const merchants = ['habit-0001', 'habit-0002'];
  for (const merchantId of merchants) {
    let cursor = START;
    while (DateOnly.isBefore(cursor, END)) {
      const visits = rng.int(2, 3);
      for (let visit = 0; visit < visits; visit += 1) {
        counter.value += 1;
        inputs.push({
          transactionId: `txn-${String(counter.value).padStart(5, '0')}`,
          merchantId,
          accountId: VISA,
          amount: Money.of(BigInt(-rng.int(415, 1_290)), 'USD'),
          date: DateOnly.addDays(cursor, rng.int(0, 6)),
          pending: false,
          isTransfer: false,
        });
      }
      cursor = DateOnly.addDays(cursor, 7);
    }
  }
  return inputs;
}

/**
 * Build the corpus. Same seed, same corpus, byte for byte — including the final
 * shuffle, which exists so the gate also proves the engine is order-independent.
 */
export function syntheticCorpus(seed: number = SYNTHETIC_SEED): Corpus {
  const rng = mulberry32(seed);
  const counter = { value: 0 };
  const inputs: RecurringInput[] = [];
  const gold: GoldStream[] = [];
  const facts = new Map<string, MerchantFacts>();

  for (const plan of PLANS) {
    const emitted = emitPlan(plan, rng, counter);
    inputs.push(...emitted.inputs);
    gold.push(emitted.gold);
    facts.set(plan.merchantId, {
      class: plan.klass,
      serviceNode: plan.serviceNode ?? null,
      bundleSku: plan.bundleSku ?? null,
    });
  }

  const ambiguous = ambiguousMerchants(rng, counter, 5);
  inputs.push(...ambiguous);
  for (const input of ambiguous) facts.set(input.merchantId, { class: 'UNKNOWN' });

  const habits = habitMerchants(rng, counter);
  inputs.push(...habits);
  for (const input of habits) facts.set(input.merchantId, { class: 'RETAIL' });

  // 30% of merchants are pure noise (07 §2.12), rounded up.
  const realMerchants = new Set(inputs.map((input) => input.merchantId)).size;
  const noiseCount = Math.ceil(realMerchants * 3 / 7);
  const noise = noiseMerchants(rng, counter, noiseCount);
  inputs.push(...noise);
  for (const input of noise) {
    if (!facts.has(input.merchantId)) facts.set(input.merchantId, { class: 'UNKNOWN' });
  }

  // A handful of pending rows, which the engine must drop rather than model.
  const pending: RecurringInput[] = inputs.slice(0, 6).map((input, index) => ({
    ...input,
    transactionId: `pending-${String(index).padStart(3, '0')}`,
    date: DateOnly.addDays(SYNTHETIC_TODAY, -1),
    pending: true,
  }));
  inputs.push(...pending);

  const realityCounts = new Map<Reality, number>();
  for (const stream of gold) {
    for (const reality of stream.realities) {
      realityCounts.set(reality, (realityCounts.get(reality) ?? 0) + 1);
    }
  }
  realityCounts.set('NOISE_MERCHANT', noiseCount);
  realityCounts.set('AMBIGUOUS_MERCHANT', 5);
  realityCounts.set('HABIT_MERCHANT', (realityCounts.get('HABIT_MERCHANT') ?? 0) + 2);

  // Shuffle: the engine must not depend on input order.
  const shuffled = [...inputs];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    const left = shuffled[index] as RecurringInput;
    shuffled[index] = shuffled[swap] as RecurringInput;
    shuffled[swap] = left;
  }

  return {
    inputs: shuffled,
    gold,
    facts,
    today: SYNTHETIC_TODAY,
    realityCounts,
    merchantCount: new Set(shuffled.map((input) => input.merchantId)).size,
    noiseMerchantCount: noiseCount,
  };
}
