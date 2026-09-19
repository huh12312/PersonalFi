// SPDX-License-Identifier: MIT
/**
 * Policy: what a detection pass is allowed to conclude, and what only a human
 * may decide.
 *
 * `store.ts` writes rows and decides nothing; the engine (`detect.ts`) scores
 * and decides nothing either. This file is the only place the two meet, and it
 * exists because the interesting rules of this context are neither SQL nor
 * arithmetic — they are about *authority*.
 *
 * ## The three rules, stated once
 *
 *   1. **A rejection is permanent, and it is enforced on the input side.**
 *      `loadOverrides` runs before a single transaction is read, and a rejected
 *      merchant's rows are then never fetched, never grouped and never scored.
 *      Filtering the engine's *output* would be one `if` away from a second
 *      caller that forgets it; filtering its input makes "a rejected merchant
 *      never returns as a candidate" a property of the pipeline's shape rather
 *      than of anybody's diligence.
 *   2. **A confirmed series is pinned.** `user_confirmed` is written by this
 *      file and never by a detection pass. The sweep that archives streams the
 *      detector no longer sees skips confirmed rows, `upsertSeries` refuses to
 *      lower their state, and `recurring_series_confirmed_not_archived` makes a
 *      future pass that forgets both unable to commit.
 *   3. **Nothing is announced twice.** Detection is a pure function of current
 *      state, so a replay re-derives every stream. Every event below is
 *      therefore emitted from a transition computed against what was already in
 *      the database — a candidate row that *inserted*, a status that *moved*, a
 *      `price_change_events` row that was *new*. `test/db/idempotence.test.ts`
 *      compares whole rows and the `domain_events` count across two runs.
 *
 * ## Why detection never creates a merchant (decision D25)
 *
 * There is no code path here that could. The only reader is `LedgerPort`, which
 * has no write method at all (see its header), the engine takes a `merchantId`
 * and has never seen a descriptor, and `scripts/check-schema-ownership.ts`
 * refuses any non-test file in this package that names `merchants` in SQL.
 * `test/db/no-merchant-creation.test.ts` asserts the outcome — row count *and*
 * ids unchanged across a full pass — and the evidence note records the sabotage
 * that proves the assertion can go red.
 */
import { DateOnly, Money, todayIn } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { AUTO_CONFIRM_CONFIDENCE, CANDIDATE_CONFIDENCE } from './confidence.ts';
import { detectRecurring } from './detect.ts';
import {
  CandidateProposed,
  DuplicateServiceDetected,
  PriceChangeDetected,
  SeriesConfirmed,
  SeriesLapsed,
} from './events.ts';
import { collectForRecurring, type LedgerPort } from './ledger-port.ts';
import {
  decideCandidate,
  loadCandidateById,
  loadCandidates,
  loadMerchantFacts,
  loadOverrides,
  loadSeries,
  loadSeriesForMerchants,
  lockUserDetection,
  markSeriesArchived,
  outboxOf,
  proposeCandidate,
  recordRejection,
  setDuplicateFinding,
  setSeriesConfirmed,
  setSeriesMerged,
  syncOccurrences,
  unpinAndArchiveSeries,
  upsertMetadata,
  upsertPriceChange,
  upsertSeries,
  type MetadataPatch,
  type OccurrenceValues,
  type RecurringContext,
  type RecurringDatabase,
  type RecurringExecutor,
  type SeriesValues,
  type SourceEntry,
} from './store.ts';
import { RECURRING_TYPES } from './typing.ts';
import type {
  OverrideScope,
  RecurringSeriesRow,
  SubscriptionMetadataRow,
} from '../schema/index.ts';
import type { DuplicateServiceFinding, RecurringInput, RecurringStream } from './types.ts';

/**
 * Stamped onto every row this detector writes, and onto its `sources[]` entry.
 *
 * Bumped when the engine's output for unchanged input would change, which is
 * the only thing that makes a stored series stale. It is deliberately *not* the
 * package version: a docstring fix is not a re-detection.
 */
export const DETECTION_VERSION = 'local_detector@2';

/** ~25 months. Long enough for two ANNUAL occurrences, which is the longest cadence that needs two. */
export const DEFAULT_HISTORY_DAYS = 760;

export interface RecurringDependencies {
  readonly port: LedgerPort;
}

export interface DetectionRunInput {
  /** The user's IANA zone. Never the container's `TZ`. */
  readonly timeZone: string;
  /**
   * Scope the pass to these payees, or `null`/absent for every payee.
   *
   * The consumer always passes a list — re-running detection for every merchant
   * on every sync page is a full-history scan per page — and the "re-detect
   * everything" button passes `null`.
   */
  readonly merchantIds?: readonly string[] | null;
  readonly historyDays?: number;
  readonly subscriptionMonthlyCeilingMajor?: bigint;
}

export interface DetectionRunResult {
  readonly merchantsScoped: number | null;
  readonly merchantsSkippedByOverride: number;
  readonly inputs: number;
  readonly streams: number;
  readonly seriesInserted: number;
  readonly seriesChanged: number;
  readonly seriesArchived: number;
  readonly candidatesProposed: number;
  readonly autoConfirmed: number;
  readonly lapsed: number;
  readonly priceChanges: number;
  readonly duplicateGroups: number;
  readonly eventsAppended: number;
}

const EMPTY_RESULT: DetectionRunResult = Object.freeze({
  merchantsScoped: 0,
  merchantsSkippedByOverride: 0,
  inputs: 0,
  streams: 0,
  seriesInserted: 0,
  seriesChanged: 0,
  seriesArchived: 0,
  candidatesProposed: 0,
  autoConfirmed: 0,
  lapsed: 0,
  priceChanges: 0,
  duplicateGroups: 0,
  eventsAppended: 0,
});

/** 07 §2.8's ladder, below the top rung. A transition onto one of these lapses. */
const LAPSED_STATUSES = new Set(['AT_RISK', 'MIGRATED', 'LIKELY_CANCELED', 'CANCELED']);

function sourceEntry(now: Date, confidence: number): SourceEntry {
  return {
    source: 'local_detector',
    version: DETECTION_VERSION,
    at: now.toISOString(),
    confidence,
  };
}

function seriesValuesOf(stream: RecurringStream): SeriesValues {
  let min = stream.typicalAmount.minor;
  let max = stream.typicalAmount.minor;
  for (const occurrence of stream.occurrences) {
    if (occurrence.amount.minor < min) min = occurrence.amount.minor;
    if (occurrence.amount.minor > max) max = occurrence.amount.minor;
  }

  return {
    streamKey: stream.streamKey,
    merchantId: stream.merchantId,
    sign: stream.sign,
    currency: stream.currency,
    accountIds: [...stream.accountIds].sort(),
    cadence: stream.cadence,
    cadenceScore: stream.cadenceScore,
    anchorDate: stream.anchorDate,
    dayOfMonthPair: stream.dayOfMonthPair,
    amountModel: stream.amountModel,
    typicalAmount: stream.typicalAmount,
    amountMad: stream.amountMad,
    amountCv: stream.amountCv,
    observedMinMinor: min,
    observedMaxMinor: max,
    type: stream.type,
    status: stream.status,
    confidence: stream.confidence,
    eligibleForImpact: stream.eligibleForImpact,
    firstSeen: stream.firstSeen,
    lastSeen: stream.lastSeen,
    missedPeriods: stream.missedPeriods,
    coverage: stream.coverage,
    nextDue:
      stream.nextDue === null
        ? null
        : {
            date: stream.nextDue.date,
            uncertaintyDays: stream.nextDue.uncertaintyDays,
            amount: stream.nextDue.expectedAmount,
          },
    // Plain JSON, and arrays stay arrays: `suppressions` carries a
    // `jsonb_typeof(...) = 'array'` CHECK, so an object here fails at the
    // database rather than at a reader six weeks later.
    suppressions: stream.suppressions.map((suppression) => ({ ...suppression })),
    mergeProposal:
      stream.mergeProposal === null
        ? null
        : { ...stream.mergeProposal, segmentKeys: [...stream.mergeProposal.segmentKeys] },
    detectionVersion: DETECTION_VERSION,
  };
}

function occurrenceValuesOf(stream: RecurringStream): OccurrenceValues[] {
  return stream.occurrences.map((occurrence) => ({
    transactionId: occurrence.transactionId,
    accountId: occurrence.accountId,
    date: occurrence.date,
    amount: occurrence.amount,
    residualDays: occurrence.residualDays,
    duplicateOf: occurrence.duplicateOf,
  }));
}

function sameKeys(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * One detection pass, inside one transaction.
 *
 * Everything is a single transaction on purpose: the series, its occurrences,
 * the candidate question it raises and the event that announces it either all
 * land or none of them do. A pass that wrote the series and then failed before
 * the event would leave a subscription nobody was ever asked about.
 */
export async function runDetection(
  database: RecurringDatabase,
  context: RecurringContext,
  dependencies: RecurringDependencies,
  input: DetectionRunInput,
): Promise<DetectionRunResult> {
  return database.transaction(async (tx) => {
    await lockUserDetection(tx, context.userId);
    const now = context.clock.now();
    const today = todayIn(context.clock, input.timeZone);
    const outbox = outboxOf(tx);

    // Rule 1: the rejections, first, before one transaction is read.
    const overrides = await loadOverrides(tx, context.userId);

    const requested =
      input.merchantIds === undefined || input.merchantIds === null
        ? null
        : [...new Set(input.merchantIds)].sort();
    let skippedByOverride = 0;
    let scope: string[] | null = requested;
    if (requested !== null) {
      scope = requested.filter((merchantId) => !overrides.merchants.has(merchantId));
      skippedByOverride = requested.length - scope.length;
      if (scope.length === 0) {
        return {
          ...EMPTY_RESULT,
          merchantsScoped: 0,
          merchantsSkippedByOverride: skippedByOverride,
        };
      }
    }

    const dateFrom = DateOnly.addDays(today, -(input.historyDays ?? DEFAULT_HISTORY_DAYS));
    const rows = await collectForRecurring(dependencies.port, {
      userId: context.userId,
      ...(scope === null ? {} : { merchantIds: scope }),
      dateFrom,
    });

    const inputs: RecurringInput[] = [];
    for (const row of rows) {
      // A row whose merchant identity the ledger refused is not a stream this
      // context can express, and a rejected merchant's rows never reach the
      // engine even on an unscoped pass.
      if (row.merchantId === null) continue;
      if (overrides.merchants.has(row.merchantId)) continue;
      inputs.push({
        transactionId: row.id,
        merchantId: row.merchantId,
        accountId: row.accountId,
        amount: row.amount,
        date: row.date,
        pending: row.pending,
        isTransfer: row.isTransfer,
      });
    }

    const facts = await loadMerchantFacts(tx, context.userId);
    const detection = detectRecurring(inputs, {
      clock: context.clock,
      timeZone: input.timeZone,
      merchantFacts: facts,
      ...(input.subscriptionMonthlyCeilingMajor === undefined
        ? {}
        : { subscriptionMonthlyCeilingMajor: input.subscriptionMonthlyCeilingMajor }),
    });

    // `ONE_OFF` and `FREQUENT_MERCHANT` are the engine's way of saying "not a
    // stream". Persisting them would put every coffee shop in the forecast
    // table and make the candidate queue a list of everywhere the user shops.
    const streams = detection.streams.filter(
      (stream) => RECURRING_TYPES.has(stream.type) && !overrides.streamKeys.has(stream.streamKey),
    );

    const existingSeries = await loadSeriesForMerchants(tx, context.userId, scope);
    const seriesByKey = new Map(existingSeries.map((row) => [row.streamKey, row]));
    const candidateRows = await loadCandidates(
      tx,
      context.userId,
      streams.map((stream) => stream.streamKey),
    );
    const candidatesByKey = new Map(candidateRows.map((row) => [row.streamKey, row]));

    let inserted = 0;
    let changed = 0;
    let proposed = 0;
    let autoConfirmed = 0;
    let lapsed = 0;
    let priceChanges = 0;
    let events = 0;
    const writtenByKey = new Map<string, RecurringSeriesRow>();

    for (const stream of streams) {
      const existing = seriesByKey.get(stream.streamKey) ?? null;
      const autoConfirm = stream.confidence >= AUTO_CONFIRM_CONFIDENCE;
      const write = await upsertSeries(tx, context, seriesValuesOf(stream), {
        existing,
        autoConfirmed: autoConfirm,
        sources: [sourceEntry(now, stream.confidence)],
      });
      writtenByKey.set(stream.streamKey, write.row);
      if (write.inserted) inserted += 1;
      else if (write.changed) changed += 1;

      await syncOccurrences(tx, context, write.row.id, occurrenceValuesOf(stream));

      // --- the candidate question ---------------------------------------
      //
      // Asked once, and only for a stream nobody has ruled on. A row in
      // `recurring_candidates` — in *any* state — is either a question already
      // on the user's screen or an answer that outranks this pass.
      const candidate = candidatesByKey.get(stream.streamKey) ?? null;
      if (!write.row.userConfirmed && !autoConfirm && stream.confidence >= CANDIDATE_CONFIDENCE) {
        const proposal = await proposeCandidate(
          tx,
          context,
          {
            merchantId: stream.merchantId,
            streamKey: stream.streamKey,
            seriesId: write.row.id,
            cadence: stream.cadence,
            type: stream.type,
            confidence: stream.confidence,
            amount: stream.typicalAmount,
            sources: [sourceEntry(now, stream.confidence)],
          },
          candidate,
        );
        if (proposal.inserted) {
          proposed += 1;
          await appendEvent(
            outbox,
            CandidateProposed.create(
              {
                candidateId: proposal.row.id,
                seriesId: write.row.id,
                merchantId: stream.merchantId,
                cadence: stream.cadence,
                type: stream.type,
                confidence: stream.confidence,
                occurrenceCount: stream.occurrences.length,
              },
              {
                userId: context.userId,
                aggregateId: write.row.id,
                correlationId: context.correlationId,
                causationId: context.causationId ?? null,
              },
              context.clock,
            ),
          );
          events += 1;
        }
      }

      // --- auto-confirmation, as a transition ---------------------------
      const becameActive =
        write.row.state === 'ACTIVE' &&
        !write.row.userConfirmed &&
        (write.previous === null || write.previous.state !== 'ACTIVE');
      if (becameActive) {
        autoConfirmed += 1;
        await appendEvent(
          outbox,
          SeriesConfirmed.create(
            {
              seriesId: write.row.id,
              merchantId: stream.merchantId,
              candidateId: candidate?.id ?? null,
              source: 'auto',
              userConfirmed: false,
            },
            {
              userId: context.userId,
              aggregateId: write.row.id,
              correlationId: context.correlationId,
              causationId: context.causationId ?? null,
            },
            context.clock,
          ),
        );
        events += 1;
      }

      // --- the dormancy ladder, as a transition -------------------------
      //
      // Never on an insert: a stream we are meeting for the first time and that
      // already looks dead was never alive as far as this system is concerned,
      // and "you may have cancelled X" about something it has never mentioned
      // before is noise.
      if (
        write.previous !== null &&
        write.previous.status !== write.row.status &&
        LAPSED_STATUSES.has(write.row.status)
      ) {
        lapsed += 1;
        await appendEvent(
          outbox,
          SeriesLapsed.create(
            {
              seriesId: write.row.id,
              merchantId: stream.merchantId,
              status: write.row.status as 'AT_RISK' | 'MIGRATED' | 'LIKELY_CANCELED' | 'CANCELED',
              previousStatus: write.previous.status,
              missedPeriods: stream.missedPeriods,
              lastSeen: stream.lastSeen,
            },
            {
              userId: context.userId,
              aggregateId: write.row.id,
              correlationId: context.correlationId,
              causationId: context.causationId ?? null,
            },
            context.clock,
          ),
        );
        events += 1;
      }

      // --- price changes ------------------------------------------------
      for (const change of stream.priceChanges) {
        const result = await upsertPriceChange(tx, context, {
          seriesId: write.row.id,
          direction: change.direction,
          effectiveDate: change.effectiveDate,
          from: change.from,
          to: change.to,
          delta: change.delta,
          annualImpact: change.annualImpact,
          confirmed: change.confirmed,
          priorTransactionIds: change.priorTransactionIds,
          recentTransactionIds: change.recentTransactionIds,
        });
        if (!result.inserted && !result.newlyConfirmed) continue;
        priceChanges += 1;
        await appendEvent(
          outbox,
          PriceChangeDetected.create(
            {
              priceChangeEventId: result.row.id,
              seriesId: write.row.id,
              merchantId: stream.merchantId,
              direction: change.direction,
              effectiveDate: change.effectiveDate,
              confirmed: result.row.confirmed,
              annualImpactMinor: Money.absolute(change.annualImpact).minor.toString(),
              currency: change.annualImpact.currency,
            },
            {
              userId: context.userId,
              aggregateId: write.row.id,
              correlationId: context.correlationId,
              causationId: context.causationId ?? null,
            },
            context.clock,
          ),
        );
        events += 1;
      }
    }

    // --- duplicate-service findings ---------------------------------------
    const duplicates = await syncDuplicateFindings(tx, context, {
      findings: detection.duplicateServices,
      writtenByKey,
      scopedSeries: existingSeries,
    });
    events += duplicates.events;

    // --- the archive sweep -------------------------------------------------
    //
    // A series the detector no longer proposes is archived, *unless* the user
    // confirmed it (rule 2). `markSeriesArchived` repeats that condition in its
    // WHERE clause and the schema repeats it again as a CHECK; three layers,
    // because this is the one place a pass could silently undo a human.
    let archived = 0;
    for (const row of existingSeries) {
      if (writtenByKey.has(row.streamKey)) continue;
      if (row.userConfirmed) continue;
      if (row.state === 'ARCHIVED') continue;
      await markSeriesArchived(tx, context, row.id);
      archived += 1;
    }

    return {
      merchantsScoped: scope === null ? null : scope.length,
      merchantsSkippedByOverride: skippedByOverride,
      inputs: inputs.length,
      streams: streams.length,
      seriesInserted: inserted,
      seriesChanged: changed,
      seriesArchived: archived,
      candidatesProposed: proposed,
      autoConfirmed,
      lapsed,
      priceChanges,
      duplicateGroups: detection.duplicateServices.length,
      eventsAppended: events,
    };
  });
}

/**
 * Reconcile 07 §2.9's duplicate-service findings onto the series rows.
 *
 * Emission is on *membership* change, not on re-detection: adding a sixth
 * streaming service is news, re-finding the same five is not. The comparison is
 * against what each member row already stores, so a replay writes nothing and
 * says nothing.
 */
async function syncDuplicateFindings(
  executor: RecurringExecutor,
  context: RecurringContext,
  input: {
    readonly findings: readonly DuplicateServiceFinding[];
    readonly writtenByKey: ReadonlyMap<string, RecurringSeriesRow>;
    readonly scopedSeries: readonly RecurringSeriesRow[];
  },
): Promise<{ readonly events: number }> {
  const outbox = outboxOf(executor);
  const stillGrouped = new Set<string>();
  let events = 0;

  for (const finding of input.findings) {
    const members = finding.streamKeys
      .map((key) => input.writtenByKey.get(key))
      .filter((row): row is RecurringSeriesRow => row !== undefined);
    if (members.length < 2) continue;

    const peerKeys = [...finding.streamKeys].sort();
    const impact = Money.absolute(finding.annualImpact).minor;
    let membershipChanged = false;

    for (const member of members) {
      stillGrouped.add(member.id);
      const unchanged =
        member.duplicateNode === finding.node &&
        sameKeys(member.duplicatePeerKeys, peerKeys) &&
        member.duplicateAnnualImpactMinor === impact;
      if (unchanged) continue;
      if (!sameKeys(member.duplicatePeerKeys, peerKeys)) membershipChanged = true;
      await setDuplicateFinding(executor, context, {
        seriesId: member.id,
        node: finding.node,
        peerKeys,
        annualImpactMinor: impact,
      });
    }

    if (!membershipChanged) continue;
    await appendEvent(
      outbox,
      DuplicateServiceDetected.create(
        {
          kind: finding.kind,
          node: finding.node,
          seriesIds: members.map((member) => member.id).sort(),
          annualImpactMinor: impact.toString(),
          currency: finding.annualImpact.currency,
        },
        {
          userId: context.userId,
          aggregateId: members[0]?.id ?? null,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    events += 1;
  }

  // A series that has left every group loses its marking. Without this, a user
  // who cancels four of five streaming services keeps being told they have five.
  for (const row of input.scopedSeries) {
    if (row.duplicateNode === null) continue;
    if (stillGrouped.has(row.id)) continue;
    await setDuplicateFinding(executor, context, {
      seriesId: row.id,
      node: null,
      peerKeys: null,
      annualImpactMinor: null,
    });
  }

  return { events };
}

// ---------------------------------------------------------------------------
// The human's half of the pipeline
// ---------------------------------------------------------------------------

export interface CandidateDecisionInput {
  readonly candidateId: string;
  readonly reason?: string | null;
}

export interface RejectionInput {
  /**
   * How far the refusal reaches. `MERCHANT` is the default and is the dispatch
   * plan's `merchantKey → NOT_RECURRING`: never propose anything from this
   * payee again. `STREAM` is for the user who means "not *this* plan" — an
   * annual subscription that became a monthly one is two real streams at one
   * merchant and silencing both would be wrong.
   */
  readonly scope?: OverrideScope;
  readonly reason?: string | null;
}

/**
 * Confirm a candidate: the series is pinned, permanently, against the detector.
 *
 * Returns `null` when the candidate does not exist or has already been decided
 * — a double-click on "yes" is not an error and must not undo a merge.
 */
export async function confirmCandidate(
  database: RecurringDatabase,
  context: RecurringContext,
  input: CandidateDecisionInput,
): Promise<RecurringSeriesRow | null> {
  return database.transaction(async (tx) => {
    const candidate = await loadCandidateById(tx, context.userId, input.candidateId);
    if (candidate === null || candidate.state !== 'PROPOSED') return null;
    if (candidate.seriesId === null) return null;

    await decideCandidate(tx, context, {
      candidateId: candidate.id,
      state: 'CONFIRMED',
      reason: input.reason ?? null,
    });
    const series = await setSeriesConfirmed(tx, context, candidate.seriesId);
    if (series === null) return null;

    await appendEvent(
      outboxOf(tx),
      SeriesConfirmed.create(
        {
          seriesId: series.id,
          merchantId: series.merchantId,
          candidateId: candidate.id,
          source: 'user',
          userConfirmed: true,
        },
        {
          userId: context.userId,
          aggregateId: series.id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    return series;
  });
}

/** Confirm a series directly — the auto-confirmed row a user says "yes, keep it" to. */
export async function confirmSeries(
  database: RecurringDatabase,
  context: RecurringContext,
  input: { readonly seriesId: string },
): Promise<RecurringSeriesRow | null> {
  return database.transaction(async (tx) => {
    const series = await setSeriesConfirmed(tx, context, input.seriesId);
    if (series === null) return null;
    const candidates = await loadCandidates(tx, context.userId, [series.streamKey]);
    const candidate = candidates[0];
    if (candidate !== undefined && candidate.state === 'PROPOSED') {
      await decideCandidate(tx, context, { candidateId: candidate.id, state: 'CONFIRMED' });
    }
    await appendEvent(
      outboxOf(tx),
      SeriesConfirmed.create(
        {
          seriesId: series.id,
          merchantId: series.merchantId,
          candidateId: candidate?.id ?? null,
          source: 'user',
          userConfirmed: true,
        },
        {
          userId: context.userId,
          aggregateId: series.id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    return series;
  });
}

export interface RejectionResult {
  readonly candidateId: string;
  readonly merchantId: string;
  readonly streamKey: string;
  readonly scope: OverrideScope;
  /** The series row that was archived, if there was one. */
  readonly archivedSeriesId: string | null;
}

/**
 * Reject a series, permanently.
 *
 * Three things change and all three are durable:
 *
 *   * a `recurring_candidates` row reaches `REJECTED` and carries
 *     `override = 'NOT_RECURRING'` with a scope — the schema's
 *     `recurring_candidates_override_on_reject` CHECK refuses the override in
 *     any other state, so "rejected" and "suppressed" cannot drift apart;
 *   * the series row is archived, so nothing renders it; and
 *   * every future pass reads that override *before* it reads transactions, so
 *     the merchant's rows are never fetched again.
 *
 * Nothing is deleted. `decided_reason` and the frozen `proposed_*` columns are
 * what the user was shown when they said no, which is the only way to answer
 * "why is this not in my subscriptions?" a year later.
 */
export async function rejectSeries(
  database: RecurringDatabase,
  context: RecurringContext,
  input: { readonly seriesId: string } & RejectionInput,
): Promise<RejectionResult | null> {
  return database.transaction(async (tx) => {
    const series = await loadSeries(tx, context.userId, input.seriesId);
    if (series === null) return null;
    const scope = input.scope ?? 'MERCHANT';

    const candidates = await loadCandidates(tx, context.userId, [series.streamKey]);
    const existing = candidates[0];
    const candidate =
      existing === undefined
        ? await recordRejection(tx, context, {
            merchantId: series.merchantId,
            streamKey: series.streamKey,
            seriesId: series.id,
            cadence: series.cadence,
            type: series.type,
            confidence: Number(series.confidence),
            amount: Money.of(series.typicalAmountMinor, series.typicalAmountCurrency),
            sources: (series.sources as SourceEntry[] | null) ?? [],
            scope,
            reason: input.reason ?? null,
          })
        : await decideCandidate(tx, context, {
            candidateId: existing.id,
            state: 'REJECTED',
            reason: input.reason ?? null,
            override: 'NOT_RECURRING',
            overrideScope: scope,
          });
    if (candidate === null) return null;

    // The pin is the user's, and so is its removal: a rejection clears
    // `user_confirmed` before archiving, because the schema (correctly) refuses
    // a confirmed row in the ARCHIVED state.
    await unpinAndArchiveSeries(tx, context, series.id);

    return {
      candidateId: candidate.id,
      merchantId: series.merchantId,
      streamKey: series.streamKey,
      scope,
      archivedSeriesId: series.id,
    };
  });
}

/** Reject through the candidate queue. Same permanence; the queue is just the entry point. */
export async function rejectCandidate(
  database: RecurringDatabase,
  context: RecurringContext,
  input: CandidateDecisionInput & RejectionInput,
): Promise<RejectionResult | null> {
  return database.transaction(async (tx) => {
    const candidate = await loadCandidateById(tx, context.userId, input.candidateId);
    if (candidate === null) return null;
    const scope = input.scope ?? 'MERCHANT';

    const decided = await decideCandidate(tx, context, {
      candidateId: candidate.id,
      state: 'REJECTED',
      reason: input.reason ?? null,
      override: 'NOT_RECURRING',
      overrideScope: scope,
    });
    if (decided === null) return null;

    if (candidate.seriesId !== null) {
      await unpinAndArchiveSeries(tx, context, candidate.seriesId);
    }

    return {
      candidateId: candidate.id,
      merchantId: candidate.merchantId,
      streamKey: candidate.streamKey,
      scope,
      archivedSeriesId: candidate.seriesId,
    };
  });
}

/**
 * Merge two series into one — 07 §2.2's card migration, confirmed by a human.
 *
 * The source is archived with `merged_into_id` pointing at the survivor and its
 * occurrences are *moved*, not copied: the natural key is
 * `(user_id, transaction_id)`, so a transaction belongs to exactly one series
 * and a merge that copied would violate it rather than double-count silently.
 */
export async function mergeSeries(
  database: RecurringDatabase,
  context: RecurringContext,
  input: {
    readonly sourceSeriesId: string;
    readonly targetSeriesId: string;
    readonly reason?: string | null;
  },
): Promise<RecurringSeriesRow | null> {
  if (input.sourceSeriesId === input.targetSeriesId) return null;
  return database.transaction(async (tx) => {
    const source = await loadSeries(tx, context.userId, input.sourceSeriesId);
    const target = await loadSeries(tx, context.userId, input.targetSeriesId);
    if (source === null || target === null) return null;

    await setSeriesMerged(tx, context, {
      sourceSeriesId: source.id,
      targetSeriesId: target.id,
    });

    const sourceCandidates = await loadCandidates(tx, context.userId, [source.streamKey]);
    const sourceCandidate = sourceCandidates[0];
    if (sourceCandidate !== undefined) {
      await decideCandidate(tx, context, {
        candidateId: sourceCandidate.id,
        state: 'MERGED',
        reason: input.reason ?? null,
        mergedIntoSeriesId: target.id,
      });
    }

    // The survivor is confirmed by the merge: a human just stated that these two
    // are one stream, which is a stronger claim than the detector's.
    const confirmed = await setSeriesConfirmed(tx, context, target.id);
    const targetCandidates = await loadCandidates(tx, context.userId, [target.streamKey]);
    const targetCandidate = targetCandidates[0];
    if (targetCandidate !== undefined && targetCandidate.state === 'PROPOSED') {
      await decideCandidate(tx, context, {
        candidateId: targetCandidate.id,
        state: 'CONFIRMED',
        reason: input.reason ?? null,
      });
    }

    await appendEvent(
      outboxOf(tx),
      SeriesConfirmed.create(
        {
          seriesId: target.id,
          merchantId: target.merchantId,
          candidateId: targetCandidate?.id ?? null,
          source: 'merge',
          userConfirmed: true,
        },
        {
          userId: context.userId,
          aggregateId: target.id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    return confirmed;
  });
}

/**
 * Record what the user (or a catalogue) knows about a series' payee.
 *
 * Not decoration: `loadMerchantFacts` reads this straight back into the *next*
 * detection pass as the engine's `MerchantFacts`, so declaring a merchant a
 * loan servicer or a stream "for someone else" changes what is concluded, not
 * only what is rendered.
 */
export async function setSeriesMetadata(
  database: RecurringDatabase,
  context: RecurringContext,
  seriesId: string,
  patch: MetadataPatch,
): Promise<SubscriptionMetadataRow> {
  return database.transaction(async (tx) => upsertMetadata(tx, context, seriesId, patch));
}
