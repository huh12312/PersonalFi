// SPDX-License-Identifier: MIT
/**
 * C5-3 (Phase 5 gate G5-5, High): S1 and S5 — `builtin.spending.category_anomaly`
 * and `builtin.spending.new_merchant_high_charge` — must actually fire on a
 * real install, through the nightly fan-out, on the gate's own walk data: a
 * $940 charge against a $95-$129 weekly baseline, and a first-time $1,299
 * charge at a new merchant (`docs/evidence/phase-5/gate-security-review.md`
 * §3.4, §4 G5-5).
 *
 * Before this package's fix, both rules' only scope — `transactions.anomalies`
 * — carried `requiresPerRunConsent: true`, and `effectiveRunScopes` dropped
 * it for every run because no run path (the nightly `insights.run_all`
 * fan-out, `POST /advisors/run`, the Brief) ever supplied a per-run consent
 * for a `builtin` advisor. The run completed with `grantedScopes: []`, and
 * nothing was ever proposed, silently.
 *
 * This suite goes through the **shipped** nightly path (C5-11): the real
 * `createRunAllJob` fan-out reads the real `AdvisorRegistry` and enqueues the
 * real `insights.run` job kind; the real `createRunJob` handler then calls
 * the real `runAdvisor` → `effectiveRunScopes` → `SnapshotBuilder` pipeline.
 * The two advisors are the production catalogue's own objects
 * (`advisorFor(spendingCategoryAnomaly)` / `advisorFor(spendingNewMerchantHighCharge)`,
 * `src/advisors/catalogue.ts`'s own wrapper) — nothing about the rule or the
 * run-control code is reconstructed here. Only the ledger port is a fake (the
 * documented seam every suite in this package uses, `test/db/harness.ts`'s
 * header); a standing grant of `transactions.anomalies` is written exactly as
 * the consent screen writes one (`grantScopes`, no `perRunConsent` column
 * set), exactly what the Phase 5 gate did live and found dead.
 */
import { Money, systemClock } from '@core/kernel';
import { platformExecutor, silentLogger, type FlagService, type JobContext } from '@core/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisorRuns, insights } from '../../schema/index.ts';
import { advisorFor } from '../../src/advisors/catalogue.ts';
import {
  spendingCategoryAnomaly,
  spendingNewMerchantHighCharge,
} from '../../src/advisors/builtin/anomaly/anomaly.ts';
import type { InsightsContext } from '../../src/db.ts';
import { MODULE_FLAG_KEY } from '../../src/policy/kill-switches.ts';
import { createAdvisorRegistry } from '../../src/registry.ts';
import { RUN_JOB_KIND, createRunAllJob, createRunJob } from '../../src/jobs.ts';
import type { InsightsDependencies } from '../../src/service.ts';
import {
  emptyPorts,
  inMemoryLedgerPort,
  type InsightsTransaction,
} from '../../src/snapshot/ports.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import {
  NO_DATABASE,
  USD,
  ZONE,
  contextFor,
  insightsDatabase,
  type TestDatabase,
} from './harness.ts';
import { flagsFor, liveSwitches } from './run-control-harness.ts';

const ANOMALY_ID = spendingCategoryAnomaly.manifest.advisor_id;
const NEW_MERCHANT_ID = spendingNewMerchantHighCharge.manifest.advisor_id;

function txn(input: {
  readonly id: string;
  readonly date: string;
  readonly merchantId: string;
  readonly categorySlug: string;
  readonly amountMinor: bigint;
}): InsightsTransaction {
  return {
    id: input.id,
    date: input.date as InsightsTransaction['date'],
    merchantId: input.merchantId,
    categorySlug: input.categorySlug,
    amount: Money.of(input.amountMinor, USD),
  };
}

/**
 * The gate's walk data (`gate-security-review.md` §3.3-§3.4), as a ledger
 * rather than as the walk's live Postgres rows: six ordinary weekly grocery
 * charges in the gate's own $95-$129 band, one $940 charge at a merchant that
 * already appears (so it is S1's case and never S5's too), and one first-time
 * $1,299 charge at a merchant seen nowhere else (S5's case, and never S1's:
 * its category has only this one row, below the five-row baseline floor).
 */
const GROCERY_OUTLIER_MERCHANT = 'merchant-groceries-regular';
const WALK_TRANSACTIONS: readonly InsightsTransaction[] = [
  txn({
    id: 'txn-grocery-1',
    date: '2026-03-07',
    merchantId: 'merchant-groceries-a',
    categorySlug: 'food.groceries',
    amountMinor: -9_500n,
  }),
  txn({
    id: 'txn-grocery-2',
    date: '2026-04-11',
    merchantId: 'merchant-groceries-b',
    categorySlug: 'food.groceries',
    amountMinor: -10_000n,
  }),
  txn({
    id: 'txn-grocery-3',
    date: '2026-05-16',
    merchantId: 'merchant-groceries-c',
    categorySlug: 'food.groceries',
    amountMinor: -10_500n,
  }),
  txn({
    id: 'txn-grocery-4',
    date: '2026-06-20',
    merchantId: 'merchant-groceries-d',
    categorySlug: 'food.groceries',
    amountMinor: -11_000n,
  }),
  // This merchant's *first* appearance — $120.00, ordinary — so the $940
  // charge from the same merchant below is not that merchant's first charge
  // and S5 never fires on it.
  txn({
    id: 'txn-grocery-5',
    date: '2026-07-25',
    merchantId: GROCERY_OUTLIER_MERCHANT,
    categorySlug: 'food.groceries',
    amountMinor: -12_000n,
  }),
  txn({
    id: 'txn-grocery-6',
    date: '2026-08-29',
    merchantId: 'merchant-groceries-e',
    categorySlug: 'food.groceries',
    amountMinor: -12_900n,
  }),
  // The gate's $940 charge: the same merchant as txn-grocery-5, so this is
  // not a first-time charge — only S1 (the category outlier), never S5.
  txn({
    id: 'txn-grocery-outlier',
    date: '2026-09-15',
    merchantId: GROCERY_OUTLIER_MERCHANT,
    categorySlug: 'food.groceries',
    amountMinor: -94_000n,
  }),
  // The gate's first-time $1,299 merchant. Its own category has no other
  // row, so it never clears the five-row baseline floor for S1 — only S5.
  txn({
    id: 'txn-new-merchant',
    date: '2026-09-16',
    merchantId: 'merchant-new-electronics',
    categorySlug: 'shopping.electronics',
    amountMinor: -129_900n,
  }),
];

function jobContext(userId: string, kind: string): JobContext {
  return {
    id: '01930000-0000-7000-8000-00000000c5a1',
    userId,
    kind,
    attempt: 1,
    correlationId: '01930000-0000-7000-8000-0000000000c5',
    logger: silentLogger,
    clock: systemClock,
    signal: new AbortController().signal,
  };
}

async function queuedRunJobs(
  database: TestDatabase,
): Promise<readonly { readonly advisorId: string }[]> {
  const rows = await database.db.execute<{ advisor_id: string }>(
    sql`SELECT payload->>'advisorId' AS advisor_id FROM jobs WHERE kind = ${RUN_JOB_KIND} ORDER BY advisor_id`,
  );
  return rows.rows.map((row) => ({ advisorId: row.advisor_id }));
}

async function runRow(
  database: TestDatabase,
  advisorId: string,
): Promise<{ readonly status: string | null; readonly grantedScopes: readonly string[] }> {
  const [row] = await database.db
    .select({ status: advisorRuns.status, grantedScopes: advisorRuns.grantedScopes })
    .from(advisorRuns)
    .where(eq(advisorRuns.advisorId, advisorId))
    .orderBy(sql`${advisorRuns.startedAt} DESC`)
    .limit(1);
  return { status: row?.status ?? null, grantedScopes: row?.grantedScopes ?? [] };
}

async function insightTypes(database: TestDatabase): Promise<readonly string[]> {
  const rows = await database.db
    .select({ type: insights.type })
    .from(insights)
    .where(eq(insights.userId, database.userId));
  return rows.map((row) => row.type).sort();
}

describe.skipIf(NO_DATABASE)('C5-3 — S1 and S5 through the nightly run_all path', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('c5_3_anomaly');
    await database.truncate();
    flags = flagsFor(database);
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function world(): Promise<InsightsDependencies> {
    const dependencies: InsightsDependencies = {
      registry: createAdvisorRegistry([
        advisorFor(spendingCategoryAnomaly),
        advisorFor(spendingNewMerchantHighCharge),
      ]),
      ports: { ...emptyPorts(), ledger: inMemoryLedgerPort({ transactions: WALK_TRANSACTIONS }) },
      switches: liveSwitches(flags),
      settings: { timeZone: ZONE, baseCurrency: USD, tokenSecret: 'test-secret' },
    };
    for (const manifest of [
      spendingCategoryAnomaly.manifest,
      spendingNewMerchantHighCharge.manifest,
    ]) {
      await registerAdvisor(database.db, context, { manifest, enabled: true });
      // A *standing* grant only — never a per-run consent. This is exactly
      // what the consent screen writes, and exactly what the Phase 5 gate
      // wrote live with `perRunConsent: true` on the grant row (a column
      // `listGrants` does not even read) and still saw drop out.
      await grantScopes(database.db, context, manifest.advisor_id, ['transactions.anomalies']);
    }
    await flags.set(platformExecutor(database.db), context.userId, MODULE_FLAG_KEY, true);
    return dependencies;
  }

  it('a standing grant of transactions.anomalies, with no per-run consent, raises S1 and S5 through the real nightly fan-out', async () => {
    const dependencies = await world();
    const runInput = { database: database.db, dependencies, clock: systemClock };

    // The real fan-out: reads the registry, enqueues the real job kind.
    await createRunAllJob({ database: database.db, registry: dependencies.registry }).handler(
      {},
      jobContext(database.userId, 'insights.run_all'),
    );
    const queued = await queuedRunJobs(database);
    expect(queued.map((row) => row.advisorId).sort()).toEqual([ANOMALY_ID, NEW_MERCHANT_ID].sort());

    // The real per-advisor handler, exactly as the worker's job runner would
    // dequeue and call it.
    for (const { advisorId } of queued) {
      await createRunJob(runInput).handler(
        { advisorId, trigger: 'schedule' },
        jobContext(database.userId, RUN_JOB_KIND),
      );
    }

    const anomalyRun = await runRow(database, ANOMALY_ID);
    const newMerchantRun = await runRow(database, NEW_MERCHANT_ID);
    expect(anomalyRun.status).toBe('completed');
    expect(newMerchantRun.status).toBe('completed');
    // The scope the consent gate must stop dropping, on both runs.
    expect(anomalyRun.grantedScopes).toEqual(['transactions.anomalies']);
    expect(newMerchantRun.grantedScopes).toEqual(['transactions.anomalies']);

    expect(await insightTypes(database)).toEqual(
      ['spending.category_anomaly', 'spending.new_merchant_high_charge'].sort(),
    );
  }, 60_000);
});
