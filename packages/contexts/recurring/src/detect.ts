// SPDX-License-Identifier: MIT
/**
 * `detectRecurring` — the whole engine, as one pure function.
 *
 * No database, no I/O, no wall clock. The only reading of "now" in this package
 * happens on the line below that calls `todayIn(options.clock, options.timeZone)`,
 * and the clock is injected: tests pass `fixedClock`, production passes
 * `systemClock`, and a date-dependent bug (a dormancy ladder that climbs a rung
 * at midnight UTC for a user in Los Angeles) is reproducible instead of flaky.
 *
 * The pipeline, in order, each step in its own module:
 *
 * ```
 * intake        drop pending and paired transfers            detect.ts
 * stage 1       group by (merchantId, sign, currency)        grouping.ts
 * stage 2       amount buckets -> cadence clusters -> merge  grouping.ts, amount.ts, cadence.ts
 * continuity    cross-account CARD_MIGRATION merge           migration.ts
 * modelling     amount profile, price changepoints           amount.ts, price-change.ts
 * scoring       cadence score -> confidence (+ n=2 cap)      confidence.ts
 * prediction    next due, uncertainty band, expected amount  next-due.ts
 * lifecycle     dormancy ladder (after continuity, never before)  dormancy.ts
 * typing        SUBSCRIPTION / BILL / INCOME / LOAN / …      typing.ts
 * portfolio     duplicate-service findings                   duplicate-service.ts
 * ```
 *
 * **Pending rows are dropped, not modelled.** A pending charge becomes a posted
 * charge with a different `transactionId` within a few days; counting both would
 * put a phantom second occurrence into every young stream and inflate maturity
 * exactly where the early-detection cap is trying to hold it down.
 *
 * **Paired internal transfers are dropped.** Money moving between the user's own
 * accounts is regular, fixed and monthly, and it is not a subscription. The
 * ledger already knows which rows those are.
 */

import { DateOnly, minorUnitScale, todayIn, type Clock, type CurrencyCode } from '@core/kernel';
import { profileAmounts } from './amount.ts';
import { periodDaysOf, slotOf, specOf, uncertaintyDays } from './cadence.ts';
import { scoreConfidence } from './confidence.ts';
import { assessDormancy } from './dormancy.ts';
import { detectDuplicateServices } from './duplicate-service.ts';
import { buildSegments, groupCoarse, segmentKey, type StreamSegment } from './grouping.ts';
import { isCrossSegmentMigration, migrationWithin } from './migration.ts';
import { predictNextDue } from './next-due.ts';
import { detectPriceChanges } from './price-change.ts';
import { DEFAULT_SUBSCRIPTION_MONTHLY_CEILING_MAJOR, typeStream } from './typing.ts';
import type {
  DetectionResult,
  MerchantClass,
  MerchantFacts,
  Occurrence,
  PriceChange,
  RecurringInput,
  RecurringStream,
} from './types.ts';

export interface DetectionOptions {
  /** The only source of "now". Never `Date.now()`; the lint rule forbids it. */
  readonly clock: Clock;
  /** The user's IANA zone. Period boundaries are never the container's `TZ`. */
  readonly timeZone: string;
  /** What the caller knows about each payee, keyed by `merchantId`. */
  readonly merchantFacts?: ReadonlyMap<string, MerchantFacts>;
  /** Shape-only backstop for subscription typing, in major units. */
  readonly subscriptionMonthlyCeilingMajor?: bigint;
  /**
   * 07 §2.3's tie-break: prefer the longest cadence among near-ties.
   *
   * Exposed only so the corpus harness can run the engine both ways and the
   * gate can assert which way it decided (`golden-streams.test.ts` → `'the
   * cadence tie-break decides real streams, and always towards the longer'`).
   * Production never sets it.
   */
  readonly preferLongestCadence?: boolean;
}

const NO_FACTS: MerchantFacts = Object.freeze({ class: 'UNKNOWN' as MerchantClass });

function ceilingMinor(code: CurrencyCode, major: bigint): bigint {
  return major * 10n ** BigInt(minorUnitScale(code));
}

function occurrencesOf(segment: StreamSegment): Occurrence[] {
  const fit = segment.inference.fit;
  const cadence = segment.inference.cadence;
  const spec = cadence === 'UNKNOWN' ? null : specOf(cadence);

  return segment.inputs.map((input) => {
    let residualDays: number | null = null;
    if (fit !== null && spec !== null) {
      const slotIndex = fit.matchedIndexByDate.get(input.date);
      if (slotIndex !== undefined) {
        const slot = slotOf(fit.anchorDate, spec, slotIndex, fit.dayOfMonthPair);
        residualDays = DateOnly.differenceInDays(slot, input.date);
      }
    }
    return {
      transactionId: input.transactionId,
      accountId: input.accountId,
      date: input.date,
      amount: input.amount,
      residualDays,
      duplicateOf: segment.duplicates.get(input.transactionId) ?? null,
    };
  });
}

function buildStream(
  segment: StreamSegment,
  context: {
    readonly today: DateOnly;
    readonly facts: MerchantFacts;
    readonly hasOutflowSibling: boolean;
    readonly ceilingMajor: bigint;
  },
): { stream: RecurringStream; priceChanges: PriceChange[] } {
  const key = segmentKey(segment);
  const occurrences = occurrencesOf(segment);
  const first = occurrences[0] as Occurrence;
  const last = occurrences[occurrences.length - 1] as Occurrence;
  const cadence = segment.inference.cadence;
  const fit = segment.inference.fit;
  const code = (first.amount.currency as CurrencyCode) ?? first.amount.currency;

  // Price history first: the current amount model is the model of the level the
  // stream is on *now*, not of a year that contains a $3 rise.
  const wholeProfile = segment.amount;
  const priceChanges =
    cadence === 'UNKNOWN'
      ? []
      : detectPriceChanges(occurrences, {
          streamKey: key,
          cadence,
          tolerance: wholeProfile.tolerance,
        });
  const latestChange = priceChanges[priceChanges.length - 1];
  const currentLevel =
    latestChange === undefined
      ? occurrences
      : occurrences.filter(
          (occurrence) => !DateOnly.isBefore(occurrence.date, latestChange.effectiveDate),
        );
  const profile = profileAmounts(
    (currentLevel.length > 0 ? currentLevel : occurrences).map((occurrence) => occurrence.amount),
  );
  // 07 §2.6 gates price-change detection on `amount_type == FIXED`. A utility
  // bill has no "price" to rise: it has a meter reading, and reporting a 12%
  // summer increase as a price hike is a false alarm every August.
  const emittedChanges = profile.model === 'FIXED' ? priceChanges : [];

  const anchorDate = fit?.anchorDate ?? first.date;
  const dayOfMonthPair = fit?.dayOfMonthPair ?? null;
  const residualDays = fit?.residualDays ?? [];
  const coverage = fit?.coverage ?? 0;

  const mergeProposal =
    cadence === 'UNKNOWN' ? null : migrationWithin(occurrences, periodDaysOf(cadence), key);

  const nextDue =
    cadence === 'UNKNOWN'
      ? null
      : predictNextDue({
          occurrences,
          cadence,
          anchorDate,
          dayOfMonthPair,
          residualDays,
          amountModel: profile.model,
          lastMatchedSlotIndex: fit?.matchedIndexByDate.get(last.date) ?? null,
        });

  const dormancy =
    cadence === 'UNKNOWN'
      ? { status: 'ACTIVE' as const, missedPeriods: 0 }
      : assessDormancy({
          cadence,
          anchorDate,
          dayOfMonthPair,
          lastSeen: last.date,
          uncertaintyDays: uncertaintyDays(residualDays, specOf(cadence)),
          today: context.today,
          migrationCandidate: mergeProposal !== null,
        });

  const distinctOccurrences = segment.scheduleInputs.length;
  const scored = scoreConfidence({
    cadenceScore: segment.inference.score,
    amountCv: profile.cv,
    occurrences: distinctOccurrences,
    merchantClass: context.facts.class,
    daysSinceLast: Math.max(0, DateOnly.differenceInDays(last.date, context.today)),
    periodDays: cadence === 'UNKNOWN' ? 0 : periodDaysOf(cadence),
    coverage,
  });
  const confidence =
    mergeProposal === null ? scored.confidence : scored.confidence * mergeProposal.confidenceFactor;

  const typed = typeStream({
    sign: segment.sign,
    cadence,
    cadenceScore: segment.inference.score,
    amountModel: profile.model,
    typicalAmount: profile.typical,
    occurrences: distinctOccurrences,
    merchantClass: context.facts.class,
    hasOutflowSibling: context.hasOutflowSibling,
    subscriptionMonthlyCeilingMinor: ceilingMinor(code, context.ceilingMajor),
  });

  const status =
    dormancy.status !== 'ACTIVE'
      ? dormancy.status
      : scored.earlyDetection
        ? 'EARLY_DETECTION'
        : 'ACTIVE';

  const stream: RecurringStream = {
    streamKey: key,
    merchantId: segment.merchantId,
    sign: segment.sign,
    currency: segment.currency,
    accountIds: [...new Set(occurrences.map((occurrence) => occurrence.accountId))].sort(),
    transactionIds: occurrences.map((occurrence) => occurrence.transactionId),
    occurrences,
    cadence,
    cadenceScore: segment.inference.score,
    anchorDate,
    dayOfMonthPair,
    amountModel: profile.model,
    typicalAmount: profile.typical,
    amountMad: profile.mad,
    amountCv: profile.cv,
    type: typed.type,
    status,
    confidence,
    eligibleForImpact: scored.eligibleForImpact && status !== 'CANCELED',
    firstSeen: first.date,
    lastSeen: last.date,
    missedPeriods: dormancy.missedPeriods,
    coverage,
    nextDue: status === 'CANCELED' ? null : nextDue,
    priceChanges: emittedChanges,
    mergeProposal,
    suppressions: typed.suppressions,
  };

  return { stream, priceChanges: emittedChanges };
}

/**
 * Detect every recurring stream in a set of ledger rows.
 *
 * Deterministic: the same inputs in any order produce the same streams in the
 * same order, because every grouping step sorts by content and the engine mints
 * no ids (WP 2.3 assigns identity when it persists).
 */
export function detectRecurring(
  inputs: readonly RecurringInput[],
  options: DetectionOptions,
): DetectionResult {
  const today = todayIn(options.clock, options.timeZone);
  const facts = options.merchantFacts ?? new Map<string, MerchantFacts>();
  const ceilingMajor =
    options.subscriptionMonthlyCeilingMajor ?? DEFAULT_SUBSCRIPTION_MONTHLY_CEILING_MAJOR;
  const preferLongest = options.preferLongestCadence ?? true;

  let skippedPending = 0;
  let skippedTransfers = 0;
  const usable: RecurringInput[] = [];
  for (const input of inputs) {
    if (input.pending) {
      skippedPending += 1;
      continue;
    }
    if (input.isTransfer) {
      skippedTransfers += 1;
      continue;
    }
    usable.push(input);
  }

  const groups = groupCoarse(usable);
  let amountBuckets = 0;
  const segments: StreamSegment[] = [];
  for (const group of groups) {
    let built = buildSegments(group, { preferLongest });
    amountBuckets += built.length;

    // Continuity before lifecycle: a reissued card must become one series
    // before anything downstream can call the old one a cancellation.
    let mergedAny = true;
    while (mergedAny && built.length > 1) {
      mergedAny = false;
      outer: for (let i = 0; i < built.length; i += 1) {
        for (let j = 0; j < built.length; j += 1) {
          if (i === j) continue;
          const earlier = built[i] as StreamSegment;
          const later = built[j] as StreamSegment;
          if (!isCrossSegmentMigration(earlier, later)) continue;
          const union = [...earlier.inputs, ...later.inputs];
          const rebuilt = buildSegments({ ...group, inputs: union }, { preferLongest });
          built = built.filter((_, index) => index !== i && index !== j).concat(rebuilt);
          mergedAny = true;
          break outer;
        }
      }
    }
    segments.push(...built);
  }

  const merchantsWithOutflow = new Set(
    segments
      .filter((segment) => segment.sign === 'OUTFLOW' && segment.scheduleInputs.length >= 2)
      .map((segment) => segment.merchantId),
  );

  const streams: RecurringStream[] = [];
  const priceChanges: PriceChange[] = [];
  for (const segment of segments) {
    const built = buildStream(segment, {
      today,
      facts: facts.get(segment.merchantId) ?? NO_FACTS,
      hasOutflowSibling: merchantsWithOutflow.has(segment.merchantId),
      ceilingMajor,
    });
    streams.push(built.stream);
    priceChanges.push(...built.priceChanges);
  }

  streams.sort((a, b) =>
    a.merchantId !== b.merchantId
      ? a.merchantId < b.merchantId
        ? -1
        : 1
      : a.streamKey < b.streamKey
        ? -1
        : a.streamKey > b.streamKey
          ? 1
          : 0,
  );

  return {
    streams,
    priceChanges,
    duplicateServices: detectDuplicateServices(streams, facts),
    diagnostics: {
      inputs: inputs.length,
      skippedPending,
      skippedTransfers,
      coarseGroups: groups.length,
      amountBuckets,
      streams: streams.length,
      today,
    },
  };
}
