// SPDX-License-Identifier: MIT
/**
 * *'the raw column contains no plaintext API key'* — WP 3.4's exit test, and
 * the rest of migration `0015_market_data.sql`'s structural claims.
 *
 * ## What the exit test is actually about
 *
 * `test/log-hygiene.test.ts` already proves the unit-level version: a FRED
 * error body that echoes our own query string comes back out of the adapter
 * redacted. This file makes the same claim about **Postgres**, which is where
 * it matters, because a key that reaches a column stays there after the process
 * that logged it has gone. Phase 1's `wp1.3b` custody work set the shape — read
 * the raw column back and assert against the plaintext — and the market-data
 * surface is wider, since FRED takes `api_key` as a *query parameter* (it has
 * no header form) and providers echo query strings back in error bodies.
 *
 * Two things make this a real proof rather than a ritual:
 *
 *   * The read is **raw SQL over every text column `information_schema` knows
 *     about**, not a typed `select` of `error_message`. A typed select asserts
 *     about the column somebody already suspected; the sweep survives a future
 *     column being added by a hand that never read this file. The migration's
 *     header makes exactly that promise ("can assert against *every* text
 *     column of `market_data_runs`").
 *   * The run is driven through the **real** FRED adapter, the real
 *     `ProviderClient`, the real egress guard and `createPriceRefreshJob`, with
 *     only the socket faked. A fake `PriceSource` would have no redactor in it
 *     to get wrong.
 *
 * The sabotage that follows is the negative control. Without it, this file
 * would pass just as happily against a system that wrote no row at all — which
 * is the failure mode a custody test is most likely to have and least likely to
 * notice. So the sabotage writes the unredacted body through the same INSERT
 * and asserts the sweep goes red.
 *
 * ## The rest of the file
 *
 * The other tests are the migration's CHECK constraints, each asserting on the
 * **constraint's name** rather than on "it threw": a 23514 with no name would
 * pass while the wrong rule fired. They cover 07 §6.1 (`last_known` is a
 * read-time label, never a stored observation; the ladder's pinned rungs), D4
 * and 08 §6.6 (the only 1.0 is the identity `FxReader` returns without a row),
 * and D3 (a close is a decimal string out of `NUMERIC(20,10)`, never a float).
 */
import { fixedClock, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeTransport, jsonResponse } from '../../src/adapters/fake.ts';
import { createFredSource } from '../../src/adapters/fred.ts';
import { policyFor } from '../../src/egress.ts';
import { createProviderClient } from '../../src/http.ts';
import {
  createPriceRefreshJob,
  inMemoryMarketDataWriter,
  type MarketDataRun,
  type MarketDataRunRecorder,
} from '../../src/market-data.ts';
import { apiKeyOf } from '../../src/secrets.ts';
import {
  CORRELATION_ID,
  EPOCH,
  NO_DATABASE,
  countRows,
  integrationsDatabase,
  outboxOf,
  pgFailureOf,
  type TestDatabase,
} from './harness.ts';

/** Long enough to be a real FRED key, distinctive enough to grep a database for. */
const SECRET = 'fredkey_9f3c1d7e42ab88c05e6a1b2d3f4e5a6b'; // gitleaks:allow — synthetic fixture; the test asserts it never appears in a log line / raw column

/**
 * The error body FRED would send back. It contains our key because FRED's
 * 400 for a bad parameter names the parameter's value — which is the realistic
 * path a credential takes into `market_data_runs.error_message`.
 */
const ECHOING_BODY = {
  error_code: 400,
  error_message:
    'Bad Request. Variable api_key is not a 32 character alpha-numeric lower-case ' +
    `string: ${SECRET}`,
};

const CLOCK = fixedClock(EPOCH);
const AS_OF = '2026-09-21';
/** The guard resolves; the transport never dials. One address, classified public. */
const PUBLIC = (): Promise<string[]> => Promise.resolve(['93.184.216.34']);

/**
 * The recorder the composition root will adapt: one INSERT per run row.
 *
 * Written here rather than imported because `src/market-data.ts` deliberately
 * ships only the in-memory one — the job takes a `MarketDataRunRecorder` port
 * precisely so that this suite can hand it a real table without the job knowing
 * a database exists.
 */
function drizzleRunRecorder(database: TestDatabase): MarketDataRunRecorder {
  return {
    async record(run: MarketDataRun): Promise<void> {
      await database.db.execute(sql`
        INSERT INTO market_data_runs (
          id, user_id, provider, operation, started_at, finished_at, outcome,
          requests_made, units_spent, symbols_asked, rows_written,
          refusal_code, error_message, retry_after_ms
        ) VALUES (
          ${newId()}::uuid, ${run.userId}::uuid, ${run.provider}, ${run.operation},
          ${run.startedAt.toISOString()}::timestamptz,
          ${run.finishedAt.toISOString()}::timestamptz,
          ${run.outcome}, ${run.requestsMade}, ${run.unitsSpent}, ${run.symbolsAsked},
          ${run.rowsWritten}, ${run.refusalCode}, ${run.errorMessage}, ${run.retryAfterMs}
        )
      `);
    },
  };
}

/**
 * Every text-ish column of a table, asked of the database rather than listed.
 *
 * `information_schema` is the point: a column added next year is swept without
 * anybody remembering to add it here, which is the difference between a custody
 * test and a custody anecdote.
 */
async function textColumnsOf(database: TestDatabase, table: string): Promise<readonly string[]> {
  const result = await database.db.execute<{ column_name: string }>(sql`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ${table}
       AND data_type IN ('text', 'character varying', 'character')
     ORDER BY ordinal_position
  `);
  return result.rows.map((row) => row.column_name);
}

/**
 * Every value of every text column, read back through raw SQL.
 *
 * Not through drizzle's typed select: a typed select can only return the
 * columns the *schema file* declares, so a column present in the database and
 * absent from `schema/market-data.ts` — the exact shape of an accident — would
 * never be looked at.
 */
async function sweepTextValues(
  database: TestDatabase,
  table: string,
): Promise<readonly { readonly column: string; readonly value: string }[]> {
  const columns = await textColumnsOf(database, table);
  if (columns.length === 0)
    throw new Error(`${table}: information_schema reported no text columns`);
  const projection = columns.map((column) => `"${column}"::text AS "${column}"`).join(', ');
  const result = await database.db.execute<Record<string, string | null>>(
    sql.raw(`SELECT ${projection} FROM ${table}`),
  );
  return result.rows.flatMap((row) =>
    columns.flatMap((column) => {
      const value = row[column];
      return value === null || value === undefined ? [] : [{ column, value }];
    }),
  );
}

describe.skipIf(NO_DATABASE)('market_data_runs custody', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await integrationsDatabase('custody');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await database.truncate();
  });

  it('the raw column contains no plaintext API key', async () => {
    const key = apiKeyOf('fred', SECRET);
    // Only the socket is faked. The guard, the allow-list, the budget, the
    // decimal parser and the adapter's own mapping are all the real code.
    const transport = createFakeTransport(() => jsonResponse(ECHOING_BODY, 400));

    const fred = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: transport.transport,
        resolve: PUBLIC,
        keys: [key],
      }),
      key,
      now: () => CLOCK.now(),
    });

    const job = createPriceRefreshJob({
      userId: database.userId,
      sources: [fred],
      writer: inMemoryMarketDataWriter(),
      recorder: drizzleRunRecorder(database),
      outbox: outboxOf(database.db),
      correlationId: CORRELATION_ID,
      clock: CLOCK,
      keys: [key],
    });

    const result = await job.run({
      asOfDate: AS_OF,
      securities: [],
      fxPairs: [{ base: 'EUR', quote: 'USD' }],
    });

    // The preconditions. Without these the claim below is vacuous: the key has
    // to have been on the wire, and the run has to have failed, or there is
    // nothing for a leak to have leaked *into*.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.destination.path).toContain(SECRET);
    expect(result.unavailable).toEqual([{ provider: 'fred', reason: 'error' }]);
    expect(await countRows(database, 'market_data_runs')).toBe(1);

    // The row carried the failure rather than being an empty shell — which is
    // the way this test would otherwise pass for the wrong reason.
    const stored = await database.db.execute<{
      outcome: string;
      error_message: string | null;
      requests_made: number;
    }>(sql`SELECT outcome, error_message, requests_made FROM market_data_runs`);
    const row = stored.rows[0];
    expect(row?.outcome).toBe('failed');
    expect(row?.requests_made).toBe(1);
    expect(row?.error_message).not.toBeNull();
    expect(row?.error_message).toContain('[redacted]');
    expect(row?.error_message).toContain('HTTP 400');

    // The claim. Every text column the database admits to having, swept.
    const columns = await textColumnsOf(database, 'market_data_runs');
    expect(columns).toEqual(
      expect.arrayContaining(['provider', 'operation', 'outcome', 'refusal_code', 'error_message']),
    );
    const swept = await sweepTextValues(database, 'market_data_runs');
    expect(swept.length).toBeGreaterThan(0);
    for (const { column, value } of swept) {
      // The column name is in the message so a failure says *where*, not just
      // "somewhere in this table".
      expect(`${column}=${value}`).not.toContain(SECRET);
    }
  });

  it('SABOTAGE: the unredacted provider body would be found by that sweep', async () => {
    // The negative control for the test above. `redactSecrets` is applied in
    // `http.ts` and again in `market-data.ts`'s `unavailabilityOf`; the way
    // both are lost at once is a client built without its `keys` (an optional
    // field — see `log-hygiene.test.ts`'s sabotage). This is what the row would
    // look like afterwards.
    await database.db.execute(sql`
      INSERT INTO market_data_runs (
        id, user_id, provider, operation, started_at, finished_at, outcome,
        requests_made, units_spent, symbols_asked, rows_written, error_message
      ) VALUES (
        ${newId()}::uuid, ${database.userId}::uuid, 'fred', 'fx_refresh',
        ${EPOCH}::timestamptz, ${EPOCH}::timestamptz, 'failed',
        1, 1, 1, 0, ${`HTTP 400: ${ECHOING_BODY.error_message}`}
      )
    `);

    const swept = await sweepTextValues(database, 'market_data_runs');
    const leaked = swept.filter((entry) => entry.value.includes(SECRET));
    // Red, and specifically red in `error_message`. A sweep that found the key
    // in some *other* column would mean this control is not testing the thing
    // the exit test asserts.
    expect(leaked.map((entry) => entry.column)).toEqual(['error_message']);
  });

  it('a refused run records its refusal code', async () => {
    // 08 §6.6's sibling claim for egress: `refused` is the guard saying no, and
    // it is deliberately not folded into `failed` because only one of the two
    // is a security event. A refusal with no code would be an alert nobody can
    // act on, so the schema refuses to store one.
    expect(
      await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO market_data_runs (
            id, user_id, provider, operation, started_at, outcome, refusal_code
          ) VALUES (
            ${newId()}::uuid, ${database.userId}::uuid, 'fred', 'fx_refresh',
            ${EPOCH}::timestamptz, 'refused', NULL
          )
        `),
      ),
    ).toEqual({ code: '23514', constraint: 'market_data_runs_refused_names_its_code' });

    // And the row the guard actually produces round-trips. `private_address` is
    // `@core/platform`'s `RefusalCode` for the case §5 of the dispatch names:
    // an unattended 03:45 job reaching `db:5432`.
    const id = newId();
    await database.db.execute(sql`
      INSERT INTO market_data_runs (
        id, user_id, provider, operation, started_at, finished_at, outcome,
        requests_made, refusal_code, error_message
      ) VALUES (
        ${id}::uuid, ${database.userId}::uuid, 'fred', 'fx_refresh',
        ${EPOCH}::timestamptz, ${EPOCH}::timestamptz, 'refused',
        0, 'private_address', 'fred: host is not on the allow-list'
      )
    `);
    const stored = await database.db.execute<{
      outcome: string;
      refusal_code: string;
      requests_made: number;
    }>(
      sql`SELECT outcome, refusal_code, requests_made FROM market_data_runs WHERE id = ${id}::uuid`,
    );
    expect(stored.rows[0]).toMatchObject({
      outcome: 'refused',
      refusal_code: 'private_address',
      // A refusal never left the process, so it cost the provider nothing.
      requests_made: 0,
    });
  });
});

describe.skipIf(NO_DATABASE)('0015 refuses the rows that would corrupt a chart', () => {
  let database: TestDatabase;
  let securityId: string;

  beforeAll(async () => {
    database = await integrationsDatabase('constraints');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await database.truncate();
    securityId = await database.createSecurity('etf');
  });

  function insertPrice(source: string, close: string): Promise<unknown> {
    return database.db.execute(sql`
      INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, observed_at)
      VALUES (${newId()}::uuid, ${database.userId}::uuid, ${securityId}::uuid,
              ${AS_OF}::date, ${source}, ${close}::numeric, 'USD', ${EPOCH}::timestamptz)
    `);
  }

  it('refuses a carry-forward written back as an observation', async () => {
    // 07 §6.1: "never recompute history from today's price." `last_known` is
    // the *fourth rung of the read ladder* — a label applied when no row exists
    // for a date — and storing one would turn a gap into a fact, quietly
    // rewriting a chart with a price nobody ever observed.
    expect(await pgFailureOf(insertPrice('last_known', '232.35'))).toEqual({
      code: '23514',
      constraint: 'prices_source_is_an_observation',
    });
    // The rungs that *are* observations still go in.
    await insertPrice('tiingo', '232.35');
    expect(await countRows(database, 'prices')).toBe(1);
  });

  it('refuses a negative close but accepts zero', async () => {
    expect(await pgFailureOf(insertPrice('tiingo', '-0.01'))).toEqual({
      code: '23514',
      constraint: 'prices_close_is_not_negative',
    });

    // Zero is not a missing price; it is a delisted security or a dead token,
    // and refusing to record it would leave the last real close standing
    // forever as though nothing had happened.
    await insertPrice('user_override', '0');
    const stored = await database.db.execute<{ close: string }>(
      sql`SELECT close FROM prices WHERE source = 'user_override'`,
    );
    expect(stored.rows[0]?.close).toBe('0.0000000000');
  });

  function insertFx(base: string, quote: string, rate: string): Promise<unknown> {
    return database.db.execute(sql`
      INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date,
                            source, rate, observed_at)
      VALUES (${newId()}::uuid, ${database.userId}::uuid, ${base}, ${quote},
              ${AS_OF}::date, 'fred', ${rate}::numeric, ${EPOCH}::timestamptz)
    `);
  }

  it('refuses a self-pair, because the only 1.0 is the one FxReader never stores', async () => {
    // D4 and 08 §6.6: "a missing rate is an explicit FxRateUnavailable domain
    // error ... never a silent 1.0." The failure mode is a CAD account quietly
    // counting as USD — arithmetically plausible, materially wrong, invisible.
    // Making USD→USD unstorable means no query can find a 1.0 row and mistake
    // it for a fetched rate, and no fixture can accidentally create one.
    expect(await pgFailureOf(insertFx('USD', 'USD', '1'))).toEqual({
      code: '23514',
      constraint: 'fx_rates_is_a_real_pair',
    });
  });

  it('refuses a zero rate', async () => {
    // Not merely implausible: a stored 0 divides some downstream conversion
    // into an infinity, and the row that caused it would look like data.
    expect(await pgFailureOf(insertFx('EUR', 'USD', '0'))).toEqual({
      code: '23514',
      constraint: 'fx_rates_rate_is_positive',
    });
    await insertFx('EUR', 'USD', '1.0842000000');
    expect(await countRows(database, 'fx_rates')).toBe(1);
  });

  function insertRung(source: string, rung: number): Promise<unknown> {
    return database.db.execute(sql`
      INSERT INTO price_source_priority (id, user_id, security_kind, rung, source)
      VALUES (${newId()}::uuid, ${database.userId}::uuid, 'etf', ${rung}, ${source})
    `);
  }

  it('pins the two rungs that make the ladder mean anything', async () => {
    // 07 §6.1's ladder is user-editable (§6 of the dispatch), which is exactly
    // why these two are CHECKs rather than conventions: a user override that is
    // not first is not an override, and a `last_known` carry-forward that is
    // not last would shadow a real quote with a stale one.
    expect(await pgFailureOf(insertRung('user_override', 2))).toEqual({
      code: '23514',
      constraint: 'price_source_priority_override_is_first',
    });
    expect(await pgFailureOf(insertRung('last_known', 98))).toEqual({
      code: '23514',
      constraint: 'price_source_priority_last_known_is_last',
    });

    // The ladder as 07 §6.1 writes it, which the schema does accept.
    await insertRung('user_override', 1);
    await insertRung('exchange_fill', 2);
    await insertRung('tiingo', 3);
    await insertRung('last_known', 99);
    expect(await countRows(database, 'price_source_priority')).toBe(4);
  });

  it('a NUMERIC(20,10) close round-trips as an exact decimal string, never a float', async () => {
    // D3 and docs/CONVENTIONS.md. Two values chosen for what a float would do
    // to them: 0.0000000342 is ETH-in-BTC territory, where minor units would
    // round the price away at the storage layer, and 232.35 is the everyday
    // close that IEEE-754 renders as 232.34999999999999 on a bad day.
    await insertPrice('tiingo', '0.0000000342');
    await insertPrice('coingecko', '232.35');

    const stored = await database.db.execute<{ source: string; close: unknown }>(
      sql`SELECT source, close FROM prices ORDER BY source`,
    );
    const closes = new Map(stored.rows.map((row) => [row.source, row.close]));

    // A string, not a number: `installTypeParsers` leaves NUMERIC alone on
    // purpose, so the value never passes through a double at all.
    expect(typeof closes.get('tiingo')).toBe('string');
    expect(typeof closes.get('coingecko')).toBe('string');
    // Exact, to the column's full scale. The trailing zeros are the evidence:
    // this is the stored decimal, padded to 10 places, not a re-rendered float.
    expect(closes.get('tiingo')).toBe('0.0000000342');
    expect(closes.get('coingecko')).toBe('232.3500000000');
    expect(Number(closes.get('coingecko'))).toBeCloseTo(232.35, 10);
  });
});
