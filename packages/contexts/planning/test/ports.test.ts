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
    // WP 4.1 appended GoalCreated and RiskProfileAnswered; WP 4.2, AssumptionsOverridden.
    expect(PLANNING_EVENTS.map((event) => event.type)).toEqual([
      'planning.NetWorthSnapshotTaken',
      'planning.GoalCreated',
      'planning.RiskProfileAnswered',
      'planning.AssumptionsOverridden',
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
