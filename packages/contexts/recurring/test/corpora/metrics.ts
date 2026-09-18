// SPDX-License-Identifier: MIT
/**
 * The evaluation harness of 07 §2.12.
 *
 * **Stream matching rule, verbatim:** a predicted stream `P` matches a gold
 * stream `G` iff the merchant matches **and** `Jaccard(txn_ids(P), txn_ids(G))
 * ≥ 0.5`. Matching on the merchant alone would let a detector that split one
 * subscription into four quarters score four matches; the Jaccard floor is what
 * makes "found it" mean "found most of it".
 *
 * Precision is weighted far above recall (07 §2.12), so the operating point is
 * swept rather than assumed: `operatingPoint` walks the confidence threshold and
 * returns the **highest recall at which precision is still ≥ 0.95**. That
 * number, not a hand-picked constant, is what the golden gate asserts.
 */

import { DateOnly, fixedClock } from '@core/kernel';
import {
  RECURRING_TYPES,
  detectRecurring,
  periodDaysOf,
  type DetectionResult,
  type MerchantFacts,
  type RecurringInput,
  type RecurringStream,
} from '../../src/index.ts';
import type { Corpus, GoldStream } from './synthetic.ts';

export const JACCARD_FLOOR = 0.5;

export function clockAt(date: DateOnly) {
  return fixedClock(`${date}T12:00:00Z`);
}

export function runDetection(
  inputs: readonly RecurringInput[],
  facts: ReadonlyMap<string, MerchantFacts>,
  today: DateOnly,
  options: {
    readonly preferLongestCadence?: boolean;
    readonly subscriptionMonthlyCeilingMajor?: bigint;
  } = {},
): DetectionResult {
  return detectRecurring(inputs, {
    clock: clockAt(today),
    timeZone: 'UTC',
    merchantFacts: facts,
    ...options,
  });
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function surfacedStreams(
  result: DetectionResult,
  threshold: number,
): RecurringStream[] {
  return result.streams.filter(
    (stream) => RECURRING_TYPES.has(stream.type) && stream.confidence >= threshold,
  );
}

export function goldRecurring(gold: readonly GoldStream[]): GoldStream[] {
  return gold.filter((stream) => stream.expectedTypes.some((type) => RECURRING_TYPES.has(type)));
}

export interface MatchPair {
  readonly predicted: RecurringStream;
  readonly gold: GoldStream;
  readonly jaccard: number;
}

export interface MatchResult {
  readonly matches: readonly MatchPair[];
  readonly falsePositives: readonly RecurringStream[];
  readonly missed: readonly GoldStream[];
  readonly precision: number;
  readonly recall: number;
}

export function match(
  predicted: readonly RecurringStream[],
  gold: readonly GoldStream[],
): MatchResult {
  const matches: MatchPair[] = [];
  const takenGold = new Set<string>();
  const falsePositives: RecurringStream[] = [];

  for (const stream of predicted) {
    let best: MatchPair | null = null;
    for (const candidate of gold) {
      if (takenGold.has(candidate.goldId)) continue;
      if (candidate.merchantId !== stream.merchantId) continue;
      const overlap = jaccard(stream.transactionIds, candidate.transactionIds);
      if (overlap < JACCARD_FLOOR) continue;
      if (best === null || overlap > best.jaccard) {
        best = { predicted: stream, gold: candidate, jaccard: overlap };
      }
    }
    if (best === null) falsePositives.push(stream);
    else {
      takenGold.add(best.gold.goldId);
      matches.push(best);
    }
  }

  return {
    matches,
    falsePositives,
    missed: gold.filter((candidate) => !takenGold.has(candidate.goldId)),
    precision: predicted.length === 0 ? 1 : matches.length / predicted.length,
    recall: gold.length === 0 ? 1 : matches.length / gold.length,
  };
}

export interface CurvePoint {
  readonly threshold: number;
  readonly precision: number;
  readonly recall: number;
  readonly predicted: number;
  readonly matched: number;
}

export function precisionRecallCurve(
  result: DetectionResult,
  gold: readonly GoldStream[],
  thresholds: readonly number[],
): CurvePoint[] {
  const target = goldRecurring(gold);
  return thresholds.map((threshold) => {
    const predicted = surfacedStreams(result, threshold);
    const outcome = match(predicted, target);
    return {
      threshold,
      precision: outcome.precision,
      recall: outcome.recall,
      predicted: predicted.length,
      matched: outcome.matches.length,
    };
  });
}

export const DEFAULT_THRESHOLDS: readonly number[] = Array.from(
  { length: 46 },
  (_, index) => Math.round((0.5 + index * 0.01) * 100) / 100,
);

/** 07 §2.12: the highest recall at which precision is still ≥ 0.95. */
export function operatingPoint(curve: readonly CurvePoint[], minPrecision = 0.95): CurvePoint {
  const eligible = curve.filter((point) => point.precision >= minPrecision);
  if (eligible.length === 0) {
    return curve[curve.length - 1] as CurvePoint;
  }
  return eligible.reduce((best, point) =>
    point.recall > best.recall
      ? point
      : point.recall === best.recall && point.precision > best.precision
        ? point
        : best,
  );
}

export interface Metrics {
  readonly threshold: number;
  readonly precision: number;
  readonly recall: number;
  readonly cadenceAccuracy: number;
  readonly nextDueMaeDays: number;
  readonly nextDueMaeMonthlyDays: number;
  readonly nextDueMaeAnnualDays: number;
  readonly amountMape: number;
  readonly priceChangePrecision: number;
  readonly priceChangeRecall: number;
  readonly cancellationLeadPeriods: number;
  /** The first user-visible rung: "we haven't seen a charge since…". */
  readonly atRiskLeadPeriods: number;
  readonly matched: number;
  readonly predicted: number;
  readonly goldCount: number;
  readonly falsePositives: readonly RecurringStream[];
  readonly missed: readonly GoldStream[];
}

/**
 * How long after the true last charge does the ladder first read
 * `LIKELY_CANCELED`? Measured by re-running detection on that merchant's rows
 * alone at weekly steps — the engine is pure, so "what would it have said last
 * Tuesday?" is just another call with another clock.
 */
export function cancellationLeadDays(
  corpus: Corpus,
  gold: GoldStream,
  rung: 'AT_RISK' | 'LIKELY_CANCELED' = 'LIKELY_CANCELED',
): number | null {
  const rows = corpus.inputs.filter((input) => input.merchantId === gold.merchantId);
  if (rows.length === 0) return null;
  const lastCharge = rows
    .map((input) => input.date)
    .reduce((latest, date) => (DateOnly.isAfter(date, latest) ? date : latest));

  for (let day = 0; day <= 420; day += 7) {
    const today = DateOnly.addDays(lastCharge, day);
    if (DateOnly.isAfter(today, DateOnly.addDays(corpus.today, 200))) break;
    const result = runDetection(rows, corpus.facts, today);
    const stream = result.streams.find((candidate) =>
      candidate.transactionIds.some((id) => gold.transactionIds.includes(id)),
    );
    if (stream === undefined) continue;
    if (rung === 'AT_RISK' && stream.status === 'AT_RISK') return day;
    if (stream.status === 'LIKELY_CANCELED' || stream.status === 'CANCELED') return day;
  }
  return null;
}

export function evaluate(corpus: Corpus, result: DetectionResult, threshold: number): Metrics {
  const target = goldRecurring(corpus.gold);
  const predicted = surfacedStreams(result, threshold);
  const outcome = match(predicted, target);

  const cadenceHits = outcome.matches.filter(
    (pair) => pair.predicted.cadence === pair.gold.cadence,
  ).length;

  const dueErrors: Array<{ days: number; cadence: string }> = [];
  for (const pair of outcome.matches) {
    if (pair.gold.trueNextDue === null || pair.predicted.nextDue === null) continue;
    dueErrors.push({
      days: Math.abs(DateOnly.differenceInDays(pair.gold.trueNextDue, pair.predicted.nextDue.date)),
      cadence: pair.gold.cadence,
    });
  }
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const fixedPairs = outcome.matches.filter((pair) => pair.gold.amountModel === 'FIXED');
  const mape = mean(
    fixedPairs.map((pair) => {
      const expected = Number(
        pair.gold.finalAmountMinor < 0n ? -pair.gold.finalAmountMinor : pair.gold.finalAmountMinor,
      );
      const actual = Number(
        pair.predicted.typicalAmount.minor < 0n
          ? -pair.predicted.typicalAmount.minor
          : pair.predicted.typicalAmount.minor,
      );
      return expected === 0 ? 0 : Math.abs(actual - expected) / expected;
    }),
  );

  const goldChanges = corpus.gold.flatMap((stream) =>
    stream.priceChanges.map((change) => ({ merchantId: stream.merchantId, ...change })),
  );
  const predictedChanges = result.priceChanges.filter((change) =>
    predicted.some((stream) => stream.streamKey === change.streamKey),
  );
  const changeMatched = goldChanges.filter((goldChange) =>
    predictedChanges.some((change) => {
      const stream = predicted.find((candidate) => candidate.streamKey === change.streamKey);
      return (
        stream?.merchantId === goldChange.merchantId &&
        Math.abs(DateOnly.differenceInDays(goldChange.effectiveDate, change.effectiveDate)) <= 3
      );
    }),
  ).length;

  const leadsFor = (rung: 'AT_RISK' | 'LIKELY_CANCELED'): number[] =>
    corpus.gold
      .filter((stream) => stream.dormant)
      .map((stream) => {
        const days = cancellationLeadDays(corpus, stream, rung);
        return days === null ? null : days / periodDaysOf(stream.cadence);
      })
      .filter((value): value is number => value !== null);
  const leads = leadsFor('LIKELY_CANCELED');
  const atRiskLeads = leadsFor('AT_RISK');

  return {
    threshold,
    precision: outcome.precision,
    recall: outcome.recall,
    cadenceAccuracy: outcome.matches.length === 0 ? 0 : cadenceHits / outcome.matches.length,
    nextDueMaeDays: mean(dueErrors.map((error) => error.days)),
    nextDueMaeMonthlyDays: mean(
      dueErrors.filter((error) => error.cadence === 'MONTHLY').map((error) => error.days),
    ),
    nextDueMaeAnnualDays: mean(
      dueErrors.filter((error) => error.cadence === 'ANNUAL').map((error) => error.days),
    ),
    amountMape: mape,
    priceChangePrecision:
      predictedChanges.length === 0 ? 1 : changeMatched / predictedChanges.length,
    priceChangeRecall: goldChanges.length === 0 ? 1 : changeMatched / goldChanges.length,
    cancellationLeadPeriods: mean(leads),
    atRiskLeadPeriods: mean(atRiskLeads),
    matched: outcome.matches.length,
    predicted: predicted.length,
    goldCount: target.length,
    falsePositives: outcome.falsePositives,
    missed: outcome.missed,
  };
}
