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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFxReader,
  createPriceReader,
  inMemoryFxStore,
  inMemoryPriceStore,
} from '@ctx/investments';
import { fixedClock } from '@core/kernel';
import { silentLogger, type JobContext } from '@core/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { CONSUMED_EVENT_TYPES, CONSUMER_NAME } from '../src/consumer.ts';
import {
  PROJECTION_REFRESH_CRON,
  PROJECTION_REFRESH_JOB_KIND,
  PROJECTION_REFRESH_SCHEDULE_NAME,
  SNAPSHOT_CRON,
  SNAPSHOT_JOB_KIND,
  SNAPSHOT_SCHEDULE_NAME,
  netWorthSnapshotJobHandler,
  projectionRefreshJobHandler,
} from '../src/jobs.ts';
import { NetWorthSnapshotTaken, PLANNING_EVENTS } from '../src/events.ts';
import {
  GOAL_PACE_CONSUMED_EVENT_TYPES,
  GOAL_PACE_CONSUMER_NAME,
} from '../src/projection-service.ts';
import type { FxReader, PriceReader, RevealedPorts, SnapshotPorts } from '../src/ports.ts';
import type { PlanningDatabase } from '../src/store.ts';
import { portsOf, type FakeWorld } from './fakes.ts';

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

/**
 * WP 4.3's `SpendingReader`, checked against `@ctx/budgeting` by the compiler.
 *
 * The WP 3.8 checks above are plain assignments because `@ctx/investments` is
 * on planning's allow-list (08 §1.6: plan → invest). `@ctx/budgeting` is not,
 * and must not be — 08 §1.6 draws no plan → budg arrow, the Phase 4 dispatch §4
 * item 2 forbids adding one, and `scripts/eslint-boundaries.js` refuses the
 * import in `test/` exactly as in `src/` (the `crossContext` message; a relative
 * path is refused as `escapes`). `@ctx/budgeting` is not even a dependency of
 * this package, so pnpm would not resolve it here either.
 *
 * So this test does what the composition root does, from where the composition
 * root stands: it writes the **exact binding `apps/api/src/domain.ts` is to
 * carry** into a scratch directory whose `paths` resolve both packages from
 * source, and runs the repo's own `tsc` over it with the repo's own
 * `tsconfig.base.json`. The binding closes over an executor and maps no field —
 * each of budgeting's three functions is handed through, and its return type
 * must already *be* planning's port type.
 *
 * A type check that cannot fail proves nothing, so the same run compiles a
 * second file, `drift.ts`, which assigns the identical binding to a port whose
 * `activity` has drifted to `bigint`. The test requires that file to fail with
 * TS2322 naming `activity`, and `binding.ts` to have no error at all — if
 * resolution silently degraded to `any`, the drift file would compile and this
 * test would go red.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const SPENDING_READER_BINDING = `import { getPeriod, listBudgets, listPeriods, type BudgetingExecutor } from '@ctx/budgeting';
import type { SpendingReader } from '@ctx/planning';

/** WP 4.3's SpendingReader over @ctx/budgeting: the executor closed over, no field mapped. */
export function planningSpendingReaderFor(executor: BudgetingExecutor): SpendingReader {
  return {
    listBudgets: (input) => listBudgets(executor, input),
    listPeriods: (input) => listPeriods(executor, input),
    getPeriod: (input) => getPeriod(executor, input),
  };
}
`;

const DRIFTED_BINDING = `import { getPeriod, listBudgets, listPeriods, type BudgetingExecutor } from '@ctx/budgeting';
import type { SpendingLine, SpendingPeriod, SpendingReader } from '@ctx/planning';

type DriftedLine = Omit<SpendingLine, 'activity'> & { readonly activity: bigint };
type DriftedReader = Omit<SpendingReader, 'getPeriod'> & {
  getPeriod(input: { readonly userId: string; readonly periodId: string }): Promise<
    (Omit<SpendingPeriod, 'lines'> & { readonly lines: readonly DriftedLine[] }) | null
  >;
};

export function drifted(executor: BudgetingExecutor): DriftedReader {
  return {
    listBudgets: (input) => listBudgets(executor, input),
    listPeriods: (input) => listPeriods(executor, input),
    getPeriod: (input) => getPeriod(executor, input),
  };
}
`;

interface ProbeDiagnostic {
  readonly file: string;
  readonly code: string;
  readonly text: string;
}

function typeCheckProbe(files: Readonly<Record<string, string>>): {
  readonly diagnostics: readonly ProbeDiagnostic[];
  readonly output: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'wp43-spending-reader-'));
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: join(REPO_ROOT, 'tsconfig.base.json'),
        compilerOptions: {
          typeRoots: [join(REPO_ROOT, 'node_modules/@types')],
          paths: {
            '@ctx/budgeting': [join(REPO_ROOT, 'packages/contexts/budgeting/src/index.ts')],
            '@ctx/planning': [join(REPO_ROOT, 'packages/contexts/planning/src/index.ts')],
          },
        },
        files: Object.keys(files),
      }),
    );
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(directory, name), source);
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'node_modules/typescript/bin/tsc'),
          '-p',
          'tsconfig.json',
          '--pretty',
          'false',
        ],
        { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }
    const diagnostics: ProbeDiagnostic[] = [];
    let current: { file: string; code: string; lines: string[] } | null = null;
    for (const line of output.split('\n')) {
      const match = /^(\S+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
      if (match !== null) {
        if (current !== null) {
          diagnostics.push({
            file: current.file,
            code: current.code,
            text: current.lines.join('\n'),
          });
        }
        current = { file: match[1] ?? '', code: match[2] ?? '', lines: [match[3] ?? ''] };
      } else if (current !== null && line.trim() !== '') {
        current.lines.push(line.trim());
      }
    }
    if (current !== null) {
      diagnostics.push({ file: current.file, code: current.code, text: current.lines.join('\n') });
    }
    return { diagnostics, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the revealed-behaviour ports (WP 4.3)', () => {
  it("the SpendingReader binding is assignable from @ctx/budgeting's reader with no adapter", () => {
    const { diagnostics, output } = typeCheckProbe({
      'binding.ts': SPENDING_READER_BINDING,
      'drift.ts': DRIFTED_BINDING,
    });
    // The binding the composition root will carry compiles, untouched.
    expect(
      diagnostics.filter((d) => d.file === 'binding.ts'),
      output,
    ).toEqual([]);
    // And the check is live: the same binding against a drifted port is refused,
    // by the field that drifted.
    const drift = diagnostics.filter((d) => d.file === 'drift.ts');
    expect(drift.length, output).toBeGreaterThan(0);
    expect(drift.map((d) => d.code)).toContain('TS2322');
    expect(
      drift.some((d) => /activity/.test(d.text) && /Money/.test(d.text)),
      output,
    ).toBe(true);
    // Deliberately *not* asserted: that nothing else in the tree the probe pulls
    // in (budgeting, planning, and through planning `@ctx/investments`) fails to
    // compile. That is `tsc -b`'s job, and asserting it here would make this
    // test red whenever an unrelated package is mid-edit — the first draft did,
    // on another work package's in-flight `dwell.ts`. The two assertions above
    // are the check: the binding file is clean and the drift file is refused on
    // the field that drifted, so resolution cannot have degraded to `any`.
  }, 120_000);
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
    // WP 4.1 appended GoalCreated and RiskProfileAnswered; WP 4.2, AssumptionsOverridden;
    // WP 4.6, ProjectionCompleted and GoalOffTrack.
    expect(PLANNING_EVENTS.map((event) => event.type)).toEqual([
      'planning.NetWorthSnapshotTaken',
      'planning.GoalCreated',
      'planning.RiskProfileAnswered',
      'planning.AssumptionsOverridden',
      'planning.ProjectionCompleted',
      'planning.GoalOffTrack',
    ]);
    // 0003_platform.sql's `domain_events.event_type` CHECK, read out of the file.
    for (const definition of PLANNING_EVENTS) {
      expect(EVENT_TYPE_CHECK.test(definition.type), definition.type).toBe(true);
    }
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

// ===========================================================================
// WP 4.6 — `portsFor(executor, userId)`, and the second Planning job
// ===========================================================================

const HOLDER_A = 'a1946000-0000-7000-8000-00000000000a';
const HOLDER_B = 'a1946000-0000-7000-8000-00000000000b';
const CASH = 'a1946000-0000-7000-8000-0000000000ca';

/** One cash account per holder, with a different balance each, so a mix-up is visible. */
function worldFor(balanceMinor: string): FakeWorld {
  return {
    accounts: [
      {
        accountId: CASH,
        name: 'Checking',
        kind: 'cash',
        side: 'asset',
        currency: 'USD',
        flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
      },
    ],
    balances: [
      { accountId: CASH, date: '2026-09-20', currentMinor: balanceMinor, currency: 'USD' },
    ],
  };
}

const WORLDS: Readonly<Record<string, FakeWorld>> = {
  [HOLDER_A]: worldFor('100000'),
  [HOLDER_B]: worldFor('250000'),
};

/**
 * A `PlanningDatabase` whose transaction hands the job an executor that answers
 * exactly the statements `runSnapshot` and `refreshBaseline` issue, the way
 * Postgres would for a holder with no rows yet — and records what was written
 * and appended, so the test can see *whose* numbers went where.
 */
function recordingDatabase(): {
  readonly database: PlanningDatabase;
  readonly written: { userId: string; netWorthMinor: string }[];
  readonly appended: { userId: string; eventType: string; payload: Record<string, unknown> }[];
} {
  const dialect = new PgDialect();
  const written: { userId: string; netWorthMinor: string }[] = [];
  const appended: { userId: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const execute = async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    if (text.includes('append_domain_event')) {
      appended.push({
        userId: String(params[1]),
        eventType: String(params[4]),
        payload: JSON.parse(String(params[6])) as Record<string, unknown>,
      });
      return { rows: [{ out_seq: BigInt(appended.length), out_recorded_at: new Date() }] };
    }
    if (text.includes('INSERT INTO net_worth_daily')) {
      written.push({ userId: String(params[1]), netWorthMinor: String(params[6]) });
      return {
        rows: [
          {
            id: params[0],
            as_of_date: params[2],
            revision: 1,
            base_currency: params[3],
            assets_minor: params[4],
            liabilities_minor: params[5],
            net_worth_minor: params[6],
            liquid_minor: params[7],
            investable_minor: params[8],
            on_budget_minor: params[9],
            source: params[11],
            stale_price: params[12],
            dirty: false,
            sealed_at: null,
          },
        ],
      };
    }
    // `openDays`, and `getBaseline` for a holder who has stated none: no rows.
    if (text.includes('FROM net_worth_daily') || text.includes('FROM plan_scenarios')) {
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  const executor = { execute };
  const database = {
    transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(executor),
  } as unknown as PlanningDatabase;
  return { database, written, appended };
}

function jobContext(userId: string, kind: string): JobContext {
  return {
    id: `job-${userId.slice(-1)}`,
    userId,
    kind,
    attempt: 1,
    correlationId: '01920000-0000-7000-8000-0000000000c7',
    logger: silentLogger,
    clock: fixedClock('2026-09-26T08:05:00Z'),
    signal: new AbortController().signal,
  };
}

describe("portsFor takes the job's holder (WP 4.6, wp3.w §10 item 7)", () => {
  it('portsFor takes a userId and a job for a second holder is served, not refused by name', async () => {
    const { database, written, appended } = recordingDatabase();
    const snapshotPortsAskedFor: string[] = [];
    const snapshot = netWorthSnapshotJobHandler({
      database,
      portsFor: (_executor, userId): SnapshotPorts => {
        snapshotPortsAskedFor.push(userId);
        const world = WORLDS[userId];
        if (world === undefined) throw new Error(`no world for ${userId}`);
        return portsOf(world);
      },
      timeZone: 'America/New_York',
      baseCurrency: 'USD',
    });

    // The first holder, then a second one — through the same registration.
    await snapshot.handler({}, jobContext(HOLDER_A, SNAPSHOT_JOB_KIND));
    await expect(
      snapshot.handler({}, jobContext(HOLDER_B, SNAPSHOT_JOB_KIND)),
    ).resolves.toBeUndefined();

    // Each job asked for ports for *its* holder…
    expect(snapshotPortsAskedFor).toEqual([HOLDER_A, HOLDER_B]);
    // …and each holder's row and event carry that holder's own number: B's net
    // worth is B's $2,500, not A's $1,000 read through A's price/FX binding.
    expect(written).toEqual([
      { userId: HOLDER_A, netWorthMinor: '100000' },
      { userId: HOLDER_B, netWorthMinor: '250000' },
    ]);
    expect(
      appended.map((event) => [event.userId, event.eventType, event.payload['netWorthMinor']]),
    ).toEqual([
      [HOLDER_A, NetWorthSnapshotTaken.type, '100000'],
      [HOLDER_B, NetWorthSnapshotTaken.type, '250000'],
    ]);

    // The second Planning job has the same signature and the same property.
    const revealedAskedFor: string[] = [];
    const refresh = projectionRefreshJobHandler({
      database,
      portsFor: (_executor, userId): RevealedPorts => {
        revealedAskedFor.push(userId);
        return {
          cashflow: {
            accounts: async () => [],
            historyStarts: async () => new Map(),
            inflows: async () => [],
          },
          spending: {
            listBudgets: async () => [],
            listPeriods: async () => [],
            getPeriod: async () => null,
          },
        };
      },
      monteCarlo: null,
      timeZone: 'America/New_York',
    });
    await expect(
      refresh.handler({}, jobContext(HOLDER_B, PROJECTION_REFRESH_JOB_KIND)),
    ).resolves.toBeUndefined();
    expect(revealedAskedFor).toEqual([HOLDER_B]);
  });

  it('registers the 04:30 refresh and the goal-pace consumer under names the platform accepts', () => {
    expect(SCHEDULE_NAME_CHECK.test(PROJECTION_REFRESH_SCHEDULE_NAME)).toBe(true);
    expect(JOB_KIND_CHECK.test(PROJECTION_REFRESH_JOB_KIND)).toBe(true);
    expect(PROJECTION_REFRESH_SCHEDULE_NAME).toBe('planning.projection_refresh');
    expect(PROJECTION_REFRESH_JOB_KIND).toBe('planning.projection_refresh');
    // 04:30 local: after the 04:00 snapshot and the 02:00 seal.
    expect(PROJECTION_REFRESH_CRON).toBe('30 4 * * *');
    expect(SCHEDULE_NAME_CHECK.test('planning.projection-refresh')).toBe(false);

    expect(GOAL_PACE_CONSUMER_NAME).toBe('planning.goal_pace@v1');
    expect([...GOAL_PACE_CONSUMED_EVENT_TYPES]).toEqual(['planning.ProjectionCompleted']);
  });
});
