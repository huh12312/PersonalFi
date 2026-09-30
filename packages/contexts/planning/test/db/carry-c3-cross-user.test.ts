// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-3 (G4-4:
 * `docs/evidence/phase-4/gate-security-review.md` §2.2, §6).
 *
 * The gate's §2.2 sabotage matrix dropped every `user_id` predicate in
 * Planning's stores, one at a time, and ran the full route and store suites
 * against each. Eighteen of nineteen went red. Two did not:
 *
 *   - `balancesDay`'s two branches (`projection-store.ts:481`) — the
 *     newest-sealed-day read (`asOf === null`) and the specific-date read
 *     (`asOf` given) each carry their own, independent `user_id = $userId`
 *     predicate, and neither had a test that could fail if it were dropped.
 *   - `getBaseline` (`scenarios.ts:795`) — same shape: one predicate, no
 *     `ORDER BY`/`LIMIT` because the table has at most one baseline row per
 *     holder, and no test could fail if the predicate were dropped.
 *
 * "Every suite in the tree stays green" with either predicate gone (G4-4) is
 * exactly what this file exists to stop being true. Each of the three tests
 * below plants the *other* holder's row first — deliberately, since a test
 * that plants the caller's row last would still pass by accident against an
 * unscoped `ORDER BY … LIMIT 1` or an unscoped `rows[0]` (Postgres returns an
 * unordered query's rows in roughly insertion/heap order for a two-row
 * table, so "the caller answered most recently" would hide exactly the bug
 * this file is testing for). See `docs/evidence/phase-5/wp5.13-carry-overs.md`
 * §4.1 for the sabotage transcripts.
 *
 * Own scratch database (`personalfi_wp513b_c3`), per docs/TESTING.md.
 */
import { DateOnly, Money, newId, fixedClock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balancesDay } from '../../src/projection-store.ts';
import { getBaseline, profileToJson, type BaselineProfile } from '../../src/scenarios.ts';
import { NO_DATABASE } from './harness.ts';

const CLOCK = fixedClock(new Date('2026-09-29T12:00:00Z'));

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

const PROFILE: BaselineProfile = {
  birthDate: DateOnly.parse('1986-03-15'),
  retirementAge: 65,
  planEndAge: 95,
  currency: 'USD',
  glidepath: { kind: 'age_based' },
  contributionGrowth: 'wage',
  annualSpending: usd('60000'),
  withdrawalPolicy: 'guardrails',
  spendingFloor: 'essential_spend',
  taxDeferredRate: '0.15',
  socialSecurity: {
    monthlyPia: usd('2800'),
    claimAge: { years: 67, months: 0 },
    stressAfter2034: false,
  },
  pensions: [],
  contributions: null,
};

describe.skipIf(NO_DATABASE)('WP 5.13b carry C-3 — balancesDay and getBaseline, cross-user', () => {
  let database: TestDatabase;
  let alice: string;
  let bob: string;

  /**
   * Bypasses `saveBaseline` deliberately: that function itself calls
   * `getBaseline` first (to decide insert-vs-update), so using it to plant
   * fixtures would make this test's own setup depend on the very function
   * under test. A raw insert, shaped exactly like `saveBaseline`'s own
   * (`scenarios.ts:873-879`), keeps the fixture and the assertion
   * independent.
   */
  async function plantBaseline(userId: string, name: string, profile: BaselineProfile) {
    const id = newId();
    const json = JSON.stringify(profileToJson(profile));
    await database.db.execute(sql`
      INSERT INTO plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed,
                                  created_at, updated_at)
      VALUES (${id}::uuid, ${userId}::uuid, 'baseline', NULL, ${name}, ${json}::jsonb, NULL,
              '1'::numeric, ${CLOCK.now().toISOString()}::timestamptz,
              ${CLOCK.now().toISOString()}::timestamptz)
    `);
    return id;
  }

  async function plantDay(
    userId: string,
    asOfDate: string,
    revision: number,
    baseCurrency: string,
  ) {
    const id = newId();
    await database.db.execute(sql`
      INSERT INTO net_worth_daily (
        id, user_id, as_of_date, revision, base_currency,
        assets_minor, liabilities_minor, net_worth_minor,
        liquid_minor, investable_minor, on_budget_minor,
        breakdown, source, accounts_counted, accounts_unvalued, sealed_at
      ) VALUES (
        ${id}::uuid, ${userId}::uuid, ${asOfDate}::date, ${revision}, ${baseCurrency},
        0, 0, 0, 0, 0, 0, '[]'::jsonb, 'observed', 0, 0,
        ${CLOCK.now().toISOString()}::timestamptz
      )
    `);
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp513b_c3');
    alice = database.userId;
    bob = await database.createUser('Bob');

    // --- getBaseline fixtures: Bob's row planted BEFORE Alice's -----------
    await plantBaseline(bob, 'Bob baseline', PROFILE);
    await plantBaseline(alice, 'Alice baseline', PROFILE);

    // --- balancesDay(null) fixtures: Bob's day is the LATER one -----------
    // An unscoped "newest sealed day of anyone" read would return Bob's.
    await plantDay(alice, '2026-09-10', 1, 'USD');
    await plantDay(bob, '2026-09-20', 1, 'EUR');

    // --- balancesDay(asOf) fixtures: same date, Bob's row has the HIGHER --
    // revision. An unscoped "current revision of this date, of anyone" read
    // (`WHERE as_of_date = … ORDER BY revision DESC LIMIT 1`, no user_id)
    // would return Bob's revision-2 row instead of Alice's revision-1 one.
    await plantDay(alice, '2026-09-15', 1, 'USD');
    await plantDay(bob, '2026-09-15', 2, 'EUR');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  it("getBaseline returns the caller's own baseline, never the other holder's, even though Bob's row was written first", async () => {
    const aliceBaseline = await getBaseline(database.db, alice);
    expect(aliceBaseline?.name).toBe('Alice baseline');

    const bobBaseline = await getBaseline(database.db, bob);
    expect(bobBaseline?.name).toBe('Bob baseline');
  });

  it("balancesDay(userId, null) returns the caller's own newest sealed day, never a more recent day sealed for another holder", async () => {
    const aliceDay = await balancesDay(database.db, alice, null);
    expect(aliceDay?.baseCurrency).toBe('USD');
    expect(aliceDay?.asOfDate).toBe('2026-09-15'); // Alice's own newest, not Bob's 09-20

    const bobDay = await balancesDay(database.db, bob, null);
    expect(bobDay?.baseCurrency).toBe('EUR');
    expect(bobDay?.asOfDate).toBe('2026-09-20');
  });

  it("balancesDay(userId, asOf) returns the caller's own revision for that date, never another holder's higher revision of the same date", async () => {
    const aliceDay = await balancesDay(database.db, alice, DateOnly.parse('2026-09-15'));
    expect(aliceDay?.baseCurrency).toBe('USD');
    expect(aliceDay?.revision).toBe(1);

    const bobDay = await balancesDay(database.db, bob, DateOnly.parse('2026-09-15'));
    expect(bobDay?.baseCurrency).toBe('EUR');
    expect(bobDay?.revision).toBe(2);
  });
});
