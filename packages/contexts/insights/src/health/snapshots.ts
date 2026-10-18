// SPDX-License-Identifier: MIT
/**
 * The daily health snapshot (WP 10.12; migration 0048): one row per (holder, day), written once, never
 * updated, never backfilled.
 *
 * Two writers share one function, `ensureHealthSnapshotForToday`: the 04:10 `insights.health_snapshot` job
 * (`job.ts`) and `GET /insights/health` when the holder opens the screen and today's row is missing. Both
 * build the same `kind: 'builtin'` snapshot over `HEALTH_SNAPSHOT_SCOPES` the weekly Brief job builds, and
 * both score it with `computeHealthScore` — unchanged, so the daily row and the weekly row of the same day
 * agree. Idempotent the way `computeAndStoreHealthScore` is: a short-circuit read, an `ON CONFLICT DO
 * NOTHING` insert, and the winner read back on a lost race.
 */
import {
  DateOnly,
  newId,
  systemClock,
  todayIn,
  type Clock,
  type DateOnly as DateOnlyType,
} from '@core/kernel';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { healthScoreSnapshots } from '../../schema/index.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import type { InsightsDatabase, InsightsExecutor } from '../db.ts';
import { SnapshotBuilder } from '../snapshot/builder.ts';
import type { SnapshotPorts } from '../snapshot/ports.ts';
import { deriveTokenKey } from '../snapshot/tokens.ts';
import {
  computeLivingExpenses,
  livingExpensesReadWindow,
  type LivingExpenses,
  type LivingExpensesPort,
} from './living-expenses.ts';
import { healthSnapshotRecordOf, type HealthPillar } from './pillars.ts';
import { HEALTH_SNAPSHOT_SCOPES } from './store.ts';

export interface StoredHealthSnapshot {
  readonly id: string;
  readonly asOfDate: DateOnlyType;
  readonly score: number | null;
  readonly pillars: readonly HealthPillar[];
  readonly computedAt: Date;
}

function storedOf(row: typeof healthScoreSnapshots.$inferSelect): StoredHealthSnapshot {
  return {
    id: row.id,
    asOfDate: DateOnly.parse(row.asOfDate),
    score: row.score === null ? null : Number.parseFloat(row.score),
    pillars: row.pillars as unknown as readonly HealthPillar[],
    computedAt: row.computedAt,
  };
}

export async function findHealthSnapshot(
  executor: InsightsExecutor,
  userId: string,
  asOfDate: DateOnlyType,
): Promise<StoredHealthSnapshot | null> {
  const rows = await executor
    .select()
    .from(healthScoreSnapshots)
    .where(
      and(eq(healthScoreSnapshots.userId, userId), eq(healthScoreSnapshots.asOfDate, asOfDate)),
    );
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/** Every snapshot in `[from, to]`, oldest first. */
export async function listHealthSnapshots(
  executor: InsightsExecutor,
  userId: string,
  window: { readonly from: DateOnlyType; readonly to: DateOnlyType },
): Promise<StoredHealthSnapshot[]> {
  const rows = await executor
    .select()
    .from(healthScoreSnapshots)
    .where(
      and(
        eq(healthScoreSnapshots.userId, userId),
        gte(healthScoreSnapshots.asOfDate, window.from),
        lte(healthScoreSnapshots.asOfDate, window.to),
      ),
    )
    .orderBy(asc(healthScoreSnapshots.asOfDate));
  return rows.map(storedOf);
}

export interface StoreHealthSnapshotInput {
  readonly userId: string;
  readonly asOfDate: DateOnlyType;
  readonly snapshot: AdvisorSnapshot;
  readonly livingExpenses?: LivingExpenses;
  readonly clock?: Clock;
}

/** Score `snapshot` and store it as `asOfDate`'s row, unless that day already has one. */
export async function computeAndStoreHealthSnapshot(
  database: InsightsDatabase,
  input: StoreHealthSnapshotInput,
): Promise<{ readonly snapshot: StoredHealthSnapshot; readonly written: boolean }> {
  const already = await findHealthSnapshot(database, input.userId, input.asOfDate);
  if (already !== null) return { snapshot: already, written: false };

  const record = healthSnapshotRecordOf(input.snapshot, input.livingExpenses);
  const computedAt = (input.clock ?? systemClock).now();
  const id = newId();
  const inserted = await database
    .insert(healthScoreSnapshots)
    .values({
      id,
      userId: input.userId,
      asOfDate: input.asOfDate,
      score: record.score === null ? null : record.score.toFixed(2),
      pillars: record.pillars as unknown as readonly Record<string, unknown>[],
      computedAt,
    })
    .onConflictDoNothing({ target: [healthScoreSnapshots.userId, healthScoreSnapshots.asOfDate] })
    .returning({ id: healthScoreSnapshots.id });

  if (inserted[0] === undefined) {
    const winner = await findHealthSnapshot(database, input.userId, input.asOfDate);
    if (winner !== null) return { snapshot: winner, written: false };
  }
  return {
    snapshot: {
      id,
      asOfDate: input.asOfDate,
      score: record.score,
      pillars: record.pillars,
      computedAt,
    },
    written: true,
  };
}

export interface HealthSnapshotDependencies {
  readonly database: InsightsDatabase;
  readonly snapshotPorts: SnapshotPorts;
  readonly tokenSecret: string;
  readonly currencyCode: string;
  /** Categories with their variability and Reports' spending cells; omitted → the living cover is not shown. */
  readonly livingExpenses?: LivingExpensesPort;
  readonly clock?: Clock;
}

/**
 * Today's row (today in `timeZone`) for this holder: read when it exists, computed and written once when
 * it does not. The one path the job and the on-demand read share.
 */
export async function ensureHealthSnapshotForToday(
  deps: HealthSnapshotDependencies,
  input: { readonly userId: string; readonly timeZone: string },
): Promise<{ readonly snapshot: StoredHealthSnapshot; readonly written: boolean }> {
  const clock = deps.clock ?? systemClock;
  const today = todayIn(clock, input.timeZone);
  const existing = await findHealthSnapshot(deps.database, input.userId, today);
  if (existing !== null) return { snapshot: existing, written: false };

  const built = await new SnapshotBuilder(deps.snapshotPorts).build({
    userId: input.userId,
    kind: 'builtin',
    grantedScopes: HEALTH_SNAPSHOT_SCOPES,
    today,
    baseCurrency: deps.currencyCode,
    tokenKey: deriveTokenKey(deps.tokenSecret, input.userId),
  });
  const livingExpenses =
    deps.livingExpenses === undefined
      ? undefined
      : computeLivingExpenses(
          await deps.livingExpenses({
            userId: input.userId,
            window: livingExpensesReadWindow(today),
          }),
          today,
        );
  return computeAndStoreHealthSnapshot(deps.database, {
    userId: input.userId,
    asOfDate: today,
    snapshot: built.snapshot,
    ...(livingExpenses === undefined ? {} : { livingExpenses }),
    clock,
  });
}
