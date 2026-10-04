// SPDX-License-Identifier: MIT
/**
 * `computeAndStoreHealthScore` against a real Postgres (05-phase-5-dispatch.md
 * §3 WP 5.8; migration 0033): idempotence per ISO week, and that direction of
 * travel reads backward against the previous *stored* week — not the
 * previous computation, not today's snapshot twice.
 */
import { fixedClock } from '@core/kernel';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdvisorSnapshot } from '../../src/contract/snapshot.ts';
import {
  computeAndStoreHealthScore,
  findHealthScoreByWeek,
  previousComponentScoresFor,
} from '../../src/health/store.ts';
import { EPOCH, NO_DATABASE, insightsDatabase, type TestDatabase } from './harness.ts';

const USD = 'USD';
const WEEK_1 = '2026-W38';
const WEEK_2 = '2026-W39'; // the ISO week immediately after WEEK_1

function money(minor: string) {
  return { minor, currency: USD };
}

/**
 * One computable component (`emergency_fund_months`) and nothing else — the
 * rest fall out `excluded`, which keeps this suite's fixture small; the
 * component-level arithmetic is already proven in `test/health.test.ts`.
 */
function snapshotWithMonths(months: number): AdvisorSnapshot {
  return {
    cash_summary: {
      as_of: '2026-09-19',
      total: money('1000000'),
      account_count: 1,
      blended_apy: 0.01,
      emergency_fund_months: months,
      accounts: [
        {
          account_ref: '01930000-0000-7000-8000-00000000d1a1',
          type: 'checking',
          balance: money('1000000'),
          apy: 0.01,
        },
      ],
    },
  };
}

describe.skipIf(NO_DATABASE)('computeAndStoreHealthScore', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('health');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  it('direction of travel compares against the previous stored week, and the first week says so', async () => {
    // Week 1: nothing stored before it — every direction reads `no_previous_data`.
    const first = await computeAndStoreHealthScore(database.db, {
      userId: database.userId,
      isoWeek: WEEK_1,
      snapshot: snapshotWithMonths(0), // 0 months -> below the 1-month boundary -> 'poor' (25)
      clock: fixedClock(EPOCH),
    });
    expect(first.alreadyComputed).toBe(false);
    const firstEmergency = first.components.find((c) => c.component === 'emergency_fund_months');
    expect(firstEmergency?.band).toBe('poor');
    expect(firstEmergency?.direction).toBe('no_previous_data');

    // Nothing precedes week 1 in this holder's history.
    const noPrevious = await previousComponentScoresFor(database.db, database.userId, WEEK_1);
    expect(noPrevious).toBeNull();

    // Week 2: now reads week 1 back, and the score moved from 'poor' to 'excellent'.
    const second = await computeAndStoreHealthScore(database.db, {
      userId: database.userId,
      isoWeek: WEEK_2,
      snapshot: snapshotWithMonths(8), // 8 months -> above the 6-month boundary -> 'excellent' (100)
      clock: fixedClock(EPOCH),
    });
    expect(second.alreadyComputed).toBe(false);
    const secondEmergency = second.components.find((c) => c.component === 'emergency_fund_months');
    expect(secondEmergency?.band).toBe('excellent');
    expect(secondEmergency?.direction).toBe('improved');

    const previousForWeek2 = await previousComponentScoresFor(database.db, database.userId, WEEK_2);
    expect(previousForWeek2?.get('emergency_fund_months')?.score).toBe(25);
  }, 30_000);

  it('is idempotent per (user, ISO week): a second call for the same week writes nothing new', async () => {
    const first = await computeAndStoreHealthScore(database.db, {
      userId: database.userId,
      isoWeek: WEEK_1,
      snapshot: snapshotWithMonths(4),
      clock: fixedClock(EPOCH),
    });
    expect(first.alreadyComputed).toBe(false);

    const second = await computeAndStoreHealthScore(database.db, {
      userId: database.userId,
      isoWeek: WEEK_1,
      // A different snapshot on the second call -- proves the short-circuit
      // reads the stored row rather than recomputing, the same guard
      // `publishWeeklyBrief` runs for the Brief.
      snapshot: snapshotWithMonths(10),
      clock: fixedClock(EPOCH),
    });
    expect(second.alreadyComputed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.overall).toBe(first.overall);

    const stored = await findHealthScoreByWeek(database.db, database.userId, WEEK_1);
    expect(stored?.id).toBe(first.id);
    const emergency = stored?.components.find((c) => c.component === 'emergency_fund_months');
    expect(emergency?.band).toBe('good'); // 4 months -> the first call's snapshot, not the second's
  }, 30_000);

  it('a component with no data is still excluded and named when stored and read back', async () => {
    const stored = await computeAndStoreHealthScore(database.db, {
      userId: database.userId,
      isoWeek: WEEK_1,
      snapshot: {}, // every block absent
      clock: fixedClock(EPOCH),
    });
    expect(stored.overall).toBeNull();
    expect(stored.excluded).toHaveLength(6);

    const reread = await findHealthScoreByWeek(database.db, database.userId, WEEK_1);
    expect(reread?.overall).toBeNull();
    expect(reread?.excluded).toHaveLength(6);
    expect(reread?.components).toHaveLength(0);
  }, 30_000);
});
