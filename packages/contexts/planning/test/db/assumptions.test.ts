// SPDX-License-Identifier: MIT
/**
 * WP 4.2 — `plan_assumptions` (migration 0021) against a real Postgres.
 *
 * Own scratch database (`personalfi_wp42_assumptions`), per docs/TESTING.md.
 */
import { fixedClock, newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  UnknownAssumptionsVersion,
  assumptionsVersion,
  isAssumptionsRefusal,
  loadOverrides,
  resolveForUser,
  saveOverrides,
} from '../../src/assumptions.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';

const RETIRED_VERSION = `sha256:${'0'.repeat(64)}`;
const US_EQUITY = 'capitalMarket.usEquity.expectedReturn';
const INTL_EQUITY = 'capitalMarket.intlDevelopedEquity.expectedReturn';
const ZONE = 'America/New_York';

function sqlStateOf(error: unknown): { code?: string; constraint?: string } {
  let cursor: unknown = error;
  while (cursor !== null && typeof cursor === 'object') {
    const candidate = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
    cursor = candidate.cause;
  }
  return {};
}

describe.skipIf(NO_DATABASE)('plan_assumptions (0021)', () => {
  let database: TestDatabase;
  let otherUser: string;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp42_assumptions');
    otherUser = await database.createUser('Other Holder');
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate(['plan_assumptions', 'domain_events']);
  });

  it('a stored override resolves against its named file version, and an unknown version refuses', async () => {
    const clock = fixedClock('2026-09-26T14:00:00Z');
    const stored = await database.db.transaction((tx) =>
      saveOverrides(tx, {
        userId: database.userId,
        // One genuine change; one restatement of the default, which must not be stored.
        desired: { [US_EQUITY]: '0.0550', [INTL_EQUITY]: '0.07' },
        clock,
        correlationId: CORRELATION_ID,
      }),
    );
    expect(stored.assumptionsVersion).toBe(assumptionsVersion());
    expect(stored.deltas).toEqual({ [US_EQUITY]: '0.055' });

    // What is actually in the column: one key, a JSON string, against the current version.
    const raw = await database.db.execute<{
      assumptions_version: string;
      deltas: unknown;
      value_type: string;
      keys: string;
    }>(sql`
      SELECT assumptions_version, deltas,
             jsonb_typeof(deltas -> ${US_EQUITY}) AS value_type,
             (SELECT count(*) FROM jsonb_object_keys(deltas))::text AS keys
        FROM plan_assumptions WHERE user_id = ${database.userId}::uuid
    `);
    expect(raw.rows).toEqual([
      {
        assumptions_version: assumptionsVersion(),
        deltas: { [US_EQUITY]: '0.055' },
        value_type: 'string',
        keys: '1',
      },
    ]);

    // The event, in the same transaction, naming paths and never values.
    const events = await database.db.execute<{
      event_type: string;
      payload: unknown;
      aggregate_id: string;
    }>(sql`
      SELECT event_type, payload, aggregate_id::text FROM domain_events
       WHERE user_id = ${database.userId}::uuid ORDER BY seq
    `);
    expect(events.rows).toEqual([
      {
        event_type: 'planning.AssumptionsOverridden',
        aggregate_id: stored.id,
        payload: {
          assumptionsVersion: assumptionsVersion(),
          overriddenPaths: [US_EQUITY],
          overrideCount: 1,
        },
      },
    ]);

    // Resolves against its named version: the override applies, the default beside it does not move.
    const resolved = await resolveForUser(database.db, { userId: database.userId, timeZone: ZONE });
    expect(resolved.version).toBe(assumptionsVersion());
    expect(resolved.file.capitalMarket.usEquity.expectedReturn.value).toBe('0.055');
    expect(resolved.file.capitalMarket.usEquity.expectedReturn.asOf).toBe('2026-09-26');
    expect(resolved.file.capitalMarket.usEquity.expectedReturn.source).toMatch(
      /^Your override \(the default is 0\.065:/,
    );
    expect(resolved.file.capitalMarket.intlDevelopedEquity.expectedReturn.value).toBe('0.07');
    expect(
      resolved.overrides.map((override) => [override.path, override.value, override.default.value]),
    ).toEqual([[US_EQUITY, '0.055', '0.065']]);

    // Another holder sees none of it.
    expect(await loadOverrides(database.db, otherUser)).toBeNull();
    const theirs = await resolveForUser(database.db, { userId: otherUser, timeZone: ZONE });
    expect(theirs.overrides).toEqual([]);
    expect(theirs.file.capitalMarket.usEquity.expectedReturn.value).toBe('0.065');

    // A second save replaces rather than appends: one row per user.
    await database.db.transaction((tx) =>
      saveOverrides(tx, {
        userId: database.userId,
        desired: {},
        clock,
        correlationId: CORRELATION_ID,
      }),
    );
    const count = await database.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM plan_assumptions WHERE user_id = ${database.userId}::uuid
    `);
    expect(count.rows[0]?.n).toBe('1');
    expect((await loadOverrides(database.db, database.userId))?.deltas).toEqual({});
    await database.db.transaction((tx) =>
      saveOverrides(tx, {
        userId: database.userId,
        desired: { [US_EQUITY]: '0.055' },
        clock,
        correlationId: CORRELATION_ID,
      }),
    );

    // The file it was computed against is retired: the delta refuses, and is never
    // silently re-applied to today's file or dropped in favour of today's defaults.
    await database.db.execute(sql`
      UPDATE plan_assumptions SET assumptions_version = ${RETIRED_VERSION}
       WHERE user_id = ${database.userId}::uuid
    `);
    let refusal: unknown;
    try {
      await resolveForUser(database.db, { userId: database.userId, timeZone: ZONE });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnknownAssumptionsVersion);
    expect(isAssumptionsRefusal(refusal)).toBe(true);
    expect((refusal as UnknownAssumptionsVersion).requested).toBe(RETIRED_VERSION);
    expect((refusal as UnknownAssumptionsVersion).known).toEqual([assumptionsVersion()]);
  });

  it('the database refuses a copy of the defaults, a JSON number and a version that is not a content hash', async () => {
    const insert = (version: string, deltas: string) =>
      database.db.execute(sql`
        INSERT INTO plan_assumptions (id, user_id, assumptions_version, deltas)
        VALUES (${newId()}::uuid, ${database.userId}::uuid, ${version}, ${deltas}::jsonb)
      `);
    const refusedBy = async (attempt: Promise<unknown>): Promise<string | undefined> => {
      try {
        await attempt;
      } catch (error) {
        const state = sqlStateOf(error);
        expect(state.code).toBe('23514');
        return state.constraint;
      }
      throw new Error('expected the insert to be refused');
    };

    const copy = JSON.stringify({
      capitalMarket: {
        usEquity: {
          expectedReturn: { kind: 'rate', value: '0.065', source: 's', asOf: '2025-12-31' },
        },
      },
    });
    expect(await refusedBy(insert(assumptionsVersion(), copy))).toBe(
      'plan_assumptions_deltas_are_a_delta',
    );
    expect(
      await refusedBy(insert(assumptionsVersion(), JSON.stringify({ [US_EQUITY]: 0.055 }))),
    ).toBe('plan_assumptions_deltas_are_a_delta');
    expect(
      await refusedBy(insert(assumptionsVersion(), JSON.stringify([US_EQUITY, '0.055']))),
    ).toBe('plan_assumptions_deltas_are_a_delta');
    expect(await refusedBy(insert('2026.1', '{}'))).toBe(
      'plan_assumptions_version_is_a_content_hash',
    );

    // The well-formed shape is accepted, which is what makes the refusals above mean something.
    await insert(assumptionsVersion(), JSON.stringify({ [US_EQUITY]: '0.055' }));
  });
});
