// SPDX-License-Identifier: MIT
/**
 * The seam, asserted rather than hoped for.
 *
 * `src/ports.ts` declares four interfaces that `@ctx/investments`' real readers
 * are meant to satisfy structurally, so `apps/api/src/domain.ts` can wire them
 * in with no adapter. "Meant to" is doing a lot of work in that sentence: the
 * two files live in different packages and nothing but this test connects them.
 *
 * The assignments below are **compile-time** assertions — if `PriceReader` here
 * and `PriceReader` there ever drift, `pnpm exec tsc --noEmit` fails and so does
 * this file. The runtime `expect`s exist so the test reports as a test rather
 * than as an empty file that happens to typecheck.
 *
 * Also here: the schedule and job names, checked against the pattern read out of
 * `@core/platform` itself rather than against a copy of it. The Phase 2 cold
 * boot found a context registering `notifications.deliver:<uuid>`; every unit
 * test passed because the fake scheduler never applied the CHECK, and the real
 * worker crash-looped from its first start.
 */
import { readFileSync } from 'node:fs';
import {
  createFxReader,
  createPriceReader,
  inMemoryFxStore,
  inMemoryPriceStore,
} from '@ctx/investments';
import { describe, expect, it } from 'vitest';
import { CONSUMED_EVENT_TYPES, CONSUMER_NAME } from '../src/consumer.ts';
import { SNAPSHOT_CRON, SNAPSHOT_JOB_KIND, SNAPSHOT_SCHEDULE_NAME } from '../src/jobs.ts';
import { NetWorthSnapshotTaken, PLANNING_EVENTS } from '../src/events.ts';
import type { FxReader, PriceReader } from '../src/ports.ts';

const USER = 'a1920000-0000-7000-8000-00000000a001';

/**
 * The CHECK constraints, read out of the migration rather than copied.
 *
 * `apps/api/test/phase3-registration.test.ts` established this for the Wave A′
 * names and the reason applies here unchanged: a copied regex agrees with the
 * database exactly until somebody edits one of them, and the copy is the one
 * that will not be edited. `@core/platform` keeps `SCHEDULE_NAME_PATTERN`
 * internal to `jobs/scheduler.ts` — it is not on that package's public surface
 * and putting it there is not this work package's edit to make — so the
 * migration is both the honest source and the authoritative one.
 */
const PLATFORM_SQL = readFileSync(
  new URL('../../../../packages/db/migrations/0003_platform.sql', import.meta.url),
  'utf8',
);

function checkPatternFor(column: string): RegExp {
  const match = new RegExp(`${column}\\s+TEXT[^\\n]*?~ '([^']+)'`).exec(PLATFORM_SQL);
  if (match?.[1] === undefined) {
    throw new Error(`no CHECK ... ~ '...' found for ${column} in 0003_platform.sql`);
  }
  // Postgres doubles a backslash in a single-quoted literal the same way it
  // appears here, so the expression transfers to JavaScript unchanged.
  return new RegExp(match[1]);
}

const SCHEDULE_NAME_CHECK = checkPatternFor('name');
const JOB_KIND_CHECK = checkPatternFor('kind');
const EVENT_TYPE_CHECK = checkPatternFor('event_type');

describe('the ports are structural mirrors of the readers that fill them', () => {
  it("accepts @ctx/investments' FxReader with no adapter", async () => {
    // The assignment is the assertion. `createFxReader` returns that context's
    // `FxReader`; if it stopped satisfying this context's, this line would not
    // compile.
    const reader: FxReader = createFxReader({
      store: inMemoryFxStore([
        {
          base: 'CAD',
          quote: 'USD',
          rate: '0.7350',
          rateDate: '2026-06-12',
          source: 'fred',
          observedAt: new Date('2026-06-12T21:00:00Z'),
        },
      ]),
      userId: USER,
    });

    const quote = await reader.rate('CAD', 'USD', '2026-06-15');
    expect(quote.rate).toBe('0.7350');
    // `rateDate` is the observation's own date, which is what D4 stores.
    expect(quote.rateDate).toBe('2026-06-12');
    // And `source` is never `identity` for a genuine pair, which is precisely
    // what `assertRateIsAnObservation` keys on.
    expect(quote.source).not.toBe('identity');
  });

  it("accepts @ctx/investments' PriceReader with no adapter", async () => {
    const reader: PriceReader = createPriceReader({
      store: inMemoryPriceStore([
        {
          securityId: '5e000000-0000-4000-8000-0000000000f1',
          priceDate: '2026-06-15',
          close: '268.40',
          currency: 'USD',
          source: 'tiingo',
          stale: false,
          observedAt: new Date('2026-06-15T21:00:00Z'),
        },
      ]),
      userId: USER,
      kindOf: async () => 'equity',
    });

    const quote = await reader.price('5e000000-0000-4000-8000-0000000000f1', '2026-06-15', 'USD');
    expect(quote?.close).toBe('268.40');
    // The three fields the aggregate's staleness rule reads.
    expect(quote?.staleness).toBeDefined();
    expect(quote?.rung).toBeDefined();
    expect(quote?.carriedForward).toBe(false);
  });

  it('answers null for an unpriced security rather than throwing', async () => {
    // The asymmetry with FX, which is load-bearing: a security nobody has
    // priced is ordinary, and 08 §3.7 needs the day to seal anyway.
    const reader: PriceReader = createPriceReader({
      store: inMemoryPriceStore([]),
      userId: USER,
      kindOf: async () => 'equity',
    });
    await expect(
      reader.price('5e000000-0000-4000-8000-0000000000f1', '2026-06-15', 'USD'),
    ).resolves.toBeNull();
  });
});

describe('the names the composition root registers', () => {
  it('matches the platform pattern the schedules CHECK enforces', () => {
    // The constraints themselves, out of 0003_platform.sql.
    expect(SCHEDULE_NAME_CHECK.test(SNAPSHOT_SCHEDULE_NAME)).toBe(true);
    expect(JOB_KIND_CHECK.test(SNAPSHOT_JOB_KIND)).toBe(true);

    // The dispatch names it, so it is pinned here too: a rename is a decision
    // about a row already in `schedules`, not a refactor.
    expect(SNAPSHOT_SCHEDULE_NAME).toBe('planning.net_worth_snapshot');
    expect(SNAPSHOT_JOB_KIND).toBe('planning.net_worth_snapshot');
    // 04:00 local, after the 03:15 sync and the 03:45 price refresh.
    expect(SNAPSHOT_CRON).toBe('0 4 * * *');
  });

  it('namespaces its event to this context and registers it', () => {
    expect(NetWorthSnapshotTaken.type).toBe('planning.NetWorthSnapshotTaken');
    // The registry list `apps/api` iterates; an appended-but-unregistered event
    // is invisible to the pump's upcasting and fails silently.
    expect(PLANNING_EVENTS.map((event) => event.type)).toEqual(['planning.NetWorthSnapshotTaken']);
    // 0003_platform.sql's `domain_events.event_type` CHECK, read out of the file.
    expect(EVENT_TYPE_CHECK.test(NetWorthSnapshotTaken.type)).toBe(true);
  });

  it('consumes exactly the three events the dispatch names', () => {
    expect([...CONSUMED_EVENT_TYPES].sort()).toEqual([
      'integrations.PricesUpdated',
      'investments.HoldingsUpdated',
      'ledger.BalanceRecorded',
    ]);
    // The consumer name carries a version, so changing what it does means
    // bumping it and replaying from 0.
    expect(CONSUMER_NAME).toMatch(/@v\d+$/);
  });

  it('refuses the shape that crash-looped the Phase 2 worker', () => {
    // `notifications.deliver:<uuid>` — a per-user suffix with a raw UUID in it.
    // Every unit test passed at the time because the fake scheduler never
    // applied the CHECK; the real worker crash-looped from its first start.
    // Asserted against the database's own constraint, so this is the failure
    // the database would produce and not an opinion about it.
    expect(
      SCHEDULE_NAME_CHECK.test(`${SNAPSHOT_SCHEDULE_NAME}:01920000-0000-7000-8000-000000000001`),
    ).toBe(false);
    // Hyphens are the specific trap: a UUID is full of them, and the pattern
    // allows underscores only.
    expect(SCHEDULE_NAME_CHECK.test('planning.net-worth-snapshot')).toBe(false);
  });
});
