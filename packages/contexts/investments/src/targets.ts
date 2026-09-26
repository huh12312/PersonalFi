// SPDX-License-Identifier: MIT
/**
 * Stored allocation targets — migration `0026_allocation_targets.sql`.
 *
 * The other half of the 3.10a ruling
 * (docs/evidence/phase-3/wp3.10a-snapshot-readers.md §7.2):
 * `createInsightsInvestmentsPort` hardcodes `targets: []` because no table
 * held a stored target set, which left I1 (drift) enabled and structurally
 * silent. This file is that table's domain layer.
 *
 * **Owned by `@ctx/investments`, not `@ctx/planning`.** 08 §1.6's arrows point
 * down: `@ctx/investments` may not import from `@ctx/planning`, but Planning
 * may read Investments' published readers. Drift is an investments analytic —
 * `src/analytics/drift.ts`'s `driftAgainstTargets` already takes a target set
 * as an argument, and `GET /investments/drift` is an investments route — so
 * the stored set has to live where the read happens. Storing it in Planning
 * would have every drift computation reach *up* into another context for a
 * number its own route needs on every call, which is exactly the arrow this
 * migration would have violated. `risk_profile` (`@ctx/planning`, WP 4.1)
 * *suggests* a target set from the risk questionnaire; this table is the one
 * `driftAgainstTargets` actually reads.
 *
 * **An empty set means "unset", never a default.** `wp3.9-routes.md` §8 Q9:
 * *"an unset target set still suppresses drift rather than implying 60/40."*
 * `replaceAll(userId, [])` is a legitimate call — it clears the set back to
 * unset, and does not throw. `assertTargetsSumToOne` only runs its sum check
 * against a *non-empty* set.
 *
 * Two implementations of {@link AllocationTargetsStore}, the `src/store.ts`
 * split: `drizzleAllocationTargetsStore(db, clock)` over the real table, and
 * `inMemoryAllocationTargetsStore(clock)` for the domain-rule proofs in
 * `test/targets.test.ts` — which records every event it would have emitted
 * rather than calling the real `appendEvent` (there is no `append_domain_event`
 * function to call without a database), the same split `src/resolver.ts`'s
 * `collectingEventSink` makes for the identical reason.
 */
import { newId, systemClock, type Clock } from '@core/kernel';
import { appendEvent, type NewEvent } from '@core/platform';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_BAND_PCT,
  allocationTargets,
  type AllocationTargetRow,
  type AssetClass,
} from '../schema/index.ts';
import {
  RATIO_ONE,
  RATIO_ZERO,
  absolutePoints,
  comparePoints,
  compareRatio,
  points,
  pointsBetween,
  ratio,
  sumRatios,
  type Points,
  type Ratio,
} from './analytics/types.ts';
import { AllocationTargetsChanged } from './events.ts';
import { outboxOf, type InvestmentsDatabase } from './store.ts';

export class AllocationTargetsError extends Error {
  // A declared field and an assignment rather than a parameter property: the
  // repo compiles with `erasableSyntaxOnly`. Same shape as `LotConstraintError`.
  readonly constraint: string;

  constructor(constraint: string, message: string) {
    super(message);
    this.name = 'AllocationTargetsError';
    this.constraint = constraint;
  }
}

/**
 * Tolerance on "the targets sum to 100%": one hundredth of a point.
 *
 * The identical constant `drift.ts`'s `assertTargetsSumToOne` uses, so a set
 * this store accepts is a set `driftAgainstTargets` can always compute over —
 * the two checks cannot drift apart because both are `Points` comparisons at
 * the same {@link POINTS_SCALE}. `test/targets.test.ts` asserts the two values
 * equal directly.
 */
export const TARGET_SUM_TOLERANCE: Points = points('0.01');

export interface AllocationTargetInput {
  readonly assetClass: AssetClass;
  /** A decimal-string ratio in `[0,1]` — `Ratio`'s own shape, never a `number`. */
  readonly targetWeight: string;
  /** Percentage points. Defaults to {@link DEFAULT_BAND_PCT} (07 I1's 5-point band). */
  readonly bandPct?: string;
}

export interface StoredAllocationTarget {
  readonly assetClass: AssetClass;
  readonly targetWeight: Ratio;
  readonly bandPct: string;
  readonly setAt: Date;
}

/**
 * Refuse a target set that does not sum to 1.0, naming the shortfall.
 *
 * An empty set always passes — it is "unset" (07 §8 Q9), not a set that failed
 * to sum to anything. A set with two rows for the same asset class is refused
 * before the sum is even computed, because a CHECK could not otherwise say
 * which of the two the unique index would keep.
 */
export function assertTargetsSumToOne(targets: readonly AllocationTargetInput[]): void {
  if (targets.length === 0) return;
  const seen = new Set<AssetClass>();
  for (const target of targets) {
    if (seen.has(target.assetClass)) {
      throw new AllocationTargetsError(
        'allocation_targets_one_row_per_class',
        `two targets for ${target.assetClass}`,
      );
    }
    seen.add(target.assetClass);
    const weight = ratio(target.targetWeight);
    if (compareRatio(weight, RATIO_ZERO) < 0 || compareRatio(weight, RATIO_ONE) > 0) {
      throw new AllocationTargetsError(
        'allocation_targets_target_weight_check',
        `${target.assetClass} target weight ${weight} is outside [0,1]`,
      );
    }
  }

  const total = sumRatios(targets.map((target) => ratio(target.targetWeight)));
  // `(total − 1) × 100`, signed: negative means short of 1, positive means over.
  const gap = pointsBetween(total, RATIO_ONE);
  if (comparePoints(absolutePoints(gap), TARGET_SUM_TOLERANCE) > 0) {
    const shortfall = absolutePoints(gap);
    const direction = gap.startsWith('-') ? 'short' : 'over';
    throw new AllocationTargetsError(
      'allocation_targets_sum_to_one',
      `targets sum to ${total}, not 1 — ${direction} by ${shortfall} points`,
    );
  }
}

function targetFromRow(row: AllocationTargetRow): StoredAllocationTarget {
  return {
    assetClass: row.assetClass,
    targetWeight: ratio(row.targetWeight),
    bandPct: row.bandPct,
    setAt: row.setAt,
  };
}

export interface AllocationTargetsStore {
  /** Empty when unset. Never a default — 07 §8 Q9. */
  readonly listAll: (userId: string) => Promise<readonly StoredAllocationTarget[]>;
  /**
   * Replace the whole set in one transaction and emit
   * `investments.AllocationTargetsChanged`. `targets: []` is a legitimate
   * call — it clears the set back to unset, and the event still fires: a
   * consumer watching for "the user changed their mind" must see the clear.
   */
  readonly replaceAll: (
    userId: string,
    targets: readonly AllocationTargetInput[],
  ) => Promise<readonly StoredAllocationTarget[]>;
}

/** The real store, over `0026_allocation_targets.sql`. */
export function drizzleAllocationTargetsStore(
  db: InvestmentsDatabase,
  clock: Clock,
): AllocationTargetsStore {
  return {
    async listAll(userId) {
      const rows = await db
        .select()
        .from(allocationTargets)
        .where(eq(allocationTargets.userId, userId));
      return rows.map(targetFromRow);
    },

    async replaceAll(userId, targets) {
      assertTargetsSumToOne(targets);
      return db.transaction(async (tx) => {
        await tx.delete(allocationTargets).where(eq(allocationTargets.userId, userId));
        const setAt = clock.now();
        if (targets.length > 0) {
          await tx.insert(allocationTargets).values(
            targets.map((target) => ({
              id: newId(),
              userId,
              assetClass: target.assetClass,
              targetWeight: target.targetWeight,
              bandPct: target.bandPct ?? DEFAULT_BAND_PCT,
              setAt,
            })),
          );
        }
        await appendEvent(
          outboxOf(tx),
          AllocationTargetsChanged.create(
            { assetClasses: targets.map((target) => target.assetClass), count: targets.length },
            { userId, correlationId: newId() },
            clock,
          ),
        );
        return targets.map((target) => ({
          assetClass: target.assetClass,
          targetWeight: ratio(target.targetWeight),
          bandPct: target.bandPct ?? DEFAULT_BAND_PCT,
          setAt,
        }));
      });
    },
  };
}

/**
 * For `test/targets.test.ts`'s domain-rule proofs.
 *
 * Enforces the identical `assertTargetsSumToOne` rule the real store does —
 * relaxing it here would make every unit test a statement about the fake, the
 * same argument `src/store.ts`'s header makes for the securities master. There
 * is no `append_domain_event()` to call without a database, so events land in
 * the returned `events` array instead of an outbox; that is the only
 * difference from the real store's observable behaviour.
 */
export function inMemoryAllocationTargetsStore(
  clock: Clock = systemClock,
): AllocationTargetsStore & { readonly events: readonly NewEvent[] } {
  const byUser = new Map<string, readonly StoredAllocationTarget[]>();
  const events: NewEvent[] = [];
  return {
    get events(): readonly NewEvent[] {
      return events;
    },
    async listAll(userId) {
      return byUser.get(userId) ?? [];
    },
    async replaceAll(userId, targets) {
      assertTargetsSumToOne(targets);
      const setAt = clock.now();
      const rows: readonly StoredAllocationTarget[] = targets.map((target) => ({
        assetClass: target.assetClass,
        targetWeight: ratio(target.targetWeight),
        bandPct: target.bandPct ?? DEFAULT_BAND_PCT,
        setAt,
      }));
      byUser.set(userId, rows);
      events.push(
        AllocationTargetsChanged.create(
          { assetClasses: targets.map((target) => target.assetClass), count: targets.length },
          { userId, correlationId: newId() },
          clock,
        ),
      );
      return rows;
    },
  };
}
