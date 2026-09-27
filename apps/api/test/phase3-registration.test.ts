// SPDX-License-Identifier: MIT
/**
 * The Phase 3 wiring batch, asserted structurally — no database, no network.
 *
 * `docs/plan/03-phase-3-dispatch.md` §4 items 3 and 4 make three claims about
 * `apps/api/src/{platform,modules}.ts` that are cheap to state and expensive to
 * discover broken:
 *
 *   1. **Every event `@ctx/investments` and `@ctx/integrations` define is
 *      registered.** An event a context emits but the composition root never
 *      registers is an event `EventRegistry.parse` refuses at the pump, which
 *      surfaces as a consumer that fails every batch rather than as anything
 *      resembling "you forgot a line in `modules.ts`".
 *   2. **Every schedule name matches `SCHEDULE_NAME_PATTERN`.** This is the
 *      Phase 2 worker crash-loop, stated as a test. `@ctx/notifications`
 *      registered `notifications.deliver:<uuid>`; every unit test passed
 *      because the fake scheduler never applied the CHECK constraint, and the
 *      real worker died on its first start against the real one
 *      (wp2.w-wiring.md). `assertScheduleName` now makes it throwable, and
 *      this file makes it *thrown in CI* rather than at 03:45 in production.
 *   3. **A module whose flag is off contributes nothing** — no event, no
 *      consumer, no job, no schedule. WP 3.14's claim, and the 2.13 pattern.
 *
 * Deliberately in the `api` project (`test/*.test.ts`, no Postgres): every one
 * of these is a claim about the *shape* of what `appModules()` returns, and a
 * shape claim that needs a database is a shape claim nobody runs.
 * `apps/api/test/db/phase3-wiring.test.ts` is the other half — that the wiring
 * also *works* against a real pump and a real database.
 */
import { systemClock } from '@core/kernel';
import { createEventRegistry, type RegisteredConsumer } from '@core/platform';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTEGRATIONS_EVENTS,
  inMemoryMarketDataWriter,
  inMemoryRunRecorder,
} from '@ctx/integrations';
import {
  INVESTMENTS_EVENTS,
  LOTS_CONSUMED_EVENT_TYPES,
  LOTS_CONSUMER_NAME,
} from '@ctx/investments';
import { NET_WORTH_CONSUMED_EVENT_TYPES, PLANNING_EVENTS } from '@ctx/planning';
import { ADVISOR_SCOPES, BUILTIN_CATALOGUE, SCOPE_CATALOGUE } from '@ctx/insights';
import { describe, expect, it } from 'vitest';
import {
  GOAL_PACE_CONSUMER_NAME,
  NET_WORTH_CONSUMER_NAME,
  NET_WORTH_SNAPSHOT_CRON,
  NET_WORTH_SNAPSHOT_JOB_KIND,
  NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
  PRICE_REFRESH_CRON,
  PRICE_REFRESH_JOB_KIND,
  PRICE_REFRESH_SCHEDULE_NAME,
  PROJECTION_REFRESH_JOB_KIND,
  appModules,
  type ModuleWiringOptions,
} from '../src/modules.ts';
import { resolveModules, type Platform } from '../src/platform.ts';

/**
 * The narrowest `appModules()` argument that still builds every Phase 3
 * registration.
 *
 * Every collaborator here is a stub *of something this file never calls*: the
 * orchestrator's job handler, the notification channels and the sync port are
 * never invoked, because nothing in this file runs a consumer or a job. What
 * is real is the thing under test — the array `appModules()` returns.
 */
function wiringOptions(
  overrides: Partial<ModuleWiringOptions> = {},
  executed: unknown[] = [],
): ModuleWiringOptions {
  const noop = (): never => {
    throw new Error('not called by a registration-shape test');
  };
  return {
    // `execute` records and answers with no rows rather than throwing: the
    // `module.integrations` schedule really does issue one `upsertSchedule`,
    // and a stub that threw would make "the schedule was declared" untestable
    // without a database. `transaction` still throws — nothing here runs a job.
    database: {
      transaction: noop,
      execute: (query: unknown) => {
        executed.push(query);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as ModuleWiringOptions['database'],
    // D6's one holder, which `module.planning` binds its price/FX readers to.
    userId: 'user-1',
    orchestrator: {
      jobHandler: () => ({ kind: 'connections.sync', handler: noop }),
      registerNightlySchedule: async () => undefined,
    } as unknown as ModuleWiringOptions['orchestrator'],
    timezone: 'America/Los_Angeles',
    clock: systemClock,
    notificationChannels: {
      ntfy: { kind: 'ntfy', send: noop },
      smtp: { kind: 'smtp', send: noop },
    } as unknown as ModuleWiringOptions['notificationChannels'],
    secretBox: {} as unknown as ModuleWiringOptions['secretBox'],
    investmentSyncPort: {
      factsForRun: noop,
      isRetirementAccount: noop,
      isDigitalAsset: noop,
    } as unknown as ModuleWiringOptions['investmentSyncPort'],
    marketData: {
      runtime: { sources: [], figi: undefined, keys: [], budgets: new Map() },
      writer: inMemoryMarketDataWriter(),
      recorder: inMemoryRunRecorder(),
    },
    ...overrides,
  };
}

/**
 * The three name patterns `packages/db/migrations/0003_platform.sql` enforces,
 * read out of the migration text.
 *
 * Postgres regex syntax and JavaScript's agree on every construct these three
 * use (anchors, classes, groups, quantifiers), so the literal transfers
 * unchanged. Parsing the file is deliberate: the Phase 2 defect was a name
 * that no test knew the database would refuse.
 */
function platformNamePatterns(): {
  readonly scheduleName: RegExp;
  readonly jobKind: RegExp;
  readonly eventType: RegExp;
} {
  const sql = readFileSync(
    join(import.meta.dirname, '../../../packages/db/migrations/0003_platform.sql'),
    'utf8',
  );
  const extract = (column: string): RegExp => {
    const match = new RegExp(String.raw`CHECK \(${column} ~ '([^']+)'\)`, 'u').exec(sql);
    if (match?.[1] === undefined) {
      throw new Error(`0003_platform.sql no longer has a CHECK on ${column}`);
    }
    return new RegExp(match[1].replaceAll(String.raw`\\`, '\\'), 'u');
  };
  return {
    scheduleName: extract('name'),
    jobKind: extract('kind'),
    eventType: extract('event_type'),
  };
}

/** A `Platform` whose flag service answers from a fixed set. Nothing else is used. */
function platformWithFlagsOn(on: ReadonlySet<string>): Platform {
  const registry = createEventRegistry();
  return {
    db: {} as Platform['db'],
    metrics: {} as Platform['metrics'],
    registry,
    flags: {
      isEnabled: async (_userId: string, key: string) => on.has(key),
    } as unknown as Platform['flags'],
  };
}

describe('Phase 3 registration (apps/api/src/{platform,modules}.ts)', () => {
  it('registers every event @ctx/investments and @ctx/integrations define', async () => {
    // Only the two Phase 3 modules. The other five declare schedules that
    // would reach for a real database through their own context's executor,
    // and this file has none — which is the point: what is being asserted is
    // that `resolveModules` registers *these* events, not that the whole
    // application boots (`apps/api/test/db/phase3-wiring.test.ts` does that).
    const platform = platformWithFlagsOn(
      new Set(['module.investments', 'module.integrations', 'module.planning']),
    );
    const executed: unknown[] = [];
    const resolved = await resolveModules(
      platform,
      'user-1',
      appModules(wiringOptions({}, executed)),
    );

    // `resolveModules` ran the schedule declaration, not merely collected it —
    // one `upsertSchedule` reached the executor.
    expect(resolved.enabled).toEqual([
      'module.investments',
      'module.integrations',
      'module.planning',
    ]);
    expect(executed.length).toBeGreaterThan(0);

    const declared = [...INVESTMENTS_EVENTS, ...INTEGRATIONS_EVENTS, ...PLANNING_EVENTS];
    // Six from investments (Phase 3's five plus WP 4.7's
    // `AllocationTargetsChanged`), two from integrations, six from planning
    // (`NetWorthSnapshotTaken`; WP 4.1's `GoalCreated` and
    // `RiskProfileAnswered`; WP 4.2's `AssumptionsOverridden`; WP 4.6's
    // `ProjectionCompleted` and `GoalOffTrack`). Pinned so that an event
    // *added* to a context without a line here is a failure rather than a
    // silently unregistered type.
    expect(INVESTMENTS_EVENTS).toHaveLength(6);
    expect(INTEGRATIONS_EVENTS).toHaveLength(2);
    expect(PLANNING_EVENTS).toHaveLength(6);

    for (const definition of declared) {
      expect(
        platform.registry.get(definition.type),
        `${definition.type} is defined by its context but never registered in modules.ts`,
      ).toBeDefined();
    }
  });

  it('every event name is namespaced to the context that owns it', () => {
    for (const definition of INVESTMENTS_EVENTS) {
      expect(definition.type.startsWith('investments.')).toBe(true);
    }
    for (const definition of INTEGRATIONS_EVENTS) {
      expect(definition.type.startsWith('integrations.')).toBe(true);
    }
  });

  it('every schedule and job name matches the CHECK constraint the database itself carries', () => {
    // The Phase 2 crash-loop, as a unit test — and read out of the migration
    // rather than copied into this file, which is the difference between
    // asserting the rule and asserting a *memory* of the rule. A hand-copied
    // regex that drifts from `0003_platform.sql` reproduces the original
    // defect exactly: green here, dead on the first real start.
    const { scheduleName, jobKind, eventType } = platformNamePatterns();

    expect(scheduleName.test(PRICE_REFRESH_SCHEDULE_NAME)).toBe(true);
    expect(jobKind.test(PRICE_REFRESH_JOB_KIND)).toBe(true);

    // The sabotage this asserts against: the exact shape WP 2.4 shipped and
    // the real worker died on.
    expect(
      scheduleName.test(`${PRICE_REFRESH_SCHEDULE_NAME}:0f9e8d7c-1111-2222-3333-444455556666`),
      'a per-user suffix must use underscores, never a raw UUID (wp2.w-wiring.md)',
    ).toBe(false);

    // Same treatment for the event names, against `domain_events.event_type`.
    for (const definition of [...INVESTMENTS_EVENTS, ...INTEGRATIONS_EVENTS]) {
      expect(eventType.test(definition.type), `${definition.type} would fail the CHECK`).toBe(true);
    }
  });

  it('the price-refresh job kind, schedule name and cron are the documented ones', () => {
    expect(PRICE_REFRESH_JOB_KIND).toBe('integrations.price_refresh');
    expect(PRICE_REFRESH_SCHEDULE_NAME).toBe('integrations.price_refresh');
    // 03:45 local (08 §3.7) — minute 45, hour 3, every day.
    expect(PRICE_REFRESH_CRON).toBe('45 3 * * *');
  });

  it('module.investments registers the lot consumer, and it listens for a sync run', () => {
    const investments = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.investments',
    );
    expect(investments).toBeDefined();
    const consumers = investments?.consumers ?? [];
    expect(consumers).toHaveLength(1);

    const consumer = consumers[0] as RegisteredConsumer;
    expect(consumer.name).toBe(LOTS_CONSUMER_NAME);
    // The filter is what makes "starts at seq 0 and catches up over history"
    // affordable: the pump reads only the types this consumer names.
    expect(consumer.filter).toEqual([...LOTS_CONSUMED_EVENT_TYPES]);
    expect(consumer.filter).toContain('connections.SyncRunCompleted');

    // Nothing here is time-driven (wp3.2-lots.md §11).
    expect(investments?.jobs ?? []).toHaveLength(0);
    expect(investments?.schedules).toBeUndefined();
  });

  it('module.integrations registers the price-refresh job and schedule, and no consumer', () => {
    const integrations = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.integrations',
    );
    expect(integrations).toBeDefined();
    expect((integrations?.jobs ?? []).map((job) => job.kind)).toEqual([PRICE_REFRESH_JOB_KIND]);
    expect(integrations?.schedules).toBeDefined();
    // `@ctx/integrations` reacts to nothing: it may not read another context's
    // events any more than it may read their tables (08 §1.3 #11).
    expect(integrations?.consumers ?? []).toHaveLength(0);
  });

  it('module.integrations registers events and nothing else when no market-data wiring is supplied', () => {
    // The `app.ts` shape: the API runs no job runner and no scheduler, so it
    // supplies no market-data runtime and must not declare a schedule row that
    // only the worker can service.
    const options = wiringOptions();
    const { marketData: _omitted, ...withoutMarketData } = options;
    const integrations = appModules(withoutMarketData as ModuleWiringOptions).find(
      (module) => module.flagKey === 'module.integrations',
    );
    expect(integrations?.events).toEqual(INTEGRATIONS_EVENTS);
    expect(integrations?.jobs ?? []).toHaveLength(0);
    expect(integrations?.schedules).toBeUndefined();
    expect(integrations?.consumers ?? []).toHaveLength(0);
  });

  it('module.planning registers the net-worth consumer, the goal-pace consumer, the 04:00 and 04:30 jobs and their schedules', () => {
    // WP 4.6 added a second consumer (`planning.goal_pace@v1`) and a second
    // job/schedule pair (`planning.projection_refresh`, 04:30) beside WP 3.8's
    // net-worth snapshot; this is that test, renamed and extended rather than
    // duplicated, per docs/evidence/phase-4/wp4.6-projection-service.md §10.3.
    const planning = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.planning',
    );
    expect(planning).toBeDefined();
    expect(planning?.events).toEqual(PLANNING_EVENTS);

    const consumers = planning?.consumers ?? [];
    expect(consumers).toHaveLength(2);
    const netWorthConsumer = consumers[0] as RegisteredConsumer;
    expect(netWorthConsumer.name).toBe(NET_WORTH_CONSUMER_NAME);
    // Three producers, none of which `@ctx/planning` may import: the filter is
    // strings for exactly that reason (`consumer.ts`'s own doc).
    expect(netWorthConsumer.filter).toEqual([...NET_WORTH_CONSUMED_EVENT_TYPES]);
    expect(netWorthConsumer.filter).toContain('ledger.BalanceRecorded');
    expect(netWorthConsumer.filter).toContain('investments.HoldingsUpdated');
    expect(netWorthConsumer.filter).toContain('integrations.PricesUpdated');

    const goalPaceConsumer = consumers[1] as RegisteredConsumer;
    expect(goalPaceConsumer.name).toBe(GOAL_PACE_CONSUMER_NAME);
    expect(goalPaceConsumer.filter).toEqual(['planning.ProjectionCompleted']);

    expect((planning?.jobs ?? []).map((job) => job.kind)).toEqual([
      NET_WORTH_SNAPSHOT_JOB_KIND,
      PROJECTION_REFRESH_JOB_KIND,
    ]);
    // One run in flight at a time, for each job — declared by `@ctx/planning`
    // itself in `jobs.ts` now that nothing here wraps either handler.
    expect(planning?.jobs?.[0]?.concurrency).toBe(1);
    expect(planning?.jobs?.[1]?.concurrency).toBe(1);
    expect(planning?.schedules).toBeDefined();
  });

  it('the net-worth job kind, schedule name and cron are the documented ones', () => {
    expect(NET_WORTH_SNAPSHOT_JOB_KIND).toBe('planning.net_worth_snapshot');
    expect(NET_WORTH_SNAPSHOT_SCHEDULE_NAME).toBe('planning.net_worth_snapshot');
    // 04:00 local — after the 03:15 sync and the 03:45 refresh (08 §3.7).
    expect(NET_WORTH_SNAPSHOT_CRON).toBe('0 4 * * *');
    expect(NET_WORTH_CONSUMER_NAME).toBe('planning.net_worth@v1');

    const { scheduleName, jobKind, eventType } = platformNamePatterns();
    expect(scheduleName.test(NET_WORTH_SNAPSHOT_SCHEDULE_NAME)).toBe(true);
    expect(jobKind.test(NET_WORTH_SNAPSHOT_JOB_KIND)).toBe(true);
    for (const definition of PLANNING_EVENTS) {
      expect(eventType.test(definition.type), `${definition.type} would fail the CHECK`).toBe(true);
      expect(definition.type.startsWith('planning.')).toBe(true);
    }
  });

  it('neither planning job wraps its handler with a by-name refusal any more', async () => {
    // Through WP 3.8, `appModules` bound `@ctx/planning`'s price and FX readers
    // to one holder and this file's wrapper refused, by name, a job whose
    // `context.userId` differed (D6). WP 4.6 changed `SnapshotJobDependencies
    // .portsFor` / added `ProjectionRefreshJobDependencies.portsFor` to
    // `(executor, userId) => …`, so `modules.ts`'s `planningModule` no longer
    // wraps either handler — the ports are built from the job's own userId on
    // every run (docs/evidence/phase-4/wp4.6-projection-service.md §10.1).
    //
    // Proved behaviourally, not by string-matching a deleted message:
    // `wiringOptions()`'s stub `database.transaction` is a `noop` that throws
    // "not called by a registration-shape test" the instant anything calls
    // it. The old wrapper threw its own, different message **before** ever
    // reaching `database.transaction` for a different-holder context; with
    // the wrapper gone, both handlers reach straight through to it and throw
    // the stub's message instead. That a *different real* holder's job is
    // actually served end to end needs a real transaction and a real second
    // holder's row, which is why the full proof is
    // `apps/api/test/db/phase4-wiring.test.ts`'s "a second holder's refresh
    // job is served, not refused by name".
    const planning = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.planning',
    );
    const jobs = planning?.jobs ?? [];
    expect(jobs).toHaveLength(2);
    const context = {
      userId: 'a-different-holder',
      correlationId: 'c',
      clock: systemClock,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never;
    for (const job of jobs) {
      await expect(job.handler({}, context)).rejects.toThrow(
        /not called by a registration-shape test/u,
      );
    }
  });

  it('a flag that is off contributes no event, no consumer, no job and no schedule', async () => {
    // WP 3.14's claim (the 2.13 pattern): "off" is structural, not a runtime
    // check inside each handler. `schedules` is the one that matters most —
    // `scheduler.tick` enqueues any due row with no flag check of its own.
    let schedulesCalled = 0;
    const modules = appModules(wiringOptions()).map((module) =>
      module.flagKey === 'module.integrations' && module.schedules !== undefined
        ? {
            ...module,
            schedules: async (userId: string): Promise<void> => {
              schedulesCalled += 1;
              await module.schedules?.(userId);
            },
          }
        : module,
    );

    const platform = platformWithFlagsOn(new Set());
    const resolved = await resolveModules(platform, 'user-1', modules);

    expect(resolved.consumers).toHaveLength(0);
    expect(resolved.jobs).toHaveLength(0);
    expect(resolved.enabled).toHaveLength(0);
    expect(resolved.disabled).toContain('module.investments');
    expect(resolved.disabled).toContain('module.integrations');
    expect(resolved.disabled).toContain('module.planning');
    expect(schedulesCalled).toBe(0);
    for (const definition of [...INVESTMENTS_EVENTS, ...INTEGRATIONS_EVENTS, ...PLANNING_EVENTS]) {
      expect(platform.registry.get(definition.type)).toBeUndefined();
    }
  });
});

/**
 * WP 3.9 wrote this test as a standing claim. WP 3.10a made the claim change,
 * and this is the test re-derived rather than relaxed.
 *
 * `docs/evidence/phase-3/wp3.10-advisor-catalog-v2.md` §7.1 shipped seventeen
 * rules "registered and off" for two reasons — 07 §7.4's release schedule, and
 * the fact that four of the scopes they read had **no reader behind them**.
 * That second reason is a claim about this repository's wiring, and it is the
 * one this test checks. The failure it guards against is silent in the worst
 * way: `SnapshotBuilder#blockFor` returns `null` for an unsourced scope, so a
 * rule enabled against one produces **no insight at all** rather than an error,
 * and the release looks like a quiet week rather than a broken one.
 *
 * `wp3.10a-snapshot-readers.md` landed those four readers — the two ports, the
 * four `#blockFor` arms and the four `sourcedInPhase2` flips — so the expected
 * sets here **shrink**, in both directions. The unsourced set is now exactly the
 * four whose source context does not exist, and the reviewed-exception list is
 * now empty. Neither was loosened to match the code: each was re-derived from
 * what is actually wired, and each still fails if a flag is reverted, if a fifth
 * unsourced scope appears, or if a reader is deleted.
 *
 * ## What writing this test found, kept because it is still true
 *
 * `requires_scopes` is a **grant** list, not a list of hard requirements. Two
 * rules that shipped *enabled* — C1 and C2 — declared `market.rates` while it
 * had no reader, and were correct to: `rules-cash.ts` reads
 * `snapshot.market_rates?.rates ?? []` and falls back to "the best rate you
 * already hold". So "an enabled rule may not read an unsourced scope" is *too
 * strong*, and asserting it would have forced a wrong fix. What is assertable,
 * and is what this test says, is that the list of enabled rules doing so is
 * **exactly the reviewed one**. That list is empty today only because
 * `market.rates` gained a reader — not because the rule was removed.
 */
describe('advisor scopes and their readers (WP 3.9, closed by WP 3.10a)', () => {
  /**
   * The four blocks `wp3.10-advisor-catalog-v2.md` §7.1 owed, **landed by WP
   * 3.10a**: `InvestmentsPort.holdings`, `InvestmentsPort.liabilities` and
   * `MarketDataPort.rates` in `snapshot/ports.ts`, the `#holdingsAggregate`,
   * `#holdingsDetail`, `#liabilitiesTerms` and `#marketRates` arms in
   * `snapshot/builder.ts`, and the four flag flips in `contract/scopes.ts` — all
   * in one change, because an arm without a flag is dead code and a flag without
   * an arm is a silent no-key.
   *
   * Listed rather than deleted, and asserted **sourced** below: reverting any
   * one of the four flips fails here by name, which is the direction that
   * matters now that the readers exist.
   */
  const LANDED_IN_WP_3_10A = [
    'holdings.aggregate',
    'holdings.detail',
    'liabilities.terms',
    'market.rates',
  ];

  /**
   * The other scopes with no reader, and the reason theirs is not a gap.
   *
   * `goals.list` and `risk.profile` belong to Planning, which is Phase 4 —
   * `@ctx/planning` today is WP 3.8's net-worth snapshotter and nothing else.
   * `market.watchlist` has no model in the app at all. `institutions.names` is
   * the one deliberate refusal in the list: 08 §4.2 gives it the highest
   * sensitivity of any scope and nothing has needed it.
   *
   * Listed rather than tolerated, so that "which scopes have no reader?" has a
   * checked answer instead of a `.filter()` a reader has to interpret.
   */
  const NOT_YET_MODELLED = ['goals.list', 'institutions.names', 'market.watchlist', 'risk.profile'];

  /**
   * Rules that ship **on** while declaring a scope with no reader, each
   * reviewed and each with a fallback that is not silence.
   *
   * **Empty since WP 3.10a, and emptied by a reader rather than by an edit to
   * this list.** It held C1 and C2, both `rules-cash.ts`', whose only unsourced
   * scope was `market.rates`; that scope now has `#marketRates` behind it, so
   * neither rule qualifies any more. Their fallback is untouched and still
   * exercised — `market_rates` is absent whenever the process has no FRED source
   * (`app.ts`' on-demand run: see the port wiring in `routes/insights.ts`), so
   * "the best rate you already hold" remains a live path, not dead code.
   *
   * An empty expectation is still a live tripwire: a rule that ships enabled
   * against `goals.list`, `risk.profile`, `market.watchlist` or
   * `institutions.names` fails here until somebody reads its fallback and adds
   * it deliberately.
   */
  const DEGRADES_WITHOUT_ITS_READER: readonly string[] = [];

  it('every advisor scope has a reader', () => {
    const byScope = new Map(SCOPE_CATALOGUE.map((definition) => [definition.scope, definition]));

    // 1. No scope may exist on the wire without a catalogue row deciding what
    //    it yields, what it drops, and whether it has a reader at all.
    for (const scope of ADVISOR_SCOPES) {
      expect(byScope.get(scope), `${scope} has no SCOPE_CATALOGUE row`).toBeDefined();
    }
    expect(SCOPE_CATALOGUE).toHaveLength(ADVISOR_SCOPES.length);

    // 2. The set of scopes with no reader is now exactly the four whose source
    //    context does not exist — in both directions. Adding a fifth unsourced
    //    scope fails here; so does landing a reader without flipping its
    //    `sourcedInPhase2` flag in the same commit, which would leave the
    //    builder with a dead arm.
    const unsourced = SCOPE_CATALOGUE.filter((definition) => !definition.sourcedInPhase2)
      .map((definition) => definition.scope as string)
      .sort();
    expect(
      unsourced,
      'the scopes with no reader must be exactly the four whose source context does not exist ' +
        'yet; wp3.10 §7.1’s four landed in WP 3.10a',
    ).toEqual([...NOT_YET_MODELLED].sort());

    // 3. The four WP 3.10a landed are asserted *sourced* by name. This is the
    //    direction that matters now: reverting one flag — or deleting an arm
    //    and the flag with it — names the scope that regressed instead of
    //    silently shrinking the snapshot.
    const landed = SCOPE_CATALOGUE.filter((definition) =>
      LANDED_IN_WP_3_10A.includes(definition.scope),
    );
    expect(landed.map((definition) => definition.scope as string).sort()).toEqual(
      [...LANDED_IN_WP_3_10A].sort(),
    );
    for (const definition of landed) {
      expect(
        definition.sourcedInPhase2,
        `${definition.scope} lost the reader WP 3.10a landed`,
      ).toBe(true);
    }

    // 4. And every *other* scope claims a reader, which is what makes the
    //    catalogue's `sourcedInPhase2` a statement about this repository rather
    //    than a field nobody maintains.
    for (const definition of SCOPE_CATALOGUE) {
      if (NOT_YET_MODELLED.includes(definition.scope)) continue;
      expect(definition.sourcedInPhase2, `${definition.scope} lost its reader`).toBe(true);
    }
  });

  it('a rule reading a scope with no reader ships off, or is a reviewed exception', () => {
    const unsourced = new Set(
      SCOPE_CATALOGUE.filter((definition) => !definition.sourcedInPhase2).map(
        (definition) => definition.scope as string,
      ),
    );

    const enabledAndUnsourced: string[] = [];
    for (const entry of BUILTIN_CATALOGUE) {
      const reads = entry.advisor.manifest.requires_scopes.some((scope) =>
        unsourced.has(scope as string),
      );
      if (!reads) continue;
      if (entry.defaultEnabled) {
        enabledAndUnsourced.push(entry.advisorId);
        continue;
      }
      // An off rule must say *why* in the row a reviewer reads, not only in a
      // comment in the file that set the flag.
      expect(entry.disabledReason ?? '', `${entry.advisorId}`).toContain('reader');
    }

    expect(
      enabledAndUnsourced.sort(),
      'a rule that ships enabled while reading a scope with no reader needs a fallback that is ' +
        'not silence; add it to DEGRADES_WITHOUT_ITS_READER only after reading that fallback',
    ).toEqual([...DEGRADES_WITHOUT_ITS_READER].sort());
  });

  /**
   * A reader is only half of a scope. The other half is a **grant**, and a
   * grant is a row in `snapshot_grants` whose `scope` column is constrained by
   * a `CHECK` enumerating every legal value.
   *
   * WP 3.10a found that enumeration is out of date: migration
   * `0012_insights.sql` lists Phase 2's thirteen scopes, and WP 3.10 added
   * `liabilities.terms` and `market.rates` to `SCOPE_CATALOGUE` without one.
   * `grantScopes` therefore fails with a `23514` check violation for either —
   * observed from a real database by `apps/api/test/db/phase3-advisors.test.ts`,
   * which is what turned this from a reading of the SQL into a fact.
   *
   * Migration `0019_snapshot_grant_scopes_v1_1.sql` closed that gap by
   * re-declaring the CHECK. The list is now read from the **latest** migration
   * that declares `snapshot_grants_scope_check` (0012's inline column CHECK, or
   * any later `ADD CONSTRAINT snapshot_grants_scope_check`), so each contract
   * minor that adds a scope must ship a widening migration or this goes red
   * naming the scope — a build failure rather than a runtime 23514.
   */
  const UNGRANTABLE_UNTIL_MIGRATED: readonly string[] = [];

  it('every advisor scope can actually be granted, or is a recorded migration gap', () => {
    const migrationsDir = join(import.meta.dirname, '../../../packages/db/migrations');
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    // The `scope IN ( ... )` list on `snapshot_grants`, read out of the
    // migrations themselves rather than restated here — a copy would agree
    // with itself forever. The last declaration wins, as it does in Postgres.
    let check: RegExpExecArray | null = null;
    for (const name of files) {
      const migration = readFileSync(join(migrationsDir, name), 'utf8');
      const declared =
        /CREATE TABLE snapshot_grants[\s\S]*?scope\s+TEXT\s+NOT NULL CHECK \(scope IN \(([\s\S]*?)\)\)/u.exec(
          migration,
        ) ??
        /ADD CONSTRAINT snapshot_grants_scope_check CHECK \(scope IN \(([\s\S]*?)\)\)/u.exec(
          migration,
        );
      if (declared !== null) check = declared;
    }
    expect(check, 'the snapshot_grants scope CHECK could not be located').not.toBeNull();
    const grantable = new Set(
      [...(check?.[1] ?? '').replace(/--[^\n]*/gu, '').matchAll(/'([a-z_.]+)'/gu)].map(
        (match) => match[1] as string,
      ),
    );
    expect(grantable.size, 'the CHECK list parsed as empty').toBeGreaterThan(0);

    const ungrantable = ADVISOR_SCOPES.filter((scope) => !grantable.has(scope as string)).sort();
    expect(
      ungrantable,
      'a scope the database will not store a grant for is a scope no advisor can ever read; ' +
        'land the migration in packages/db rather than widening this list',
    ).toEqual([...UNGRANTABLE_UNTIL_MIGRATED].sort());

    // And the constraint must not have drifted the other way either: a value
    // the database accepts but the catalogue has never heard of would be a
    // grant nothing could honour.
    for (const scope of grantable) {
      expect(
        (ADVISOR_SCOPES as readonly string[]).includes(scope),
        `${scope} is grantable in SQL but is not an advisor scope`,
      ).toBe(true);
    }
  });
});
