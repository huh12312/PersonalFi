// SPDX-License-Identifier: MIT
/**
 * The read models: what is coming, what it will cost, and what is left.
 *
 * Three questions, three functions, one projection underneath all of them.
 * `projectCharges` turns stored series into dated, banded future charges;
 * `upcomingCalendar` renders them, `forwardCashFlow` sums them and
 * `safeToSpend` subtracts them from cash. Keeping the projection in one place is
 * what stops the calendar and the cash-flow number from disagreeing on screen,
 * which is the specific bug that makes a forecast untrustworthy.
 *
 * ## Every number here carries a band, and the band is not decoration
 *
 * A forecast that says "$1,247.00" is claiming a precision this system does not
 * have: the date a bill posts moves with weekends and processing, and a
 * `VARIABLE` stream's amount moves with usage. So every projected charge
 * carries:
 *
 *   * a **date band** — `± uncertaintyDays`, which 07 §2.5 defines as
 *     `ceil(1.5 × MAD(residuals))` from the stream's own history, widened by a
 *     day per period for slots further out and by the weekend-shift tolerance
 *     for every slot after the next one (the stored `next_due_date` has already
 *     been shifted; a slot computed from the anchor has not);
 *   * an **amount band** — the empirical `[observed_min, observed_max]` union
 *     the median ± MAD. Empirical, because "we have seen between $42 and $178
 *     from this biller" is a true sentence and a normal distribution fitted to
 *     nine data points is not. It is also what makes the band survive a price
 *     change: the new price is by construction one end of the observed range.
 *
 * `test/db/forecast.test.ts` asserts the consequence against the seed
 * generator's own ground truth — every charge the generator will actually
 * produce in the next 30 days falls inside the band this file projects.
 *
 * ## What is counted, and what is only shown
 *
 * By default only `ACTIVE` series project. A `CANDIDATE` is a question the user
 * has not answered, and spending their money against an unanswered question is
 * exactly the false-positive cost 04 §5.1 is written to avoid. `includeCandidates`
 * exists for the "what might I be missing?" view, which says so on screen.
 */
import { DateOnly, Money, type Money as MoneyType } from '@core/kernel';
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  recurringCandidates,
  recurringSeries,
  type RecurringCandidateRow,
  type RecurringSeriesRow,
  type SeriesState,
} from '../schema/index.ts';
import { WEEKEND_FORWARD_TOLERANCE_DAYS, periodDaysOf, slotOf, specOf } from './cadence.ts';
import { scoreOf, type RecurringExecutor } from './store.ts';
import type { Cadence } from './types.ts';

/** The default horizon. 30 days, because that is the question people actually ask. */
export const DEFAULT_HORIZON_DAYS = 30;

/** Never project more than this many slots per series inside one window. */
const MAX_SLOTS_PER_SERIES = 64;

export interface ProjectedCharge {
  readonly seriesId: string;
  readonly streamKey: string;
  readonly merchantId: string;
  readonly type: string;
  readonly cadence: string;
  readonly sign: 'OUTFLOW' | 'INFLOW';
  readonly status: string;
  readonly userConfirmed: boolean;
  readonly confidence: number;
  /** `0` is the stored next-due; `1` is the slot after it, and so on. */
  readonly slot: number;
  readonly date: DateOnly;
  readonly earliest: DateOnly;
  readonly latest: DateOnly;
  readonly uncertaintyDays: number;
  /** Signed, house convention: an outflow is negative. */
  readonly expected: MoneyType;
  readonly low: MoneyType;
  readonly high: MoneyType;
}

export interface ProjectionInput {
  readonly userId: string;
  readonly from: DateOnly;
  readonly days?: number;
  /** Include series the user has not ruled on yet. Off by default; see the header. */
  readonly includeCandidates?: boolean;
  readonly merchantIds?: readonly string[];
}

/**
 * The live series a forecast is allowed to be built from.
 *
 * `ARCHIVED` never projects: it is either something the detector withdrew or
 * something the user rejected, and both mean "do not put this in front of them
 * again". `CANCELED`/`LIKELY_CANCELED` do not project either — the whole point
 * of the dormancy ladder is that a stream that stopped arriving stops being
 * forecast, rather than forecasting a charge that never comes and making the
 * safe-to-spend number quietly pessimistic forever.
 */
const PROJECTING_STATUSES = ['EARLY_DETECTION', 'ACTIVE', 'AT_RISK', 'MIGRATED'];

export async function loadProjectableSeries(
  executor: RecurringExecutor,
  input: ProjectionInput,
): Promise<RecurringSeriesRow[]> {
  const states: SeriesState[] =
    input.includeCandidates === true ? ['ACTIVE', 'CANDIDATE'] : ['ACTIVE'];
  const conditions: SQL[] = [
    eq(recurringSeries.userId, input.userId),
    inArray(recurringSeries.state, states),
    inArray(recurringSeries.status, PROJECTING_STATUSES),
    isNotNull(recurringSeries.nextDueDate),
  ];
  if (input.merchantIds !== undefined) {
    if (input.merchantIds.length === 0) return [];
    conditions.push(inArray(recurringSeries.merchantId, [...input.merchantIds]));
  }
  return executor
    .select()
    .from(recurringSeries)
    .where(and(...conditions))
    .orderBy(asc(recurringSeries.nextDueDate), asc(recurringSeries.streamKey));
}

/**
 * The amount band for one series.
 *
 * Three sources, unioned: what has actually been observed (`observed_min` …
 * `observed_max`), the prediction ± the stream's own MAD, and the prediction
 * itself. For a `FIXED` stream all three collapse to one number, which is
 * correct — a subscription that has cost $15.99 nine times in a row is
 * forecast at $15.99, not at "somewhere between $14 and $18".
 *
 * A `VARIABLE` stream gets one more thing: the observed extremes are widened by
 * the MAD. The observed minimum is itself only a sample — a mild winter really
 * does produce a gas bill below anything in two years of history — so treating
 * it as a hard floor makes the band wrong in exactly the case it exists for.
 * Found by `test/db/forecast.test.ts`, which had a real future charge $11 under
 * a two-year observed minimum.
 */
function bandOf(
  row: RecurringSeriesRow,
  expectedMinor: bigint,
): { readonly low: bigint; readonly high: bigint } {
  const mad = row.amountMadMinor < 0n ? -row.amountMadMinor : row.amountMadMinor;
  const slack = row.amountModel === 'FIXED' ? 0n : mad;
  const lows = [row.observedMinMinor - slack, expectedMinor - mad, expectedMinor];
  const highs = [row.observedMaxMinor + slack, expectedMinor + mad, expectedMinor];
  let low = lows[0] as bigint;
  let high = highs[0] as bigint;
  for (const value of lows) if (value < low) low = value;
  for (const value of highs) if (value > high) high = value;
  return { low, high };
}

/**
 * Turn one stored series into its charges inside `[from, from + days]`.
 *
 * Slot 0 is the stored `next_due_date` verbatim, because the engine already
 * applied 07 §2.5's weekend shift to it and recomputing it here from the anchor
 * would silently disagree with what the series row says. Later slots are
 * computed from the *anchor* and never from the previous slot — that is the
 * whole reason `anchor_date` is stored — so a February clamp releases in March
 * instead of dragging the rest of the year back by three days.
 */
export function projectSeries(
  row: RecurringSeriesRow,
  from: DateOnly,
  to: DateOnly,
): ProjectedCharge[] {
  if (row.nextDueDate === null) return [];
  // The `date` columns come back as plain strings; `DateOnly` is a branded
  // string, so the narrowing has to be explicit. `parse` validates rather than
  // casts — a malformed date in the database should fail loudly here and not
  // silently produce a forecast for the year 0202.
  const nextDue = DateOnly.parse(row.nextDueDate);
  const anchor = DateOnly.parse(row.anchorDate);
  const expectedMinor = row.nextDueAmountMinor ?? row.typicalAmountMinor;
  const uncertainty = Math.max(1, row.nextDueUncertaintyDays ?? 1);
  const band = bandOf(row, expectedMinor);
  const currency = row.typicalAmountCurrency;

  const common = {
    seriesId: row.id,
    streamKey: row.streamKey,
    merchantId: row.merchantId,
    type: row.type,
    cadence: row.cadence,
    sign: row.sign,
    status: row.status,
    userConfirmed: row.userConfirmed,
    confidence: scoreOf(row.confidence),
  };

  const charges: ProjectedCharge[] = [];
  const push = (date: DateOnly, slot: number): void => {
    // A slot further out has had more chances to drift, and every slot after
    // the next one is a raw calendar slot that has not been weekend-shifted.
    const halfWidth =
      slot === 0 ? uncertainty : uncertainty + slot + WEEKEND_FORWARD_TOLERANCE_DAYS;
    charges.push({
      ...common,
      slot,
      date,
      earliest: DateOnly.addDays(date, -halfWidth),
      latest: DateOnly.addDays(date, halfWidth),
      uncertaintyDays: halfWidth,
      expected: Money.of(expectedMinor, currency),
      low: Money.of(band.low, currency),
      high: Money.of(band.high, currency),
    });
  };

  if (!DateOnly.isBefore(nextDue, from) && !DateOnly.isAfter(nextDue, to)) push(nextDue, 0);

  // An UNKNOWN cadence has a next due (the engine still predicts one from the
  // median gap) but no schedule to extend, so it contributes exactly one slot.
  if (row.cadence === 'UNKNOWN') return charges;
  const spec = specOf(row.cadence as Cadence);
  const pair =
    row.dayOfMonthPair === null || row.dayOfMonthPair.length < 2
      ? null
      : ([row.dayOfMonthPair[0], row.dayOfMonthPair[1]] as [number, number]);

  // Start from the first slot strictly after the stored next-due, found by
  // estimating from the period length and then correcting — a linear walk from
  // the anchor would be up to a hundred iterations for a weekly stream.
  //
  // `index` counts *slots*, not periods, which is the same thing for every
  // cadence except SEMIMONTHLY — there `slotOf` reads `index % 2` to pick which
  // of the two days of the month it means, and `periodDays` is the half-month,
  // so dividing by it still lands on the right slot.
  const fromAnchor = DateOnly.differenceInDays(anchor, nextDue);
  let index = Math.max(0, Math.floor(fromAnchor / periodDaysOf(spec.cadence)));
  while (index > 0 && DateOnly.isAfter(slotOf(anchor, spec, index - 1, pair), nextDue)) {
    index -= 1;
  }
  while (!DateOnly.isAfter(slotOf(anchor, spec, index, pair), nextDue)) {
    index += 1;
  }

  let slot = 1;
  while (slot <= MAX_SLOTS_PER_SERIES) {
    const date = slotOf(anchor, spec, index, pair);
    if (DateOnly.isAfter(date, to)) break;
    if (!DateOnly.isBefore(date, from)) push(date, slot);
    slot += 1;
    index += 1;
  }
  return charges;
}

export async function projectCharges(
  executor: RecurringExecutor,
  input: ProjectionInput,
): Promise<ProjectedCharge[]> {
  const to = DateOnly.addDays(input.from, input.days ?? DEFAULT_HORIZON_DAYS);
  const rows = await loadProjectableSeries(executor, input);
  const charges = rows.flatMap((row) => projectSeries(row, input.from, to));
  charges.sort((a, b) =>
    a.date === b.date ? a.streamKey.localeCompare(b.streamKey) : a.date < b.date ? -1 : 1,
  );
  return charges;
}

// ---------------------------------------------------------------------------
// The upcoming calendar
// ---------------------------------------------------------------------------

export interface CalendarDay {
  readonly date: DateOnly;
  readonly charges: readonly ProjectedCharge[];
  readonly outflow: MoneyType;
  readonly inflow: MoneyType;
}

export interface UpcomingCalendar {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly currency: string;
  readonly days: readonly CalendarDay[];
  readonly chargeCount: number;
}

/**
 * "What is coming, and when?" — grouped by the *expected* day.
 *
 * Only days that have something on them are returned. A calendar that returns
 * thirty rows, twenty-six of them empty, makes the caller filter and makes the
 * payload mostly zeroes.
 */
export async function upcomingCalendar(
  executor: RecurringExecutor,
  input: ProjectionInput & { readonly currency?: string },
): Promise<UpcomingCalendar> {
  const from = input.from;
  const to = DateOnly.addDays(from, input.days ?? DEFAULT_HORIZON_DAYS);
  const charges = await projectCharges(executor, input);
  const currency = input.currency ?? charges[0]?.expected.currency ?? 'USD';

  const byDate = new Map<DateOnly, ProjectedCharge[]>();
  for (const charge of charges) {
    const bucket = byDate.get(charge.date);
    if (bucket === undefined) byDate.set(charge.date, [charge]);
    else bucket.push(charge);
  }

  const days: CalendarDay[] = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, bucket]) => ({
      date,
      charges: bucket,
      outflow: Money.sum(
        bucket.filter((charge) => charge.sign === 'OUTFLOW').map((charge) => charge.expected),
        currency,
      ),
      inflow: Money.sum(
        bucket.filter((charge) => charge.sign === 'INFLOW').map((charge) => charge.expected),
        currency,
      ),
    }));

  return { from, to, currency, days, chargeCount: charges.length };
}

// ---------------------------------------------------------------------------
// Forward cash flow
// ---------------------------------------------------------------------------

export interface CashFlowForecast {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly currency: string;
  /** Signed sums of the expected values. Outflow is negative, inflow positive. */
  readonly outflow: MoneyType;
  readonly inflow: MoneyType;
  readonly net: MoneyType;
  /** The pessimistic and optimistic ends of the band, summed term by term. */
  readonly netLow: MoneyType;
  readonly netHigh: MoneyType;
  readonly chargeCount: number;
  readonly charges: readonly ProjectedCharge[];
}

/**
 * The 30-day forward cash flow, with the band summed term by term.
 *
 * Summing the ends rather than propagating a variance is the deliberately
 * conservative choice: it assumes every stream lands at the same end of its
 * band at once, which is not what a statistician would say and *is* what makes
 * `netLow` a number a user can plan against. The honest label for it is "worst
 * case", not "5th percentile", and it is never presented as the latter.
 */
export async function forwardCashFlow(
  executor: RecurringExecutor,
  input: ProjectionInput & { readonly currency?: string },
): Promise<CashFlowForecast> {
  const from = input.from;
  const to = DateOnly.addDays(from, input.days ?? DEFAULT_HORIZON_DAYS);
  const charges = await projectCharges(executor, input);
  const currency = input.currency ?? charges[0]?.expected.currency ?? 'USD';

  const outflows = charges.filter((charge) => charge.sign === 'OUTFLOW');
  const inflows = charges.filter((charge) => charge.sign === 'INFLOW');
  const outflow = Money.sum(
    outflows.map((charge) => charge.expected),
    currency,
  );
  const inflow = Money.sum(
    inflows.map((charge) => charge.expected),
    currency,
  );

  return {
    from,
    to,
    currency,
    outflow,
    inflow,
    net: Money.add(outflow, inflow),
    netLow: Money.sum(
      charges.map((charge) => charge.low),
      currency,
    ),
    netHigh: Money.sum(
      charges.map((charge) => charge.high),
      currency,
    ),
    chargeCount: charges.length,
    charges,
  };
}

// ---------------------------------------------------------------------------
// Safe to spend
// ---------------------------------------------------------------------------

export interface SafeToSpend {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly currency: string;
  readonly availableCash: MoneyType;
  /** What the recurring commitments will take. Negative. */
  readonly committed: MoneyType;
  /** The worst end of the committed band. Negative, and no larger than `committed`. */
  readonly committedWorstCase: MoneyType;
  /**
   * Recurring income due inside the window.
   *
   * Excluded from `safe` by default. Counting a paycheque that has not arrived
   * is how a budgeting app tells somebody they can afford something on the
   * strength of money their employer has not sent, and the one time it is wrong
   * is the time it matters.
   */
  readonly expectedIncome: MoneyType;
  /** `availableCash + committedWorstCase` (+ income, if the caller asked). */
  readonly safe: MoneyType;
  readonly committedCount: number;
}

export async function safeToSpend(
  executor: RecurringExecutor,
  input: ProjectionInput & {
    readonly availableCash: MoneyType;
    readonly countExpectedIncome?: boolean;
  },
): Promise<SafeToSpend> {
  const currency = input.availableCash.currency;
  const forecast = await forwardCashFlow(executor, { ...input, currency });
  const outflows = forecast.charges.filter((charge) => charge.sign === 'OUTFLOW');

  // The worst case for an outflow is the *most negative* end of its band.
  const committedWorstCase = Money.sum(
    outflows.map((charge) => Money.min(charge.low, charge.expected)),
    currency,
  );
  const committed = Money.sum(
    outflows.map((charge) => charge.expected),
    currency,
  );
  const expectedIncome = forecast.inflow;

  const base = Money.add(input.availableCash, committedWorstCase);
  return {
    from: forecast.from,
    to: forecast.to,
    currency,
    availableCash: input.availableCash,
    committed,
    committedWorstCase,
    expectedIncome,
    safe: input.countExpectedIncome === true ? Money.add(base, expectedIncome) : base,
    committedCount: outflows.length,
  };
}

// ---------------------------------------------------------------------------
// The queue and the list
// ---------------------------------------------------------------------------

export interface CandidateQueueEntry {
  readonly candidateId: string;
  readonly seriesId: string | null;
  readonly merchantId: string;
  readonly streamKey: string;
  readonly cadence: string;
  readonly type: string;
  readonly confidence: number;
  readonly amount: MoneyType;
  readonly sources: unknown;
  readonly proposedAt: Date;
}

/** The open questions, oldest first. Decided rows are history, not a queue. */
export async function listCandidates(
  executor: RecurringExecutor,
  input: { readonly userId: string; readonly limit?: number },
): Promise<CandidateQueueEntry[]> {
  const rows: RecurringCandidateRow[] = await executor
    .select()
    .from(recurringCandidates)
    .where(
      and(eq(recurringCandidates.userId, input.userId), eq(recurringCandidates.state, 'PROPOSED')),
    )
    .orderBy(asc(recurringCandidates.createdAt), asc(recurringCandidates.streamKey))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 500));

  return rows.map((row) => ({
    candidateId: row.id,
    seriesId: row.seriesId,
    merchantId: row.merchantId,
    streamKey: row.streamKey,
    cadence: row.proposedCadence,
    type: row.proposedType,
    confidence: scoreOf(row.proposedConfidence),
    amount: Money.of(row.proposedAmountMinor, row.proposedAmountCurrency),
    sources: row.sources,
    proposedAt: row.createdAt,
  }));
}

export interface SeriesListInput {
  readonly userId: string;
  readonly states?: readonly string[];
  readonly types?: readonly string[];
  readonly merchantIds?: readonly string[];
}

export async function listSeries(
  executor: RecurringExecutor,
  input: SeriesListInput,
): Promise<RecurringSeriesRow[]> {
  const conditions: SQL[] = [eq(recurringSeries.userId, input.userId)];
  if (input.states !== undefined) {
    if (input.states.length === 0) return [];
    conditions.push(inArray(recurringSeries.state, [...input.states] as SeriesState[]));
  }
  if (input.types !== undefined) {
    if (input.types.length === 0) return [];
    conditions.push(inArray(recurringSeries.type, [...input.types]));
  }
  if (input.merchantIds !== undefined) {
    if (input.merchantIds.length === 0) return [];
    conditions.push(inArray(recurringSeries.merchantId, [...input.merchantIds]));
  }
  return executor
    .select()
    .from(recurringSeries)
    .where(and(...conditions))
    .orderBy(asc(recurringSeries.nextDueDate), asc(recurringSeries.streamKey));
}

/**
 * The merchants a rejection has permanently silenced.
 *
 * A read model rather than an internal detail on purpose: "why is this not in
 * my subscriptions?" is a question the UI must be able to answer, and the
 * answer — "you rejected it on the 4th" — lives on exactly these rows.
 */
export async function listOverrides(
  executor: RecurringExecutor,
  userId: string,
): Promise<
  readonly {
    readonly merchantId: string;
    readonly streamKey: string;
    readonly scope: string;
    readonly decidedAt: Date | null;
    readonly reason: string | null;
  }[]
> {
  const rows = await executor
    .select({
      merchantId: recurringCandidates.merchantId,
      streamKey: recurringCandidates.streamKey,
      scope: recurringCandidates.overrideScope,
      decidedAt: recurringCandidates.decidedAt,
      reason: recurringCandidates.decidedReason,
    })
    .from(recurringCandidates)
    .where(
      and(
        eq(recurringCandidates.userId, userId),
        eq(recurringCandidates.override, 'NOT_RECURRING'),
        isNotNull(recurringCandidates.overrideScope),
      ),
    )
    .orderBy(asc(recurringCandidates.decidedAt));

  return rows.map((row) => ({
    merchantId: row.merchantId,
    streamKey: row.streamKey,
    scope: row.scope ?? 'MERCHANT',
    decidedAt: row.decidedAt,
    reason: row.reason,
  }));
}

/** Count of everything this user has, by state. The dashboard's one-line summary. */
export async function seriesCountsByState(
  executor: RecurringExecutor,
  userId: string,
): Promise<Record<string, number>> {
  const rows = await executor
    .select({ state: recurringSeries.state, count: sql<string>`count(*)` })
    .from(recurringSeries)
    .where(eq(recurringSeries.userId, userId))
    .groupBy(recurringSeries.state);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = Number(row.count);
  return counts;
}
