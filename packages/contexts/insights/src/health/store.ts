// SPDX-License-Identifier: MIT
/**
 * The health score's database surface: reading the previous stored week,
 * computing and storing this one (05-phase-5-dispatch.md §3 WP 5.8;
 * migration 0033).
 *
 * ## `computeAndStoreHealthScore` is this package's export for the orchestrator
 *
 * The weekly-job fold is the orchestrator's — this package owns
 * `src/health/**` only, not the composition of `brief/job.ts`'s
 * `insights.brief` handler (WP 5.6) or `apps/api/src/{modules.ts,worker.ts}`
 * (W-C). What this file exports is the one call the fold needs:
 * `computeAndStoreHealthScore(database, { userId, isoWeek, snapshot, clock? })`.
 * It takes an already-built `AdvisorSnapshot` rather than building one
 * itself — `score.ts`'s own header states the reason this package follows
 * throughout: `computeHealthScore` is pure over a snapshot so it is
 * deterministic and testable without a database, and building a snapshot
 * (`SnapshotBuilder`, `SnapshotPorts`, a token key, a grant) is composition-
 * root machinery this WP does not own and must not reach into. The fold
 * line this evidence records (`docs/evidence/phase-5/wp5.8-health.md` §6)
 * builds the snapshot with `kind: 'builtin'` over the seven scopes
 * `score.ts`'s header names, the same way `buildAdvisorRequest` does for
 * any other advisor, and passes the result straight in.
 *
 * ## Idempotent per (user, ISO week), the Brief's own pattern
 *
 * `computeAndStoreHealthScore` follows `brief/store.ts#publishWeeklyBrief`'s
 * exact shape: a cheap short-circuit read before any computation, an
 * `ON CONFLICT (user_id, iso_week) DO NOTHING` insert, and a read-back on a
 * lost race — so two ticks for the same week (a retried job, two workers)
 * never produce two rows and never disagree about what this week's score
 * was.
 *
 * ## Direction of travel reads backward through this table, not forward
 *
 * `previousComponentScoresFor` looks up `previousIsoWeek(isoWeek)` against
 * this same table (`brief/iso-week.ts#previousIsoWeek` — a sibling
 * directory's pure function, imported rather than re-derived, 03 §5.2's
 * lesson against a second implementation of the same arithmetic) and
 * returns `null` when no row exists there: a holder's first-ever computed
 * week. `computeHealthScore` reads that `null` as "every component's
 * direction is `no_previous_data`" — this file only has to be the thing
 * that actually produces `null` on a first week, which is what makes
 * `'direction of travel compares against the previous stored week, and the
 * first week says so'` a database claim and not only a unit claim about
 * `directionOf`.
 */
import { and, desc, eq } from 'drizzle-orm';
import { newId, systemClock, type Clock } from '@core/kernel';
import { healthScores } from '../../schema/index.ts';
import { previousIsoWeek } from '../brief/iso-week.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import type { InsightsDatabase, InsightsExecutor } from '../db.ts';
import {
  computeHealthScore,
  type HealthComponentResult,
  type HealthExcludedComponent,
  type PreviousComponentScore,
} from './score.ts';
import type { HealthComponentId } from './thresholds.ts';

export interface StoredHealthScore {
  readonly id: string;
  readonly isoWeek: string;
  /** 0-100, or `null` when every component was excluded that week. */
  readonly overall: number | null;
  readonly components: readonly HealthComponentResult[];
  readonly excluded: readonly HealthExcludedComponent[];
  readonly computedAt: Date;
}

function storedOf(row: typeof healthScores.$inferSelect): StoredHealthScore {
  return {
    id: row.id,
    isoWeek: row.isoWeek,
    overall: row.overall === null ? null : Number.parseFloat(row.overall),
    components: row.components as unknown as readonly HealthComponentResult[],
    excluded: row.excluded as unknown as readonly HealthExcludedComponent[],
    computedAt: row.computedAt,
  };
}

/** The stored row for one holder's one ISO week, or `null` when none exists. */
export async function findHealthScoreByWeek(
  executor: InsightsExecutor,
  userId: string,
  isoWeek: string,
): Promise<StoredHealthScore | null> {
  const rows = await executor
    .select()
    .from(healthScores)
    .where(and(eq(healthScores.userId, userId), eq(healthScores.isoWeek, isoWeek)));
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/**
 * The most recently computed week for this holder — "current", the same
 * meaning `routes/brief.ts#loadBrief` gives "current" for the Brief:
 * `iso_week` is `YYYY-Www` with zero-padded year and week, so lexicographic
 * order is chronological order and no date arithmetic is needed here either.
 */
export async function findLatestHealthScore(
  executor: InsightsExecutor,
  userId: string,
): Promise<StoredHealthScore | null> {
  const rows = await executor
    .select()
    .from(healthScores)
    .where(eq(healthScores.userId, userId))
    .orderBy(desc(healthScores.isoWeek))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/**
 * What `computeHealthScore` needs about the previous stored week, per
 * component — `null` when no row exists for `previousIsoWeek(isoWeek)`,
 * which is exactly a holder's first-ever computed week.
 */
export async function previousComponentScoresFor(
  executor: InsightsExecutor,
  userId: string,
  isoWeek: string,
): Promise<ReadonlyMap<HealthComponentId, PreviousComponentScore> | null> {
  const previous = await findHealthScoreByWeek(executor, userId, previousIsoWeek(isoWeek));
  if (previous === null) return null;
  const map = new Map<HealthComponentId, PreviousComponentScore>();
  for (const component of previous.components) {
    map.set(component.component, { score: component.score });
  }
  return map;
}

export interface ComputeAndStoreHealthScoreInput {
  readonly userId: string;
  readonly isoWeek: string;
  /**
   * Built by the caller — see this file's header. `computeHealthScore`
   * reads only `cash_summary`, `cashflow_monthly`, `plan_projection`,
   * `liabilities_terms`, `recurring_list`, `holdings_aggregate` and
   * `fees_summary`; a snapshot missing a block is exactly how that
   * component ends up named in `excluded` rather than scored as zero.
   */
  readonly snapshot: AdvisorSnapshot;
  readonly clock?: Clock;
}

export interface ComputedHealthScore extends StoredHealthScore {
  /** `true` when this call found the week already computed: nothing was written. */
  readonly alreadyComputed: boolean;
}

/**
 * Compute and store one week's health score. Idempotent: a second call for
 * a week already computed writes nothing and reports `alreadyComputed`,
 * the same short-circuit `publishWeeklyBrief` runs for the Brief.
 */
export async function computeAndStoreHealthScore(
  database: InsightsDatabase,
  input: ComputeAndStoreHealthScoreInput,
): Promise<ComputedHealthScore> {
  const already = await findHealthScoreByWeek(database, input.userId, input.isoWeek);
  if (already !== null) {
    return { ...already, alreadyComputed: true };
  }

  const previous = await previousComponentScoresFor(database, input.userId, input.isoWeek);
  const result = computeHealthScore(input.snapshot, previous);
  const clock = input.clock ?? systemClock;
  const computedAt = clock.now();
  const id = newId();

  const inserted = await database
    .insert(healthScores)
    .values({
      id,
      userId: input.userId,
      isoWeek: input.isoWeek,
      overall: result.overall === null ? null : result.overall.toFixed(2),
      components: result.components as unknown as readonly Record<string, unknown>[],
      excluded: result.excluded as unknown as readonly Record<string, unknown>[],
      computedAt,
    })
    .onConflictDoNothing({ target: [healthScores.userId, healthScores.isoWeek] })
    .returning({ id: healthScores.id });

  if (inserted[0] === undefined) {
    // Lost the race between the short-circuit read above and this insert:
    // another computation for this week won. Its row stands; nothing of
    // ours is written — the same "read back the winner" `publishWeeklyBrief`
    // does on the identical race.
    const existing = await findHealthScoreByWeek(database, input.userId, input.isoWeek);
    if (existing !== null) return { ...existing, alreadyComputed: true };
  }

  return {
    id,
    isoWeek: input.isoWeek,
    overall: result.overall,
    components: result.components,
    excluded: result.excluded,
    computedAt,
    alreadyComputed: false,
  };
}
