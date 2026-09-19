// SPDX-License-Identifier: MIT
/**
 * The period grid across a DST boundary, and across a grid that does not tile
 * months.
 *
 * Phase 2's exit criterion (dispatch §1) is "a month closes and rolls over
 * correctly across a timezone and DST boundary". The way this package passes it
 * is by making it impossible to fail rather than by handling it: a period
 * boundary is a **calendar date in the user's zone**, held in a `DATE` column,
 * and every function in `src/periods.ts` is integer arithmetic on `DateOnly`.
 * No value anywhere in the grid is an instant, so a 23- or 25-hour day cannot
 * reach it.
 *
 * That claim is only worth something if a test would notice it being false, so
 * the assertions below are chosen to be the ones that break under an
 * instant-based implementation:
 *
 *   * **March 2026 is 31 days long.** In `America/New_York` the wall-clock span
 *     from 2026-03-01T00:00 to 2026-04-01T00:00 is 31 days *minus one hour*,
 *     because 2026-03-08 is 23 hours long. Anyone computing the length as
 *     `(endInstant − startInstant) / 86_400_000` gets 30.958 and, floored, 30.
 *     `DateOnly.differenceInDays` gets 31 because it subtracts epoch *days*.
 *   * **The spring-forward date lands in the period that contains it**, and the
 *     boundary sits on the 1st rather than on "the last day of March", which is
 *     what makes a 28-, 29-, 30- and 31-day month the same kind of object.
 *   * **A period may begin on the transition day itself.** 2026-11-01 is 25
 *     hours long in `America/New_York` *and* is the start of the November
 *     period — the case where "the clock changed" and "the period rolled" are
 *     the same moment.
 *
 * The second test is the harder one and the reason 07 §1.7 exists. A biweekly
 * grid anchored to a payday is 26 periods a year, it produces two
 * "3-paycheque months", and its periods straddle month ends — so "the month
 * rolled" and "the period rolled" become different events. The period chosen
 * below, `[2026-02-27, 2026-03-13)`, is deliberately the one that contains
 * *both* a month boundary and the spring-forward date.
 */
import { DateOnly, Money } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLines, budgetPeriods, rollovers } from '../../schema/index.ts';
import { contains, generatePeriods, periodContaining } from '../../src/periods.ts';
import { assign, rollPeriod } from '../../src/service.ts';
import { eq } from 'drizzle-orm';
import {
  NO_DATABASE,
  ZONE,
  budgetingDatabase,
  openWithLines,
  post,
  scenario,
  settle,
  usd,
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;

/** 2026's transitions in `America/New_York`: 23 hours long, and 25. */
const SPRING_FORWARD = d('2026-03-08');
const FALL_BACK = d('2026-11-01');

describe.skipIf(NO_DATABASE)('period roll across a DST boundary', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await budgetingDatabase('dst');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('a month closes and rolls over across a DST boundary in the user zone', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 400_000n, cardMinor: 0n });
    const { groceries, rent } = state.categories;

    // --- the grid, before any database is involved ------------------------
    //
    // `America/New_York` throughout: the harness's default zone is the DST zone
    // on purpose, so every suite in the package exercises this and not only the
    // one named after it.
    expect(state.budget.timezone).toBe(ZONE);

    const march = periodContaining(
      {
        kind: 'CALENDAR_MONTH',
        timezone: ZONE,
        anchorDate: null,
        lengthDays: null,
        semimonthlySecondDay: 16,
      },
      SPRING_FORWARD,
    );
    expect(march.startDate).toBe('2026-03-01');
    // Exclusive, and the 1st of the next month rather than the 31st of this one.
    expect(march.endDate).toBe('2026-04-01');
    expect(contains(march, SPRING_FORWARD)).toBe(true);

    // The assertion an instant-based grid fails: 31, not 30. The wall-clock span
    // is one hour short of 31 days because 2026-03-08 is 23 hours long.
    expect(DateOnly.differenceInDays(march.startDate, march.endDate)).toBe(31);

    // --- the real roll ----------------------------------------------------
    const marchPeriod = await openWithLines(state, SPRING_FORWARD, [
      { categoryId: rent, priority: 5 },
      { categoryId: groceries, priority: 10 },
    ]);
    expect(marchPeriod.startDate).toBe('2026-03-01');
    expect(marchPeriod.endDate).toBe('2026-04-01');

    const lineOf = async (periodId: string, categoryId: string) => {
      const rows = await database.db
        .select()
        .from(budgetLines)
        .where(eq(budgetLines.budgetPeriodId, periodId));
      const row = rows.find((candidate) => candidate.categoryId === categoryId);
      if (row === undefined) throw new Error(`no line for ${categoryId} in ${periodId}`);
      return row;
    };

    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: marchPeriod.id,
      lineId: (await lineOf(marchPeriod.id, groceries)).id,
      assigned: usd(50_000n),
    });
    await settle(state, d('2026-03-01'));

    // Spend on the short day itself — the one a naive "add 24 hours" grid would
    // put in the wrong period.
    post(state, {
      accountId: state.checking,
      date: SPRING_FORWARD,
      minor: -12_000n,
      categoryId: groceries,
    });
    await settle(state, SPRING_FORWARD);

    const beforeRoll = await lineOf(marchPeriod.id, groceries);
    // 500 assigned − 120 spent = 380 available, carried by the ROLLOVER policy.
    expect(beforeRoll.availableMinor).toBe(38_000n);

    const rolled = await rollPeriod(
      database.db,
      state.context,
      { port: state.ledger.port },
      {
        budgetId: state.budget.id,
        periodId: marchPeriod.id,
      },
    );

    const april = await database.db
      .select()
      .from(budgetPeriods)
      .where(eq(budgetPeriods.id, rolled.toPeriodId));
    expect(april[0]?.startDate).toBe('2026-04-01');
    expect(april[0]?.endDate).toBe('2026-05-01');
    expect(april[0]?.sequence).toBe(marchPeriod.sequence + 1);

    // March is closed, and the money crossed the boundary intact.
    const marchAfter = await database.db
      .select()
      .from(budgetPeriods)
      .where(eq(budgetPeriods.id, marchPeriod.id));
    expect(marchAfter[0]?.status).toBe('closed');

    const aprilGroceries = await lineOf(rolled.toPeriodId, groceries);
    expect(aprilGroceries.carryoverMinor).toBe(38_000n);

    // Conservation over the rows the roll actually wrote: nothing was lost at
    // the boundary, which is the half of "rolls over correctly" that a bounds
    // assertion alone does not reach.
    const audit = await database.db
      .select()
      .from(rollovers)
      .where(eq(rollovers.fromPeriodId, marchPeriod.id));
    expect(audit.length).toBe(rolled.lineCount);
    const out = audit.reduce((total, row) => total + row.rolloverOutMinor, 0n);
    const inward = audit.reduce((total, row) => total + row.rolloverInMinor, 0n);
    const available = audit.reduce((total, row) => total + row.availableMinor, 0n);
    const absorbed = audit.reduce((total, row) => total + row.absorbedByRtaMinor, 0n);
    expect(inward).toBe(out);
    expect(out + absorbed).toBe(available);

    // --- the other transition: a period that *begins* on the 25-hour day ---
    const novemberGrid = generatePeriods(
      {
        kind: 'CALENDAR_MONTH',
        timezone: ZONE,
        anchorDate: null,
        lengthDays: null,
        semimonthlySecondDay: 16,
      },
      d('2026-10-15'),
      3,
    );
    expect(novemberGrid.map((bounds) => bounds.startDate)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
    // The fall-back date is the first date of the November period, not the last
    // of October — the boundary and the transition are the same day.
    expect(contains(novemberGrid[1] ?? novemberGrid[0]!, FALL_BACK)).toBe(true);
    expect(contains(novemberGrid[0]!, FALL_BACK)).toBe(false);
  }, 180_000);

  it('…across a non-calendar biweekly grid that does not tile months', async () => {
    await database.truncate();
    const state = await scenario(database, {
      checkingMinor: 400_000n,
      cardMinor: 0n,
      // A real payday. 07 §1.7: "biweekly anchored to an actual payday means 26
      // periods/yr and two '3-paycheck months'".
      budget: { periodKind: 'BIWEEKLY', periodAnchorDate: d('2026-01-02') },
    });
    const { groceries } = state.categories;

    const grid = {
      kind: 'BIWEEKLY' as const,
      timezone: ZONE,
      anchorDate: d('2026-01-02'),
      lengthDays: null,
      semimonthlySecondDay: 16,
    };

    // --- the grid does not tile months ------------------------------------
    const first13 = generatePeriods(grid, d('2026-01-02'), 13);
    for (const bounds of first13) {
      expect(DateOnly.differenceInDays(bounds.startDate, bounds.endDate)).toBe(14);
    }
    // Contiguous and half-open: each period starts exactly where the last ended,
    // with no gap and no overlap.
    for (let index = 1; index < first13.length; index += 1) {
      expect(first13[index]!.startDate).toBe(first13[index - 1]!.endDate);
    }
    // 26 periods a year is the whole point: 26 × 14 = 364, so the grid drifts
    // against the calendar by a day a year and never realigns with month ends.
    const year = generatePeriods(grid, d('2026-01-02'), 27);
    expect(DateOnly.differenceInDays(year[0]!.startDate, year[26]!.startDate)).toBe(364);

    // The period containing the spring-forward date straddles a month boundary —
    // both events inside one period, which is the case 07 §1.7 warns about.
    const straddling = periodContaining(grid, SPRING_FORWARD);
    expect(straddling.startDate).toBe('2026-02-27');
    expect(straddling.endDate).toBe('2026-03-13');
    expect(DateOnly.month(straddling.startDate)).not.toBe(DateOnly.month(SPRING_FORWARD));
    expect(DateOnly.differenceInDays(straddling.startDate, straddling.endDate)).toBe(14);

    // --- the real roll, on the straddling period ---------------------------
    const period = await openWithLines(state, SPRING_FORWARD, [
      { categoryId: groceries, priority: 10 },
    ]);
    expect(period.startDate).toBe('2026-02-27');
    expect(period.endDate).toBe('2026-03-13');
    expect(period.kind).toBe('BIWEEKLY');

    const lineIn = async (periodId: string) => {
      const rows = await database.db
        .select()
        .from(budgetLines)
        .where(eq(budgetLines.budgetPeriodId, periodId));
      const row = rows.find((candidate) => candidate.categoryId === groceries);
      if (row === undefined) throw new Error(`no groceries line in ${periodId}`);
      return row;
    };

    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: (await lineIn(period.id)).id,
      assigned: usd(30_000n),
    });
    await settle(state, period.startDate as ReturnType<typeof d>);

    // One spend in February and one in March, both inside the same period.
    post(state, {
      accountId: state.checking,
      date: d('2026-02-28'),
      minor: -5_000n,
      categoryId: groceries,
    });
    post(state, {
      accountId: state.checking,
      date: SPRING_FORWARD,
      minor: -4_000n,
      categoryId: groceries,
    });
    await settle(state, d('2026-02-28'));

    const before = await lineIn(period.id);
    // Both spends land in this period even though they are in different months.
    expect(before.availableMinor).toBe(30_000n - 5_000n - 4_000n);

    const rolled = await rollPeriod(
      database.db,
      state.context,
      { port: state.ledger.port },
      {
        budgetId: state.budget.id,
        periodId: period.id,
      },
    );

    const next = await database.db
      .select()
      .from(budgetPeriods)
      .where(eq(budgetPeriods.id, rolled.toPeriodId));
    // The next period is the next 14-day block, not the 1st of a month.
    expect(next[0]?.startDate).toBe('2026-03-13');
    expect(next[0]?.endDate).toBe('2026-03-27');
    expect(next[0]?.kind).toBe('BIWEEKLY');

    expect((await lineIn(rolled.toPeriodId)).carryoverMinor).toBe(21_000n);
    expect(Money.formatAmount(rolled.rolledOut)).toBe('210.00');

    // A transaction dated between the two periods' shared boundary belongs to
    // the later one: `[start, end)` is half-open, so 03-13 is in the new period
    // and not in the closed one.
    expect(
      contains(
        {
          startDate: period.startDate as ReturnType<typeof d>,
          endDate: period.endDate as ReturnType<typeof d>,
        },
        d('2026-03-13'),
      ),
    ).toBe(false);
    expect(
      contains(
        {
          startDate: next[0]!.startDate as ReturnType<typeof d>,
          endDate: next[0]!.endDate as ReturnType<typeof d>,
        },
        d('2026-03-13'),
      ),
    ).toBe(true);
  }, 180_000);
});
