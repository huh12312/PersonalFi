// SPDX-License-Identifier: MIT
/**
 * WP 4.1 against Postgres: migration 0020's four tables, scoped to their
 * holder, with a **second holder's rows planted beside the first's**.
 *
 * `'every new table carries user_id and refuses another user's row'` is the
 * dispatch's exit test. It asserts three layers, because WP 3.9's S1 finding
 * is that one scoping layer can hide the absence of another:
 *
 *   1. **Structure.** `user_id` is NOT NULL and references `users` ON DELETE
 *      CASCADE on each of the four tables (D6), and each child's goal
 *      reference is the *composite* `(goal_id, user_id)` key.
 *   2. **The database refuses a mixed row.** A `goal_contributions` or
 *      `cash_earmarks` row stamped with Bob's `user_id` that points at
 *      Alice's goal is a 23503 naming `…_goal_is_the_same_users` — written as
 *      raw SQL, so no service check can be the thing that stopped it.
 *   3. **Every read and write in the store is scoped by its one predicate.**
 *      Bob's reads return only Bob's rows; Bob's writes against Alice's ids
 *      are typed refusals, and Alice's rows are **byte-identical** afterwards.
 *
 * The store (`src/goals-store.ts`) deliberately never joins, so each statement
 * carries exactly one `user_id = $caller` predicate. The evidence document
 * records each of those predicates dropped one at a time — every one turns
 * this test red — and then all of them together.
 *
 * Scratch database `personalfi_wp41_goals`, its own, per docs/TESTING.md.
 */
import { Money, fixedClock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEarmark,
  listEarmarks,
  liveEarmarksByAccount,
  releaseEarmark,
} from '../../src/earmarks.ts';
import { PlanningError } from '../../src/errors.ts';
import {
  addContribution,
  createGoal,
  deleteGoal,
  getGoal,
  listContributions,
  listGoals,
  removeContribution,
  updateGoal,
  type FundingAccountsReader,
} from '../../src/goals.ts';
import { findGoal, listContributionRows, updateGoalRow } from '../../src/goals-store.ts';
import type { PlanningAccount } from '../../src/ports.ts';
import {
  RISK_INSTRUMENT_VERSION,
  answerRiskProfile,
  currentRiskProfile,
  riskProfileAnswers,
  type BracketSchedule,
  type RiskAnswers,
} from '../../src/risk-profile.ts';
import { CORRELATION_ID, NO_DATABASE, pgFailureOf } from './harness.ts';

const TABLES = ['goals', 'goal_contributions', 'risk_profile', 'cash_earmarks'] as const;

const ALICE_CHECKING = '01920000-0000-7000-8000-0000000a1c01';
const ALICE_BROKERAGE = '01920000-0000-7000-8000-0000000a1c02';
const BOB_CHECKING = '01920000-0000-7000-8000-0000000b0b01';

function account(accountId: string, name: string): PlanningAccount {
  return {
    accountId,
    name,
    kind: 'cash',
    side: 'asset',
    currency: 'USD',
    flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
    closedAt: null,
  };
}

/** Each holder's roster is their own — the port is scoped by `userId`, as the real one is. */
function rosterFor(alice: string, bob: string): FundingAccountsReader {
  return {
    accounts: (userId) =>
      Promise.resolve(
        userId === alice
          ? [account(ALICE_CHECKING, 'Alice checking'), account(ALICE_BROKERAGE, 'Alice brokerage')]
          : userId === bob
            ? [account(BOB_CHECKING, 'Bob checking')]
            : [],
      ),
  };
}

const usd = (dollars: string): Money => Money.parseAmount(dollars, 'USD');

const US_2026_SINGLE: BracketSchedule = {
  taxYear: 2026,
  filingStatus: 'single',
  brackets: [
    { rate: '0.10', over: usd('0') },
    { rate: '0.12', over: usd('12400') },
    { rate: '0.22', over: usd('50400') },
    { rate: '0.24', over: usd('105700') },
    { rate: '0.32', over: usd('201775') },
    { rate: '0.35', over: usd('256225') },
    { rate: '0.37', over: usd('640600') },
  ],
  source: 'Rev. Proc. 2025-32 via docs/research/07-advisory-domain.md Appendix A',
  asOf: '2026-01-01',
};

const INCONSISTENT: RiskAnswers = {
  instrument: RISK_INSTRUMENT_VERSION,
  items: {
    'drawdown.stated': 'buy_more',
    'drawdown.revealed': 'sold_all',
    'volatility.stated': 'range_wide',
    'volatility.revealed': 'stocks_60_to_80',
    'risk_identity.stated': 'willing',
    'risk_identity.revealed': 'mostly_stocks',
  },
};

interface Planted {
  readonly goalId: string;
  readonly contributionId: string;
  readonly earmarkId: string;
  readonly riskProfileId: string;
}

/** Every row a holder owns across the four tables, as canonical text. */
async function dumpOwned(database: TestDatabase, userId: string): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const result = await database.db.execute<{ row: unknown }>(sql`
      SELECT row_to_json(t)::text AS row FROM ${sql.identifier(table)} AS t
       WHERE t.user_id = ${userId}::uuid ORDER BY t.id
    `);
    parts.push(`${table}:${result.rows.map((row) => String(row.row)).join('\n')}`);
  }
  return parts.join('\n---\n');
}

async function refusalOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PlanningError) return error.code;
    throw error;
  }
  throw new Error('expected a PlanningError, and the call succeeded');
}

describe.skipIf(NO_DATABASE)('WP 4.1 goals, against Postgres', () => {
  let database: TestDatabase;
  let alice: string;
  let bob: string;
  let ports: { readonly accounts: FundingAccountsReader };
  let aliceRows: Planted;
  let bobRows: Planted;

  const clock = fixedClock(new Date('2026-09-26T15:00:00Z'));
  const contextFor = (userId: string) => ({
    userId,
    clock,
    timeZone: 'America/New_York',
    correlationId: CORRELATION_ID,
  });

  async function plant(userId: string, checking: string): Promise<Planted> {
    return database.db.transaction(async (tx) => {
      const context = contextFor(userId);
      const goal = await createGoal(tx, ports, context, {
        kind: 'purchase',
        name: 'House deposit',
        target: usd('60000.00'),
        targetDate: '2028-04-01',
        priority: 1,
        fundedFromAccountIds: [checking],
      });
      const contribution = await addContribution(tx, context, goal.id, {
        cadence: 'monthly',
        amount: usd('1500.00'),
        escalationPct: '3.25',
        startsOn: '2026-10-01',
        source: 'USER',
      });
      const earmark = await createEarmark(tx, ports, context, {
        goalId: goal.id,
        accountId: checking,
        name: 'Deposit so far',
        amount: usd('6000.00'),
      });
      const { profile } = await answerRiskProfile(tx, context, {
        answers: INCONSISTENT,
        horizonYears: 22,
        liquidityNeed: 'low',
        income: { taxableIncome: usd('84000.00'), schedule: US_2026_SINGLE },
      });
      return {
        goalId: goal.id,
        contributionId: contribution.id,
        earmarkId: earmark.id,
        riskProfileId: profile.id,
      };
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp41_goals');
    alice = database.userId;
    bob = await database.createUser('Bob');
    ports = { accounts: rosterFor(alice, bob) };
    aliceRows = await plant(alice, ALICE_CHECKING);
    bobRows = await plant(bob, BOB_CHECKING);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  it("every new table carries user_id and refuses another user's row", async () => {
    // --- 1. Structure --------------------------------------------------------
    for (const table of TABLES) {
      const column = await database.db.execute<{ is_nullable: string; data_type: string }>(sql`
        SELECT is_nullable, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'user_id'
      `);
      expect(column.rows, `${table}.user_id`).toEqual([{ is_nullable: 'NO', data_type: 'uuid' }]);

      const foreignKey = await database.db.execute<{ target: string; on_delete: string }>(sql`
        SELECT confrelid::regclass::text AS target, confdeltype::text AS on_delete
          FROM pg_constraint
         WHERE conrelid = ${table}::regclass AND contype = 'f'
           AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = ${table}::regclass AND attname = 'user_id')]::int2[]
      `);
      expect(foreignKey.rows, `${table}.user_id references users`).toEqual([
        { target: 'users', on_delete: 'c' },
      ]);
    }
    for (const [table, constraint] of [
      ['goal_contributions', 'goal_contributions_goal_is_the_same_users'],
      ['cash_earmarks', 'cash_earmarks_goal_is_the_same_users'],
    ] as const) {
      const columns = await database.db.execute<{ columns: string }>(sql`
        SELECT array_to_string(ARRAY(
                 SELECT attname FROM unnest(conkey) WITH ORDINALITY AS k(attnum, position)
                   JOIN pg_attribute ON attrelid = conrelid AND pg_attribute.attnum = k.attnum
                  ORDER BY position), ',') AS columns
          FROM pg_constraint WHERE conname = ${constraint} AND conrelid = ${table}::regclass
      `);
      expect(columns.rows, constraint).toEqual([{ columns: 'goal_id,user_id' }]);
    }

    // Both holders really do have one row in every table: the assertions
    // below are cross-user claims, not queries against an empty table.
    for (const table of TABLES) {
      const counts = await database.db.execute<{ user_id: string; rows: string }>(sql`
        SELECT user_id::text, count(*)::text AS rows FROM ${sql.identifier(table)}
         GROUP BY user_id ORDER BY user_id
      `);
      expect(counts.rows.map((row) => [row.user_id, row.rows]).sort(), table).toEqual(
        [
          [alice, '1'],
          [bob, '1'],
        ].sort(),
      );
    }

    const aliceBefore = await dumpOwned(database, alice);
    const bobBefore = await dumpOwned(database, bob);

    // --- 2. The database refuses a row that is Bob's but names Alice's goal ---
    const mixedContribution = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO goal_contributions (id, user_id, goal_id, cadence, amount_minor, currency,
                                        escalation_pct, starts_on, source)
        VALUES ('01920000-0000-7000-8000-00000000f001', ${bob}::uuid, ${aliceRows.goalId}::uuid,
                'monthly', 100, 'USD', 0, '2026-10-01', 'USER')
      `),
    );
    expect(mixedContribution).toMatchObject({
      code: '23503',
      constraint: 'goal_contributions_goal_is_the_same_users',
    });
    const mixedEarmark = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO cash_earmarks (id, user_id, goal_id, account_id, name, amount_minor, currency)
        VALUES ('01920000-0000-7000-8000-00000000f002', ${bob}::uuid, ${aliceRows.goalId}::uuid,
                ${BOB_CHECKING}::uuid, 'Mine now', 100, 'USD')
      `),
    );
    expect(mixedEarmark).toMatchObject({
      code: '23503',
      constraint: 'cash_earmarks_goal_is_the_same_users',
    });

    // --- 3a. Every read returns only the caller's rows ------------------------
    expect((await listGoals(database.db, bob)).map((goal) => goal.id)).toEqual([bobRows.goalId]);
    expect((await listGoals(database.db, alice)).map((goal) => goal.id)).toEqual([
      aliceRows.goalId,
    ]);
    expect(await findGoal(database.db, bob, aliceRows.goalId)).toBeNull();
    expect(await refusalOf(getGoal(database.db, bob, aliceRows.goalId))).toBe(
      'planning.goal_not_found',
    );
    expect(await listContributionRows(database.db, bob, aliceRows.goalId)).toEqual([]);
    expect(await refusalOf(listContributions(database.db, bob, aliceRows.goalId))).toBe(
      'planning.goal_not_found',
    );
    expect(
      (await listContributions(database.db, bob, bobRows.goalId)).map((row) => row.id),
    ).toEqual([bobRows.contributionId]);
    // Both directions: whichever holder answered last owns the newest row in
    // the table, so an unscoped "newest" read is only wrong for the other one.
    expect((await currentRiskProfile(database.db, bob))?.id).toBe(bobRows.riskProfileId);
    expect((await currentRiskProfile(database.db, alice))?.id).toBe(aliceRows.riskProfileId);
    expect((await riskProfileAnswers(database.db, bob)).map((row) => row.id)).toEqual([
      bobRows.riskProfileId,
    ]);
    expect(
      (await listEarmarks(database.db, bob, { includeReleased: true })).map((row) => row.id),
    ).toEqual([bobRows.earmarkId]);
    expect([...(await liveEarmarksByAccount(database.db, bob)).keys()]).toEqual([BOB_CHECKING]);

    // --- 3b. Every write against Alice's ids is refused, typed ----------------
    const bobContext = contextFor(bob);
    const attempts: readonly [string, () => Promise<unknown>, string][] = [
      [
        'updateGoal',
        () => updateGoal(database.db, ports, bobContext, aliceRows.goalId, { name: 'Taken' }),
        'planning.goal_not_found',
      ],
      [
        'updateGoal (status)',
        () => updateGoal(database.db, ports, bobContext, aliceRows.goalId, { status: 'abandoned' }),
        'planning.goal_not_found',
      ],
      [
        'deleteGoal',
        () => deleteGoal(database.db, bob, aliceRows.goalId),
        'planning.goal_not_found',
      ],
      [
        'addContribution',
        () =>
          addContribution(database.db, bobContext, aliceRows.goalId, {
            cadence: 'monthly',
            amount: usd('1.00'),
            startsOn: '2026-10-01',
            source: 'USER',
          }),
        'planning.goal_not_found',
      ],
      [
        'removeContribution',
        () => removeContribution(database.db, bob, aliceRows.contributionId),
        'planning.contribution_not_found',
      ],
      [
        'createEarmark (Alice goal)',
        () =>
          createEarmark(database.db, ports, bobContext, {
            goalId: aliceRows.goalId,
            accountId: BOB_CHECKING,
            name: 'Taken',
            amount: usd('1.00'),
          }),
        'planning.goal_not_found',
      ],
      [
        'createEarmark (Alice account)',
        () =>
          createEarmark(database.db, ports, bobContext, {
            goalId: bobRows.goalId,
            accountId: ALICE_CHECKING,
            name: 'Taken',
            amount: usd('1.00'),
          }),
        'planning.earmark_account_not_found',
      ],
      [
        'releaseEarmark',
        () => releaseEarmark(database.db, bobContext, aliceRows.earmarkId),
        'planning.earmark_not_found',
      ],
      [
        'createGoal (Alice account)',
        () =>
          createGoal(database.db, ports, bobContext, {
            kind: 'custom',
            name: 'Funded from someone else',
            target: usd('10.00'),
            targetDate: '2027-01-01',
            fundedFromAccountIds: [ALICE_CHECKING],
          }),
        'planning.goal_funding_account_not_found',
      ],
    ];
    for (const [name, attempt, code] of attempts) {
      expect(await refusalOf(attempt()), name).toBe(code);
    }

    // The store's own guard, reached directly: the service's scoped pre-read
    // (`getGoal`) is a second layer above it, and a sabotage of either alone
    // must still be caught by *something* (§5 item 8).
    const aliceGoal = await findGoal(database.db, alice, aliceRows.goalId);
    expect(aliceGoal).not.toBeNull();
    if (aliceGoal !== null) {
      expect(
        await updateGoalRow(database.db, {
          userId: bob,
          goal: { ...aliceGoal, name: 'Taken' },
          now: clock.now(),
        }),
      ).toBeNull();
    }

    // Alice's rows are byte-identical, and so are Bob's (every refusal wrote nothing).
    expect(await dumpOwned(database, alice)).toBe(aliceBefore);
    expect(await dumpOwned(database, bob)).toBe(bobBefore);

    // --- 3c. A per-holder invariant is per holder ------------------------------
    // "One live retirement goal" is Alice's rule about Alice's goals. Her live
    // retirement goal must not stop Bob creating his — the one read in the store
    // whose scoping is an *existence* check rather than a row filter.
    const retirement = {
      kind: 'retirement' as const,
      name: 'Retirement',
      target: usd('2000000.00'),
      targetDate: '2050-01-01',
    };
    await database.db.transaction((tx) => createGoal(tx, ports, contextFor(alice), retirement));
    const bobs = await database.db.transaction((tx) =>
      createGoal(tx, ports, contextFor(bob), retirement),
    );
    expect(bobs.kind).toBe('retirement');
  });

  it('the stored risk profile carries its penalty and band, and no income', async () => {
    const row = await database.db.execute<{ row: string }>(sql`
      SELECT row_to_json(r)::text AS row FROM risk_profile AS r WHERE id = ${aliceRows.riskProfileId}::uuid
    `);
    const text = row.rows[0]?.row ?? '';
    expect(text).toContain('"tax_bracket_band":"22-32"');
    expect(text).toContain('"consistency_penalty":4');
    expect(text).toContain('"composite_score":18');
    expect(text).toContain('"unpenalised_score":22');
    expect(text).toContain('"tolerance":"moderate"');
    expect(text).not.toContain('8400000');
    expect(text).not.toContain('84000');

    // The CHECKs that keep a figure out, observed by name.
    const bandAsFigure = await pgFailureOf(
      database.db.execute(sql`
        UPDATE risk_profile SET tax_bracket_band = '84000' WHERE id = ${aliceRows.riskProfileId}::uuid
      `),
    );
    expect(bandAsFigure).toMatchObject({
      code: '23514',
      constraint: 'risk_profile_tax_bracket_band_check',
    });
    const figureInAnswers = await pgFailureOf(
      database.db.execute(sql`
        UPDATE risk_profile
           SET answers = jsonb_set(answers, '{items,drawdown.stated}', '"84000"')
         WHERE id = ${aliceRows.riskProfileId}::uuid
      `),
    );
    expect(figureInAnswers).toMatchObject({
      code: '23514',
      constraint: 'risk_profile_answers_are_well_formed',
    });
    const extraKey = await pgFailureOf(
      database.db.execute(sql`
        UPDATE risk_profile SET answers = answers || '{"income": "x"}'::jsonb
         WHERE id = ${aliceRows.riskProfileId}::uuid
      `),
    );
    expect(extraKey).toMatchObject({
      code: '23514',
      constraint: 'risk_profile_answers_are_well_formed',
    });
    const penaltyLies = await pgFailureOf(
      database.db.execute(sql`
        UPDATE risk_profile SET consistency_penalty = 0 WHERE id = ${aliceRows.riskProfileId}::uuid
      `),
    );
    expect(penaltyLies).toMatchObject({
      code: '23514',
      constraint: 'risk_profile_penalty_is_the_difference',
    });
  });

  it('a goal, its plan and its event are written together, and the escalation reads back as a string', async () => {
    const contributions = await listContributions(database.db, alice, aliceRows.goalId);
    expect(contributions).toHaveLength(1);
    // NUMERIC(7,4) returns '3.2500'; the store canonicalises and never Number()s it.
    expect(contributions[0]?.escalationPct).toBe('3.25');
    expect(contributions[0]?.amount).toEqual(usd('1500.00'));

    const events = await database.db.execute<{ event_type: string; payload: unknown }>(sql`
      SELECT event_type, payload FROM domain_events
       WHERE user_id = ${alice}::uuid
         AND aggregate_id IN (${aliceRows.goalId}::uuid, ${aliceRows.riskProfileId}::uuid)
       ORDER BY seq
    `);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'planning.GoalCreated',
      'planning.RiskProfileAnswered',
    ]);
    const goalCreated = JSON.stringify(events.rows[0]?.payload);
    expect(goalCreated).toContain(aliceRows.goalId);
    expect(goalCreated).not.toContain('6000000'); // no target amount
    expect(goalCreated).not.toContain('House deposit'); // no name
    expect(JSON.stringify(events.rows[1]?.payload)).not.toContain('22-32'); // no band

    // A second live retirement goal is refused by the service, and by the
    // partial unique index if the service check is bypassed.
    const context = contextFor(alice);
    const retirement = {
      kind: 'retirement' as const,
      name: 'Retirement',
      target: usd('2000000.00'),
      targetDate: '2050-01-01',
    };
    // Alice's first live retirement goal was created in the cross-user test.
    expect(
      await refusalOf(database.db.transaction((tx) => createGoal(tx, ports, context, retirement))),
    ).toBe('planning.goal_retirement_already_live');
    const bypass = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO goals (id, user_id, kind, name, target_minor, currency, target_date)
        VALUES ('01920000-0000-7000-8000-00000000f003', ${alice}::uuid, 'retirement', 'Second',
                100, 'USD', '2051-01-01')
      `),
    );
    expect(bypass).toMatchObject({ code: '23505', constraint: 'goals_one_live_retirement_idx' });
  });
});
