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
import { readFileSync } from 'node:fs';
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
import { describe, expect, it } from 'vitest';
import {
  NET_WORTH_CONSUMER_NAME,
  NET_WORTH_SNAPSHOT_CRON,
  NET_WORTH_SNAPSHOT_JOB_KIND,
  NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
  PRICE_REFRESH_CRON,
  PRICE_REFRESH_JOB_KIND,
  PRICE_REFRESH_SCHEDULE_NAME,
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
    // Five from investments, two from integrations, one from planning. Pinned
    // so that an event *added* to a context without a line here is a failure
    // rather than a silently unregistered type.
    expect(INVESTMENTS_EVENTS).toHaveLength(5);
    expect(INTEGRATIONS_EVENTS).toHaveLength(2);
    expect(PLANNING_EVENTS).toHaveLength(1);

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

  it('module.planning registers the net-worth consumer, the 04:00 job and its schedule', () => {
    const planning = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.planning',
    );
    expect(planning).toBeDefined();
    expect(planning?.events).toEqual(PLANNING_EVENTS);

    const consumers = planning?.consumers ?? [];
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] as RegisteredConsumer;
    expect(consumer.name).toBe(NET_WORTH_CONSUMER_NAME);
    // Three producers, none of which `@ctx/planning` may import: the filter is
    // strings for exactly that reason (`consumer.ts`'s own doc).
    expect(consumer.filter).toEqual([...NET_WORTH_CONSUMED_EVENT_TYPES]);
    expect(consumer.filter).toContain('ledger.BalanceRecorded');
    expect(consumer.filter).toContain('investments.HoldingsUpdated');
    expect(consumer.filter).toContain('integrations.PricesUpdated');

    expect((planning?.jobs ?? []).map((job) => job.kind)).toEqual([NET_WORTH_SNAPSHOT_JOB_KIND]);
    // One snapshot in flight at a time — preserved through the composition
    // root's own wrapper, which is the thing that could silently drop it.
    expect(planning?.jobs?.[0]?.concurrency).toBe(1);
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

  it('the net-worth job refuses, by name, a job enqueued for another holder', async () => {
    // D6: `appModules` binds `@ctx/planning`'s price and FX readers to one
    // holder, because `SnapshotJobDependencies.portsFor` receives the job's
    // transaction and no user id. Without this guard a job for user B would
    // compute B's net worth from A's prices and A's ladder — a wrong number
    // with no error, and invisible in every test that has one user.
    const planning = appModules(wiringOptions()).find(
      (module) => module.flagKey === 'module.planning',
    );
    const handler = planning?.jobs?.[0]?.handler;
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    await expect(
      handler({}, {
        userId: 'a-different-holder',
        correlationId: 'c',
        clock: systemClock,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      } as never),
    ).rejects.toThrow(/was enqueued for a user these modules were not built for/u);
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
