// SPDX-License-Identifier: MIT
/**
 * Net-worth milestones (WP 10.13, V6 of the visual programme): the latest net worth crossed a round
 * figure since the previous snapshot day.
 *
 * ## The ladder
 *
 * Going up: 10k, 25k, 50k, 100k, then every 100k (200k, 300k, …), in major units of the base currency.
 * The zero line in either direction ("your net worth rose above zero" / "fell below zero"). Nothing else
 * going down: a dip back under $50k is not a milestone, and the notice never says it was.
 *
 * A crossing **up** of `m` is `previous < m <= latest`; a crossing **down** of zero is
 * `previous >= 0 > latest`. A jump across several milestones crosses each of them (`milestonesCrossed`
 * returns every one, lowest first), so 0 → 60k is 10k, 25k and 50k.
 *
 * ## Once, ever
 *
 * `net_worth_milestones`' unique `(user_id, milestone_minor, direction)` is the idempotency boundary. The
 * snapshotter recomputes the open day many times a day; each run compares the open day with the previous
 * day's current revision and offers every crossing to `INSERT … ON CONFLICT DO NOTHING RETURNING`, and
 * `planning.NetWorthMilestoneCrossed` is appended for the rows that statement returned — nothing else. A
 * figure that crosses, dips and crosses again is one row and one event.
 *
 * ## What is never compared
 *
 * Two days in different base currencies (a crossing across a currency change is not a crossing anyone
 * can state), and a first-ever snapshot (there is no "previous" to have crossed from).
 */
import { newId, type Clock } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { sql } from 'drizzle-orm';
import { NetWorthMilestoneCrossed } from './events.ts';
import { platformOf, type PlanningExecutor } from './store.ts';

/** Minor units per major unit. Every currency this app values net worth in is scale 2 (`net-worth.ts`). */
const MINOR_PER_MAJOR = 100n;

/** The fixed rungs below the every-100k run, in major units. */
const FIXED_RUNGS_MAJOR = [10_000n, 25_000n, 50_000n] as const;
const STEP_MAJOR = 100_000n;

export type MilestoneDirection = 'up' | 'down';

export interface MilestoneCrossing {
  readonly milestoneMinor: bigint;
  readonly direction: MilestoneDirection;
}

/** The up-ladder in minor units, every rung in `(lo, hi]`, lowest first. */
function rungsBetween(lo: bigint, hi: bigint): bigint[] {
  const rungs: bigint[] = [];
  for (const major of FIXED_RUNGS_MAJOR) {
    const minor = major * MINOR_PER_MAJOR;
    if (minor > lo && minor <= hi) rungs.push(minor);
  }
  const step = STEP_MAJOR * MINOR_PER_MAJOR;
  // The first multiple of 100k strictly above `lo` (and at least 100k).
  let next = lo < step ? step : (lo / step + 1n) * step;
  for (; next <= hi; next += step) rungs.push(next);
  return rungs;
}

/**
 * Every milestone crossed going from `previousMinor` to `latestMinor`: the zero line first (either
 * direction), then the up-ladder rungs lowest first. Empty when nothing was crossed.
 */
export function milestonesCrossed(previousMinor: bigint, latestMinor: bigint): MilestoneCrossing[] {
  const crossings: MilestoneCrossing[] = [];
  if (previousMinor < 0n && latestMinor >= 0n) {
    crossings.push({ milestoneMinor: 0n, direction: 'up' });
  } else if (previousMinor >= 0n && latestMinor < 0n) {
    crossings.push({ milestoneMinor: 0n, direction: 'down' });
  }
  if (latestMinor > previousMinor) {
    for (const rung of rungsBetween(previousMinor, latestMinor)) {
      crossings.push({ milestoneMinor: rung, direction: 'up' });
    }
  }
  return crossings;
}

export interface MilestoneContext {
  readonly userId: string;
  readonly clock: Clock;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface RecordedMilestone {
  readonly id: string;
  readonly milestoneMinor: bigint;
  readonly direction: MilestoneDirection;
  readonly currency: string;
  readonly crossedOn: string;
  readonly previousMinor: bigint;
  readonly latestMinor: bigint;
}

interface PreviousDayRow extends Record<string, unknown> {
  as_of_date: string;
  base_currency: string;
  net_worth_minor: string | bigint;
}

/**
 * Compare the latest day with the previous snapshot day (the current revision of the most recent day
 * before it), record every milestone crossed that was never recorded before, and append one
 * `planning.NetWorthMilestoneCrossed` per row actually inserted. Returns those rows.
 *
 * Called by `runSnapshot` after the open day is written, in the same transaction: a crossing announced
 * for a day that then rolled back would be a notice about a figure nobody stored.
 */
export async function recordMilestoneCrossings(
  executor: PlanningExecutor,
  context: MilestoneContext,
  latest: {
    readonly asOfDate: string;
    readonly baseCurrency: string;
    readonly netWorthMinor: bigint;
  },
): Promise<readonly RecordedMilestone[]> {
  const previous = await executor.execute<PreviousDayRow>(sql`
    SELECT to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date, base_currency, net_worth_minor
      FROM net_worth_daily
     WHERE user_id = ${context.userId}::uuid AND as_of_date < ${latest.asOfDate}::date
     ORDER BY as_of_date DESC, revision DESC
     LIMIT 1
  `);
  const row = previous.rows[0];
  if (row === undefined) return [];
  const currency = latest.baseCurrency.trim();
  if (row.base_currency.trim() !== currency) return [];
  const previousMinor = BigInt(row.net_worth_minor);

  const recorded: RecordedMilestone[] = [];
  for (const crossing of milestonesCrossed(previousMinor, latest.netWorthMinor)) {
    const id = newId();
    const inserted = await executor.execute<{ id: string }>(sql`
      INSERT INTO net_worth_milestones (
        id, user_id, milestone_minor, direction, currency, crossed_on, previous_minor, latest_minor
      ) VALUES (
        ${id}::uuid, ${context.userId}::uuid, ${crossing.milestoneMinor.toString()}::bigint,
        ${crossing.direction}, ${currency}, ${latest.asOfDate}::date,
        ${previousMinor.toString()}::bigint, ${latest.netWorthMinor.toString()}::bigint
      )
      ON CONFLICT (user_id, milestone_minor, direction) DO NOTHING
      RETURNING id
    `);
    if (inserted.rows.length === 0) continue;
    const milestone: RecordedMilestone = {
      id,
      milestoneMinor: crossing.milestoneMinor,
      direction: crossing.direction,
      currency,
      crossedOn: latest.asOfDate,
      previousMinor,
      latestMinor: latest.netWorthMinor,
    };
    await appendEvent(
      platformOf(executor),
      NetWorthMilestoneCrossed.create(
        {
          milestoneId: id,
          milestoneMinor: milestone.milestoneMinor.toString(),
          direction: milestone.direction,
          currency,
          crossedOn: milestone.crossedOn,
          previousMinor: previousMinor.toString(),
          latestMinor: latest.netWorthMinor.toString(),
        },
        {
          userId: context.userId,
          aggregateId: id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    recorded.push(milestone);
  }
  return recorded;
}

interface MilestoneRow extends Record<string, unknown> {
  id: string;
  milestone_minor: string | bigint;
  direction: MilestoneDirection;
  currency: string;
  crossed_on: string;
  previous_minor: string | bigint;
  latest_minor: string | bigint;
}

/** The holder's milestones not yet dismissed, newest crossing first (the highest first within a day). */
export async function listUndismissedMilestones(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly RecordedMilestone[]> {
  const result = await executor.execute<MilestoneRow>(sql`
    SELECT id, milestone_minor, direction, currency, to_char(crossed_on, 'YYYY-MM-DD') AS crossed_on,
           previous_minor, latest_minor
      FROM net_worth_milestones
     WHERE user_id = ${userId}::uuid AND dismissed_at IS NULL
     ORDER BY crossed_on DESC, created_at DESC, milestone_minor DESC
  `);
  return result.rows.map((row) => ({
    id: row.id,
    milestoneMinor: BigInt(row.milestone_minor),
    direction: row.direction,
    currency: row.currency.trim(),
    crossedOn: String(row.crossed_on).slice(0, 10),
    previousMinor: BigInt(row.previous_minor),
    latestMinor: BigInt(row.latest_minor),
  }));
}

/**
 * Dismiss the named milestones (the holder's own only). Idempotent: an already-dismissed row keeps its
 * first `dismissed_at`. Returns how many rows this call dismissed.
 */
export async function dismissMilestones(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly ids: readonly string[]; readonly clock: Clock },
): Promise<number> {
  if (input.ids.length === 0) return 0;
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE net_worth_milestones
       SET dismissed_at = ${input.clock.now().toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid
       AND dismissed_at IS NULL
       AND id = ANY(${`{${input.ids.join(',')}}`}::uuid[])
    RETURNING id
  `);
  return result.rows.length;
}
