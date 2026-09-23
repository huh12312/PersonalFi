// SPDX-License-Identifier: MIT
/**
 * Drift against a target allocation, on an **absolute 5-percentage-point
 * band** — 07's I1 trigger, `|actual_weight − target_weight| > 5pp`.
 *
 * ## Absolute, not relative, and why the distinction is the whole rule
 *
 * A relative band ("more than 25% away from target") fires constantly on small
 * sleeves: a 4% commodity target sitting at 5.2% is 30% off relative and
 * 1.2 points off absolute, and nobody should trade on it. An absolute band
 * fires on the sleeves where a trade is worth its tax cost. 07 §4.3's I1 row
 * is written in points, so points is what {@link DRIFT_BAND_POINTS} is, and
 * the comparison is made against a {@link Points} value rather than a ratio —
 * a 100× unit slip between `0.05` and `5` is silent in every other respect.
 *
 * The boundary is *strictly greater than* 5 points, as I1 is written (`> 5pp`).
 * `'a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade'`
 * pins both sides; a gap of exactly 5.0 proposes nothing, and that is a
 * decision, not an accident.
 *
 * ## The proposal is a size, not an instruction
 *
 * `direction` and `amount` say *"this sleeve is $5,100 above its target"*.
 * They do not name a security, do not say buy or sell, and nothing downstream
 * may render them as an instruction: 07 §7.2's banned-copy list (`\bbuy\b`,
 * `\bsell\b`) is enforced on the insight templates that consume this, and the
 * rebalance framing 07 asks for — *"prefer new contributions and
 * tax-advantaged accounts"* — belongs to the advisor rule (WP 3.10), which
 * also pairs the proposal with its tax cost. This module answers "how far
 * off?" and "by how much?" and stops.
 *
 * ## Noise, named
 *
 * 07 §4.3: *"If 18% of the portfolio is unclassified, a '7pp drift' claim is
 * noise, and rule I1 must suppress itself when `unclassified_pct > 10%`."*
 * This module does not suppress on `unclassifiedPct` — suppression is the
 * rule's decision and lives with the rule — but it returns `unclassifiedPct`
 * and the `noisy` flag that makes the decision one comparison rather than a
 * re-derivation.
 *
 * It *does* withhold proposals for a different reason: when a holding could
 * not be valued at all (a STALE price under `as_of_now`, or no price), the
 * denominator is arithmetically incomplete and every sleeve's weight is wrong
 * by an unknown amount. A bond sleeve whose only fund has a stale price reads
 * as 0%, which is a 45-point "drift" and a five-figure trade proposed against
 * a number that does not exist. So `proposalsWithheld` is set, `proposals` is
 * empty, and the rows are still returned with their gaps so the UI can show
 * the drift *and* the reason it is not actionable. `excluded` names the
 * holdings, so the fix is a price refresh rather than a mystery.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { AssetClass } from '../../schema/index.ts';
import { allocationOf, valueHoldings, weightOf, type AllocationReport } from './allocation.ts';
import {
  AnalyticsInputError,
  POINTS_ZERO,
  RATIO_ONE,
  RATIO_ZERO,
  absolutePoints,
  comparePoints,
  points,
  pointsBetween,
  ratioToPoints,
  scaleMoney,
  subtractRatio,
  sumRatios,
  type AnalyticsHolding,
  type ExcludedHolding,
  type Points,
  type Ratio,
  type ValuationOptions,
} from './types.ts';

/** 07 I1: `|actual − target| > 5pp`. Absolute points, not a relative fraction. */
export const DRIFT_BAND_POINTS: Points = points('5');

/**
 * 07 §4.3's normative threshold for "this allocation number is noise".
 *
 * Returned as a flag here; acted on by WP 3.10's I1, which is the rule that
 * must suppress itself.
 */
export const UNCLASSIFIED_NOISE_THRESHOLD: Points = points('10');

/** Tolerance on "the targets sum to 100%": one hundredth of a point. */
const TARGET_SUM_TOLERANCE = points('0.01');

export interface AllocationTarget {
  readonly assetClass: AssetClass;
  readonly targetWeight: Ratio;
}

export type DriftDirection = 'increase' | 'reduce';

export interface RebalanceProposal {
  readonly assetClass: AssetClass;
  /** `actual − target`, signed, in points. */
  readonly gapPoints: Points;
  readonly direction: DriftDirection;
  /** `|target − actual| × total`, rounded once, half-even. Never a `number`. */
  readonly amount: MoneyType;
}

export interface DriftRow {
  readonly assetClass: AssetClass;
  readonly actualWeight: Ratio;
  readonly targetWeight: Ratio;
  readonly actualValue: MoneyType;
  /** `actual − target`, signed, in points. Positive = overweight. */
  readonly gapPoints: Points;
  /** `|gap| ≤ 5pp`. The band is absolute and the comparison is one place. */
  readonly insideBand: boolean;
  readonly proposal: RebalanceProposal | null;
}

export const PROPOSAL_WITHHELD_REASONS = ['incomplete_valuation'] as const;
export type ProposalWithheldReason = (typeof PROPOSAL_WITHHELD_REASONS)[number];

export interface DriftReport {
  readonly total: MoneyType;
  readonly rows: readonly DriftRow[];
  /**
   * The rows outside the band, in descending order of absolute gap — **empty
   * whenever `proposalsWithheld` is set**, because a trade size computed over
   * a portfolio we could not fully value is a confident wrong number.
   */
  readonly proposals: readonly RebalanceProposal[];
  /** Why no proposal is offered despite the gaps. `null` when they are offered. */
  readonly proposalsWithheld: ProposalWithheldReason | null;
  readonly bandPoints: Points;
  /** 07 §4.3: beside every drift number, always. */
  readonly unclassifiedPct: Ratio;
  /** `unclassifiedPct > 10%` — the input to I1's self-suppression. */
  readonly noisy: boolean;
  readonly excluded: readonly ExcludedHolding[];
  readonly allocation: AllocationReport;
}

/**
 * Drift of an actual allocation against a target set.
 *
 * Targets must cover the portfolio: they are required to sum to 100% (within a
 * hundredth of a point) because a target set that sums to 90% makes every
 * sleeve look overweight by construction, and the resulting drift would be an
 * artefact of the input rather than a fact about the portfolio.
 *
 * An asset class present in the portfolio but absent from the targets is
 * reported with a target of 0% — that is a real drift and hiding it would hide
 * the position the user forgot to plan for.
 */
export function driftAgainstTargets(
  holdings: readonly AnalyticsHolding[],
  targets: readonly AllocationTarget[],
  options: ValuationOptions,
): DriftReport {
  assertTargetsSumToOne(targets);
  const set = valueHoldings(holdings, options);
  const allocation = allocationOf('asset_class', set, options);

  const targetByClass = new Map(targets.map((target) => [target.assetClass, target.targetWeight]));
  const classes = new Set<AssetClass>([
    ...targets.map((target) => target.assetClass),
    ...allocation.slices.map((slice) => slice.key as AssetClass),
  ]);

  const rows: DriftRow[] = [];
  for (const assetClass of classes) {
    const actualWeight = weightOf(allocation, assetClass);
    const targetWeight = targetByClass.get(assetClass) ?? RATIO_ZERO;
    const actualValue =
      allocation.slices.find((slice) => slice.key === assetClass)?.value ??
      Money.zero(allocation.currency);
    const gapPoints = pointsBetween(actualWeight, targetWeight);
    const insideBand = comparePoints(absolutePoints(gapPoints), DRIFT_BAND_POINTS) <= 0;

    rows.push({
      assetClass,
      actualWeight,
      targetWeight,
      actualValue,
      gapPoints,
      insideBand,
      proposal: insideBand
        ? null
        : {
            assetClass,
            gapPoints,
            direction: gapPoints.startsWith('-') ? 'increase' : 'reduce',
            // `|target − actual| × total`: the dollars between here and plan.
            amount: absoluteMoney(
              scaleMoney(allocation.total, subtractRatio(targetWeight, actualWeight)),
            ),
          },
    });
  }

  rows.sort((a, b) => {
    const byGap = comparePoints(absolutePoints(b.gapPoints), absolutePoints(a.gapPoints));
    return byGap !== 0 ? byGap : a.assetClass < b.assetClass ? -1 : 1;
  });

  const proposalsWithheld: ProposalWithheldReason | null =
    set.excluded.length > 0 ? 'incomplete_valuation' : null;

  return {
    total: allocation.total,
    rows,
    proposals:
      proposalsWithheld === null
        ? rows
            .map((row) => row.proposal)
            .filter((proposal): proposal is RebalanceProposal => proposal !== null)
        : [],
    proposalsWithheld,
    bandPoints: DRIFT_BAND_POINTS,
    unclassifiedPct: allocation.unclassifiedPct,
    noisy:
      comparePoints(ratioToPoints(allocation.unclassifiedPct), UNCLASSIFIED_NOISE_THRESHOLD) > 0,
    excluded: set.excluded,
    allocation,
  };
}

function absoluteMoney(amount: MoneyType): MoneyType {
  return Money.isNegative(amount) ? Money.negate(amount) : amount;
}

function assertTargetsSumToOne(targets: readonly AllocationTarget[]): void {
  if (targets.length === 0) {
    throw new AnalyticsInputError('drift needs a target allocation to measure against');
  }
  const seen = new Set<AssetClass>();
  for (const target of targets) {
    if (seen.has(target.assetClass)) {
      throw new AnalyticsInputError(`two targets for ${target.assetClass}`);
    }
    seen.add(target.assetClass);
  }
  const total = sumRatios(targets.map((target) => target.targetWeight));
  const gap = absolutePoints(pointsBetween(total, RATIO_ONE));
  if (comparePoints(gap, TARGET_SUM_TOLERANCE) > 0) {
    throw new AnalyticsInputError(
      `targets sum to ${total}, not 1; every sleeve would drift by the shortfall`,
    );
  }
}

/** Zero points, exported so a caller need not construct one to compare against. */
export const NO_DRIFT: Points = POINTS_ZERO;
