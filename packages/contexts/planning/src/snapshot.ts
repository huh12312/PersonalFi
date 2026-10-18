// SPDX-License-Identifier: MIT
/**
 * The snapshotter: compute the open day, seal the days that have closed, say so.
 *
 * This is the one place the four pieces meet — `net-worth.ts` computes,
 * `store.ts` persists, `seal.ts` decides what has closed, `events.ts` announces
 * — and it is deliberately the only place, so that "who may write
 * `net_worth_daily`?" has a one-file answer (08 §1.3 #8).
 *
 * ## Order matters, and this is the order
 *
 *   1. **Seal first.** Every open day that has passed 02:00 local of the day
 *      after it becomes history *before* anything is recomputed. Doing it the
 *      other way round would recompute yesterday with today's prices and then
 *      seal that — which is precisely the bug the seal exists to prevent,
 *      arrived at by being helpful.
 *   2. **Then compute today**, which is the only day still allowed to move.
 *
 * A day is sealed with whatever number it last held. It is **not** recomputed on
 * the way out: 08 §3.5's "never touched again" starts at the seal, and a "one
 * last refresh" before closing the books is a rewrite with a nicer name.
 *
 * ## Failure posture
 *
 * `FxRateUnavailable` and `InterpolationRefused` propagate. Inside the job
 * runner that rolls the transaction back and retries with backoff, which is the
 * correct outcome: a day whose CAD account has no rate is a day we do not know,
 * and 08 §6.6's answer is a manual rate in the UI, not a written row with an
 * invented number in it. The seals that already happened in this transaction
 * roll back with it and are re-attempted on the next run, which is harmless —
 * sealing is idempotent by way of the `sealed_at IS NULL` guard.
 */
import { appendEvent } from '@core/platform';
import type { Clock } from '@core/kernel';
import { NetWorthSnapshotTaken } from './events.ts';
import { recordMilestoneCrossings } from './milestones.ts';
import { computeNetWorth, type NetWorthSnapshot } from './net-worth.ts';
import type { SnapshotPorts } from './ports.ts';
import { isSealable, openDateIn, SealedRowImmutable } from './seal.ts';
import {
  currentRow,
  openDays,
  platformOf,
  sealDay,
  upsertOpenDay,
  writeCorrection,
  type PlanningExecutor,
} from './store.ts';

export interface SnapshotContext {
  readonly userId: string;
  readonly clock: Clock;
  /** IANA zone. The seal is a *local* 02:00, and so is "today". */
  readonly timeZone: string;
  readonly baseCurrency: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface SnapshotResult {
  readonly asOfDate: string;
  readonly revision: number;
  readonly sealedDates: readonly string[];
  readonly netWorthMinor: bigint;
  readonly source: string;
  readonly stalePrice: boolean;
  readonly accountsCounted: number;
  readonly accountsUnvalued: number;
}

/**
 * Seal what has closed, recompute today, emit `planning.NetWorthSnapshotTaken`.
 *
 * @throws {FxRateUnavailable} a foreign account had no rate; nothing is written.
 * @throws {InterpolationRefused} an account class was reconstructed dishonestly.
 */
export async function runSnapshot(
  executor: PlanningExecutor,
  ports: SnapshotPorts,
  context: SnapshotContext,
): Promise<SnapshotResult> {
  const today = openDateIn(context.clock, context.timeZone);

  // 1. Seal, oldest first, before a single number is recomputed.
  const sealedDates: string[] = [];
  for (const day of await openDays(executor, context.userId)) {
    if (!isSealable(day, context.clock, context.timeZone)) continue;
    await sealDay(executor, { userId: context.userId, asOfDate: day, clock: context.clock });
    sealedDates.push(day);
  }

  // 2. Compute the one day that may still move.
  const snapshot = await computeNetWorth(ports, {
    userId: context.userId,
    asOfDate: today,
    baseCurrency: context.baseCurrency,
  });
  const row = await upsertOpenDay(executor, {
    userId: context.userId,
    snapshot,
    clock: context.clock,
  });

  await emitSnapshotTaken(executor, context, snapshot, {
    revision: row.revision,
    sealed: row.sealedAt !== null,
  });

  // 3. WP 10.13: the open day is the latest day there is, so this is where a round figure is crossed.
  //    Same transaction — a milestone announced for a day that rolled back would be a notice about a
  //    figure nobody stored. Once per holder per milestone (`milestones.ts`); a correction never calls it.
  await recordMilestoneCrossings(executor, context, {
    asOfDate: row.asOfDate,
    baseCurrency: row.baseCurrency,
    netWorthMinor: row.netWorthMinor,
  });

  return {
    asOfDate: row.asOfDate,
    revision: row.revision,
    sealedDates,
    netWorthMinor: row.netWorthMinor,
    source: row.source,
    stalePrice: row.stalePrice,
    accountsCounted: snapshot.accountsCounted,
    accountsUnvalued: snapshot.accountsUnvalued,
  };
}

/**
 * Correct a sealed day: recompute it and write the result as a *new revision*.
 *
 * The sealed row is never written to — `writeCorrection` only INSERTs — so the
 * app can still answer "what did we show on the 14th?" after the 14th has been
 * corrected. `reason` is mandatory and non-empty by CHECK constraint
 * (`net_worth_daily_correction_carries_provenance`), because a correction
 * nobody can explain is indistinguishable from a bug.
 *
 * Nothing calls this on a schedule, deliberately. A correction is a decision.
 */
export async function correctDay(
  executor: PlanningExecutor,
  ports: SnapshotPorts,
  context: SnapshotContext,
  input: { readonly asOfDate: string; readonly reason: string },
): Promise<SnapshotResult> {
  const existing = await currentRow(executor, context.userId, input.asOfDate);
  if (existing === null) {
    throw new SealedRowImmutable(input.asOfDate, 0);
  }

  const snapshot = await computeNetWorth(ports, {
    userId: context.userId,
    asOfDate: input.asOfDate,
    baseCurrency: context.baseCurrency,
  });
  const row = await writeCorrection(executor, {
    userId: context.userId,
    snapshot,
    reason: input.reason,
    clock: context.clock,
  });

  // `source` is overridden rather than taken from the snapshot: the computation
  // may well have been `observed`, but the *row* is a correction, and that is
  // what the row and the event both say.
  await emitSnapshotTaken(executor, context, snapshot, {
    revision: row.revision,
    sealed: true,
    source: 'corrected',
  });

  return {
    asOfDate: row.asOfDate,
    revision: row.revision,
    sealedDates: [],
    netWorthMinor: row.netWorthMinor,
    source: 'corrected',
    stalePrice: row.stalePrice,
    accountsCounted: snapshot.accountsCounted,
    accountsUnvalued: snapshot.accountsUnvalued,
  };
}

async function emitSnapshotTaken(
  executor: PlanningExecutor,
  context: SnapshotContext,
  snapshot: NetWorthSnapshot,
  meta: {
    readonly revision: number;
    readonly sealed: boolean;
    readonly source?: 'observed' | 'interpolated' | 'corrected';
  },
): Promise<void> {
  await appendEvent(
    platformOf(executor),
    NetWorthSnapshotTaken.create(
      {
        asOfDate: snapshot.asOfDate,
        revision: meta.revision,
        baseCurrency: snapshot.baseCurrency,
        netWorthMinor: snapshot.netWorthMinor.toString(),
        source: meta.source ?? snapshot.source,
        sealed: meta.sealed,
        stalePrice: snapshot.stalePrice,
        accountsCounted: snapshot.accountsCounted,
        accountsUnvalued: snapshot.accountsUnvalued,
      },
      {
        userId: context.userId,
        // The day is the aggregate. `aggregateId` wants a UUID elsewhere in the
        // system but is a free-form text column, and the date is the identity a
        // reader of the log actually wants to see here.
        aggregateId: null,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
}
