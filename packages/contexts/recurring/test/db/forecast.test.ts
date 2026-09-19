// SPDX-License-Identifier: MIT
/**
 * The forecast, measured against a generator that knows the future.
 *
 * Every other assertion about a projection is circular — you predict from the
 * history, then check the prediction against the history. `@core/seed` breaks
 * the circle: it generates a household's transactions from a fixed PRNG for a
 * window that extends past the date the detector is told is "today", and it
 * labels the series it generated (`SeedLabels.recurringSeries`). So the
 * detector is shown two years of history, the projection is computed for the
 * next thirty days, and the charges the generator *will* produce in those
 * thirty days are ground truth that no part of this context has seen.
 *
 * ## What is being claimed, precisely
 *
 * Not "the forecast is right to the cent on the day" — nothing can be, and a
 * test that pretended otherwise would be pinning the seed's PRNG rather than
 * the forecast. The claim is the one the read model actually makes: **the band
 * contains the truth**. A real future charge falls inside the date window
 * `[earliest, latest]` and inside the amount window `[low, high]` of a charge
 * this system projected for that payee.
 *
 * A band can be made to contain anything by being wide enough, so two
 * counter-assertions run alongside:
 *
 *   * the bands are *narrow* — the median date window is a handful of days and
 *     the amount window for a `FIXED` stream is the price, not a range; and
 *   * the projection has *reach* — a floor on how many real future charges were
 *     covered, so the suite cannot pass by projecting almost nothing.
 *
 * ## What is deliberately not asserted
 *
 * Coverage of *every* future charge. A stream with two occurrences is capped at
 * 0.70 confidence (07 §2.4), stays a `CANDIDATE`, and does not project until a
 * human says so — that is the whole design, and a test demanding the forecast
 * cover it would be demanding the auto-confirm bar be removed. Charges at
 * payees with no projecting series are counted and reported, never asserted on.
 */
import { DateOnly, Money } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forwardCashFlow, projectCharges, safeToSpend, upcomingCalendar } from '../../src/read.ts';
import { runDetection } from '../../src/service.ts';
import {
  NO_DATABASE,
  SEED_NUMBER,
  TODAY,
  USD,
  ZONE,
  clockAt,
  contextFor,
  futureCharges,
  inMemoryLedgerPort,
  recurringDatabase,
  rowsAsOf,
  seedDataset,
  type TestDatabase,
} from './harness.ts';

const HORIZON_DAYS = 30;
const HORIZON_END = DateOnly.addDays(TODAY, HORIZON_DAYS);

describe.skipIf(NO_DATABASE)('the 30-day forecast', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await recurringDatabase('forecast');
    await database.truncate();

    const dataset = seedDataset(SEED_NUMBER);
    const context = contextFor(database.userId, clockAt());
    await runDetection(
      database.db,
      context,
      { port: inMemoryLedgerPort(rowsAsOf(dataset, TODAY)) },
      { timeZone: ZONE },
    );
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it("the 30-day projection band contains the seed's known future charges", async () => {
    const dataset = seedDataset(SEED_NUMBER);
    const projected = await projectCharges(database.db, {
      userId: database.userId,
      from: TODAY,
      days: HORIZON_DAYS,
    });
    expect(projected.length, 'the window has something in it').toBeGreaterThan(5);

    const byMerchant = new Map<string, typeof projected>();
    for (const charge of projected) {
      const bucket = byMerchant.get(charge.merchantId);
      if (bucket === undefined) byMerchant.set(charge.merchantId, [charge]);
      else bucket.push(charge);
    }

    // Ground truth: what the generator will actually produce, which this
    // context has never been shown.
    const truth = futureCharges(dataset, TODAY, HORIZON_END);
    expect(truth.length, 'the seed has a future to be right about').toBeGreaterThanOrEqual(10);

    let covered = 0;
    const misses: string[] = [];
    for (const charge of truth) {
      const candidates = byMerchant.get(charge.merchantId ?? '');
      // No projecting series for this payee — an unconfirmed candidate, a
      // one-off purchase, an annual plan seen twice. Not a miss; not a claim.
      if (candidates === undefined) continue;

      const actual = Money.fromJSON(charge.amount);
      const contained = candidates.some(
        (projection) =>
          !DateOnly.isBefore(charge.postedOn, projection.earliest) &&
          !DateOnly.isAfter(charge.postedOn, projection.latest) &&
          projection.low.minor <= actual.minor &&
          actual.minor <= projection.high.minor,
      );
      if (contained) covered += 1;
      else {
        misses.push(
          `${charge.postedOn} ${Money.formatAmount(actual)} at ${charge.merchantId ?? '?'} — ` +
            `projected ${candidates
              .map(
                (projection) =>
                  `[${projection.earliest}..${projection.latest}] ` +
                  `${Money.formatAmount(projection.low)}..${Money.formatAmount(projection.high)}`,
              )
              .join(', ')}`,
        );
      }
    }

    expect(
      misses,
      'every scheduled future charge falls inside the band projected for its payee',
    ).toEqual([]);

    // Reach: a band cannot pass this suite by being empty. On this fixture the
    // forecast happens to reach *all ten* — every labelled series the generator
    // will bill in the next thirty days had a projecting series — so the floor
    // is the total rather than a fraction of it. If a future change to the
    // auto-confirm bar leaves one of them a candidate, this line is where it
    // surfaces, which is the right place for that conversation to happen.
    expect(covered, 'the forecast covered every scheduled charge in the window').toBe(truth.length);
    expect(byMerchant.size, 'across a realistic number of payees').toBeGreaterThan(5);
  });

  it('the bands are narrow enough to be worth having', async () => {
    const projected = await projectCharges(database.db, {
      userId: database.userId,
      from: TODAY,
      days: HORIZON_DAYS,
    });
    expect(projected.length).toBeGreaterThan(5);

    // A band that contains everything proves nothing. The next-due slot is the
    // one a user is shown, and 07 §2.5 sizes it from the stream's own
    // residuals: a well-behaved monthly subscription should land within a few
    // days, not within a fortnight.
    const nextDue = projected.filter((charge) => charge.slot === 0);
    expect(nextDue.length).toBeGreaterThan(0);
    const widths = nextDue.map((charge) => charge.uncertaintyDays).sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)] ?? 0;
    expect(median, 'the median next-due window is days, not weeks').toBeLessThanOrEqual(7);

    // And a FIXED stream's amount band is its price: `observed_min` and
    // `observed_max` coincide when nothing ever moved.
    const fixedPriced = projected.filter((charge) => charge.low.minor === charge.high.minor);
    expect(
      fixedPriced.length,
      'a stream whose price never moved forecasts an exact amount',
    ).toBeGreaterThan(0);
  });

  it('the calendar, the cash flow and the projection agree with each other', async () => {
    const input = { userId: database.userId, from: TODAY, days: HORIZON_DAYS };
    const projected = await projectCharges(database.db, input);
    const calendar = await upcomingCalendar(database.db, input);
    const flow = await forwardCashFlow(database.db, input);

    // One projection underneath all three, so a user cannot read one number on
    // the calendar and a different one on the cash-flow card.
    expect(calendar.chargeCount).toBe(projected.length);
    expect(flow.chargeCount).toBe(projected.length);
    expect(calendar.days.flatMap((day) => day.charges).length).toBe(projected.length);

    const expectedNet = Money.sum(
      projected.map((charge) => charge.expected),
      USD,
    );
    expect(Money.formatAmount(flow.net)).toBe(Money.formatAmount(expectedNet));

    // The band brackets the point estimate on both sides, always.
    expect(Money.compare(flow.netLow, flow.net)).toBeLessThanOrEqual(0);
    expect(Money.compare(flow.netHigh, flow.net)).toBeGreaterThanOrEqual(0);
  });

  it('safe-to-spend subtracts the worst case and never counts unarrived income', async () => {
    const availableCash = Money.of(250_000n, USD);
    const input = { userId: database.userId, from: TODAY, days: HORIZON_DAYS, availableCash };

    const safe = await safeToSpend(database.db, input);
    const flow = await forwardCashFlow(database.db, input);

    // Committed outflows are subtracted at the pessimistic end of their band.
    expect(Money.compare(safe.committedWorstCase, safe.committed)).toBeLessThanOrEqual(0);
    expect(Money.compare(safe.safe, availableCash)).toBeLessThanOrEqual(0);
    expect(Money.formatAmount(safe.safe)).toBe(
      Money.formatAmount(Money.add(availableCash, safe.committedWorstCase)),
    );

    // The seed's payroll is a biweekly inflow inside this window, so this is a
    // real exclusion and not a vacuous one.
    expect(Money.compare(flow.inflow, Money.zero(USD))).toBeGreaterThan(0);
    expect(Money.formatAmount(safe.expectedIncome)).toBe(Money.formatAmount(flow.inflow));
    expect(
      Money.compare(safe.safe, Money.add(availableCash, safe.expectedIncome)),
      'money the employer has not sent is not money to spend',
    ).toBeLessThan(0);
  });
});
