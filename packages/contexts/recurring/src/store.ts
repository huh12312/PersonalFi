// SPDX-License-Identifier: MIT
/**
 * The persistence layer: rows in, rows out, and nothing that decides anything.
 *
 * Every function here is a query or a write against the five tables
 * `0010_recurring.sql` creates. The policy — what a rejection means, when a
 * series may be archived, which transition earns an event — is `service.ts`'s,
 * and keeping the two apart is what lets the lifecycle tests assert on policy
 * without a mock database and lets the idempotence test assert on rows without
 * reasoning about policy.
 *
 * ## Why the writes read first
 *
 * Every upsert below loads the existing row, compares it field by field, and
 * writes only when something actually differs. That costs one extra query per
 * series and buys two things that are otherwise very hard to get:
 *
 *   * **`updated_at` means something.** A replay of the same event over the
 *     same history touches nothing, so `'replaying the consumer twice produces
 *     identical rows'` can compare whole rows, timestamps included, rather than
 *     a hand-picked subset that would quietly stop covering new columns.
 *   * **Events are edge-triggered.** `inserted` / `changed` / `previous` come
 *     back from the write, so `service.ts` emits `CandidateProposed` for a
 *     candidate that did not exist and `SeriesLapsed` for a status that moved,
 *     instead of re-announcing whatever the detector mentioned this time.
 *
 * An `ON CONFLICT DO UPDATE` would be one round trip instead of two and would
 * lose both. The concurrency that pattern normally defends against is handled
 * one level up, by the per-user advisory lock `runDetection` takes.
 *
 * ## Numbers
 *
 * Money crosses this boundary as `bigint` minor units with a currency, always.
 * Scores (confidence, cadence score, coverage, the amount CV) are floats by
 * construction and cross it as `NUMERIC` text with six decimals — the schema
 * bans float column types outright, and `scoreText`/`scoreOf` below are the
 * only two places the conversion happens, so a rounding difference cannot make
 * an idempotent replay look like a change.
 */
import type { Database } from '@core/db';
import { Money, newId, type Clock, type DateOnly } from '@core/kernel';
import { lockIdForName, type Executor } from '@core/platform';
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  priceChangeEvents,
  recurringCandidates,
  recurringOccurrences,
  recurringSeries,
  subscriptionMetadata,
  type CandidateState,
  type OverrideScope,
  type PriceChangeEventRow,
  type RecurringCandidateRow,
  type RecurringOccurrenceRow,
  type RecurringSeriesRow,
  type SeriesState,
  type SubscriptionMetadataRow,
} from '../schema/index.ts';
import type { MerchantClass, MerchantFacts } from './types.ts';

export type RecurringExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

export type RecurringDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for one reason: Drizzle's `execute()` returns `PgRaw`,
 * a lazily-executed thenable, where the platform's `Executor` declares a
 * `Promise`. They are interchangeable at runtime and not assignable at compile
 * time, which is why `@core/platform` makes the identical cast in
 * `platformExecutor()` and `@ctx/categorization` in its own `db.ts`.
 */
export function outboxOf(executor: RecurringExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/**
 * `pg_advisory_xact_lock` class for this context.
 *
 * `'RECU'` as four ASCII bytes, in the same style as `@core/platform`'s
 * `CONSUMER_ADVISORY_LOCK_CLASS`. Two detection passes for one user — the sync
 * consumer and a user pressing "re-detect" — would otherwise interleave their
 * read-then-write upserts and could insert the same `stream_key` twice, which
 * the unique index would then reject with a 23505 rather than merging.
 */
export const RECURRING_ADVISORY_LOCK_CLASS = 0x5245_4355;

/** Everything a write path needs that is not data. */
export interface RecurringContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a whole detection pass together in the event log and the logs. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}

/** Who says this is recurring. Audit, and the seam Plaid's streams land in. */
export interface SourceEntry {
  readonly source: 'local_detector' | 'plaid_streams' | 'user';
  readonly version: string;
  /** ISO-8601. Set once, when this source first said so, and never rewritten. */
  readonly at: string;
  readonly confidence: number | null;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** A unit-interval score as `NUMERIC(n,6)` text. Clamped, never thrown. */
export function scoreText(value: number, max = 1): string {
  if (!Number.isFinite(value)) return (0).toFixed(6);
  return Math.min(max, Math.max(0, value)).toFixed(6);
}

export function scoreOf(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Take the per-user detection lock for the rest of this transaction.
 *
 * Blocking rather than `try_`: a second pass that gave up would silently skip
 * the work the first one is doing for a *different* merchant scope, and the
 * failure would look like "detection sometimes does not run".
 */
export async function lockUserDetection(
  executor: RecurringExecutor,
  userId: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(${RECURRING_ADVISORY_LOCK_CLASS}::int, ${lockIdForName(userId)}::int)`,
  );
}

export interface Overrides {
  /** Merchants the user has permanently refused. Never handed to the engine. */
  readonly merchants: ReadonlySet<string>;
  /** Single streams the user refused, at a merchant they did not refuse. */
  readonly streamKeys: ReadonlySet<string>;
}

/**
 * The rejections, read before anything else.
 *
 * This is deliberately the *first* query a detection pass makes. Filtering the
 * engine's output would work too, right up until somebody adds a second caller
 * that forgets to; filtering its input means a rejected merchant's transactions
 * are never fetched, never grouped and never scored, and "a rejected merchant
 * never returns as a candidate" is a property of the pipeline's shape.
 */
export async function loadOverrides(
  executor: RecurringExecutor,
  userId: string,
): Promise<Overrides> {
  const rows = await executor
    .select({
      merchantId: recurringCandidates.merchantId,
      streamKey: recurringCandidates.streamKey,
      scope: recurringCandidates.overrideScope,
    })
    .from(recurringCandidates)
    .where(
      and(
        eq(recurringCandidates.userId, userId),
        eq(recurringCandidates.override, 'NOT_RECURRING'),
        isNotNull(recurringCandidates.overrideScope),
      ),
    );

  const merchants = new Set<string>();
  const streamKeys = new Set<string>();
  for (const row of rows) {
    if (row.scope === 'MERCHANT') merchants.add(row.merchantId);
    else streamKeys.add(row.streamKey);
  }
  return { merchants, streamKeys };
}

export async function loadSeriesForMerchants(
  executor: RecurringExecutor,
  userId: string,
  merchantIds: readonly string[] | null,
): Promise<RecurringSeriesRow[]> {
  const conditions: SQL[] = [eq(recurringSeries.userId, userId)];
  if (merchantIds !== null) {
    if (merchantIds.length === 0) return [];
    conditions.push(inArray(recurringSeries.merchantId, [...merchantIds]));
  }
  return executor
    .select()
    .from(recurringSeries)
    .where(and(...conditions))
    .orderBy(asc(recurringSeries.streamKey));
}

export async function loadSeries(
  executor: RecurringExecutor,
  userId: string,
  seriesId: string,
): Promise<RecurringSeriesRow | null> {
  const rows = await executor
    .select()
    .from(recurringSeries)
    .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, seriesId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadCandidates(
  executor: RecurringExecutor,
  userId: string,
  streamKeys: readonly string[] | null,
): Promise<RecurringCandidateRow[]> {
  const conditions: SQL[] = [eq(recurringCandidates.userId, userId)];
  if (streamKeys !== null) {
    if (streamKeys.length === 0) return [];
    conditions.push(inArray(recurringCandidates.streamKey, [...streamKeys]));
  }
  return executor
    .select()
    .from(recurringCandidates)
    .where(and(...conditions))
    .orderBy(asc(recurringCandidates.streamKey));
}

export async function loadCandidateById(
  executor: RecurringExecutor,
  userId: string,
  candidateId: string,
): Promise<RecurringCandidateRow | null> {
  const rows = await executor
    .select()
    .from(recurringCandidates)
    .where(and(eq(recurringCandidates.userId, userId), eq(recurringCandidates.id, candidateId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOccurrences(
  executor: RecurringExecutor,
  seriesId: string,
): Promise<RecurringOccurrenceRow[]> {
  return executor
    .select()
    .from(recurringOccurrences)
    .where(eq(recurringOccurrences.seriesId, seriesId))
    .orderBy(asc(recurringOccurrences.occurredOn));
}

export async function loadMetadata(
  executor: RecurringExecutor,
  userId: string,
): Promise<SubscriptionMetadataRow[]> {
  return executor
    .select()
    .from(subscriptionMetadata)
    .where(eq(subscriptionMetadata.userId, userId));
}

/**
 * What the user (or a curated catalogue) has told us about each payee, in the
 * engine's own vocabulary.
 *
 * This is the loop that keeps `subscription_metadata` load-bearing: marking a
 * stream "for someone else" or declaring a merchant a loan changes what the
 * *next* detection pass concludes, rather than only what the screen renders.
 * Keyed by `merchantId` because that is the only identity the engine has; when
 * two series at one merchant disagree (an annual plan and a monthly one, one of
 * them declared a bundle), the facts are merged with "any row saying so wins",
 * which is the safe direction for three suppression flags.
 */
export async function loadMerchantFacts(
  executor: RecurringExecutor,
  userId: string,
): Promise<Map<string, MerchantFacts>> {
  const rows = await executor
    .select({
      merchantId: recurringSeries.merchantId,
      serviceNode: subscriptionMetadata.serviceNode,
      bundleSku: subscriptionMetadata.bundleSku,
      forSomeoneElse: subscriptionMetadata.forSomeoneElse,
      merchantClass: subscriptionMetadata.merchantClass,
    })
    .from(subscriptionMetadata)
    .innerJoin(recurringSeries, eq(subscriptionMetadata.seriesId, recurringSeries.id))
    .where(eq(subscriptionMetadata.userId, userId));

  const facts = new Map<string, MerchantFacts>();
  for (const row of rows) {
    const existing = facts.get(row.merchantId);
    facts.set(row.merchantId, {
      class: (row.merchantClass ?? existing?.class ?? 'UNKNOWN') as MerchantClass,
      serviceNode: row.serviceNode ?? existing?.serviceNode ?? null,
      bundleSku: row.bundleSku ?? existing?.bundleSku ?? null,
      forSomeoneElse: row.forSomeoneElse || (existing?.forSomeoneElse ?? false),
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Series writes
// ---------------------------------------------------------------------------

/** Everything detection knows about a stream, ready for the table. */
export interface SeriesValues {
  readonly streamKey: string;
  readonly merchantId: string;
  readonly sign: 'OUTFLOW' | 'INFLOW';
  readonly currency: string;
  readonly accountIds: readonly string[];
  readonly cadence: string;
  readonly cadenceScore: number;
  readonly anchorDate: DateOnly;
  readonly dayOfMonthPair: readonly [number, number] | null;
  readonly amountModel: 'FIXED' | 'VARIABLE' | 'IRREGULAR';
  readonly typicalAmount: Money;
  readonly amountMad: Money;
  readonly amountCv: number;
  readonly observedMinMinor: bigint;
  readonly observedMaxMinor: bigint;
  readonly type: string;
  readonly status: string;
  readonly confidence: number;
  readonly eligibleForImpact: boolean;
  readonly firstSeen: DateOnly;
  readonly lastSeen: DateOnly;
  readonly missedPeriods: number;
  readonly coverage: number;
  readonly nextDue: { readonly date: DateOnly; readonly uncertaintyDays: number; readonly amount: Money } | null;
  readonly suppressions: unknown;
  readonly mergeProposal: unknown;
  readonly detectionVersion: string;
}

export interface SeriesWriteResult {
  readonly row: RecurringSeriesRow;
  readonly inserted: boolean;
  readonly changed: boolean;
  /** The row as it was before this write; `null` on an insert. */
  readonly previous: RecurringSeriesRow | null;
}

/**
 * Write one detected stream.
 *
 * The three rules a confirmed series is owed (04 §5.1, "detection never
 * overrides a human") are enforced here rather than at each call site:
 * `user_confirmed` and `confirmed_at` are never touched by this path, `state`
 * never moves down from `ACTIVE` while the row is confirmed, and `archived_at`
 * is only ever cleared, never set.
 */
export async function upsertSeries(
  executor: RecurringExecutor,
  context: RecurringContext,
  values: SeriesValues,
  options: {
    readonly existing: RecurringSeriesRow | null;
    readonly autoConfirmed: boolean;
    readonly sources: readonly SourceEntry[];
  },
): Promise<SeriesWriteResult> {
  const now = context.clock.now();
  const existing = options.existing;
  const nextState: SeriesState =
    existing?.userConfirmed === true || options.autoConfirmed ? 'ACTIVE' : 'CANDIDATE';

  const shared = {
    merchantId: values.merchantId,
    sign: values.sign,
    currency: values.currency,
    accountIds: [...values.accountIds],
    cadence: values.cadence,
    cadenceScore: scoreText(values.cadenceScore),
    anchorDate: values.anchorDate,
    dayOfMonthPair: values.dayOfMonthPair === null ? null : [...values.dayOfMonthPair],
    amountModel: values.amountModel,
    typicalAmountMinor: values.typicalAmount.minor,
    typicalAmountCurrency: values.typicalAmount.currency,
    amountMadMinor: Money.absolute(values.amountMad).minor,
    amountCv: scoreText(values.amountCv, 9999),
    observedMinMinor: values.observedMinMinor,
    observedMaxMinor: values.observedMaxMinor,
    type: values.type,
    status: values.status,
    confidence: scoreText(values.confidence),
    eligibleForImpact: values.eligibleForImpact,
    firstSeen: values.firstSeen,
    lastSeen: values.lastSeen,
    missedPeriods: values.missedPeriods,
    coverage: scoreText(values.coverage),
    nextDueDate: values.nextDue?.date ?? null,
    nextDueUncertaintyDays: values.nextDue?.uncertaintyDays ?? null,
    nextDueAmountMinor: values.nextDue?.amount.minor ?? null,
    suppressions: values.suppressions,
    mergeProposal: values.mergeProposal,
    sources: mergeSources(sourcesOf(existing), options.sources, now),
    detectionVersion: values.detectionVersion,
  };

  if (existing === null) {
    const id = newId();
    const inserted = await executor
      .insert(recurringSeries)
      .values({
        id,
        userId: context.userId,
        streamKey: values.streamKey,
        state: nextState,
        userConfirmed: false,
        confirmedAt: nextState === 'ACTIVE' ? now : null,
        archivedAt: null,
        mergedIntoId: null,
        duplicateNode: null,
        duplicatePeerKeys: null,
        duplicateAnnualImpactMinor: null,
        lastDetectedAt: now,
        createdAt: now,
        updatedAt: now,
        ...shared,
      })
      .returning();
    return { row: inserted[0] as RecurringSeriesRow, inserted: true, changed: true, previous: null };
  }

  const updatePayload = {
    ...shared,
    // A confirmed series is pinned: detection may raise it to ACTIVE but never
    // lower it, and may never archive it (the schema refuses that combination
    // outright).
    state: (existing.userConfirmed ? 'ACTIVE' : nextState) satisfies SeriesState,
    archivedAt: null,
    // Auto-confirmation stamps an instant the first time it happens and never
    // rewrites it; a series that later drops back under the bar keeps the
    // history of having been over it.
    confirmedAt: nextState === 'ACTIVE' ? (existing.confirmedAt ?? now) : existing.confirmedAt,
  };

  const changed = seriesDiffers(existing, updatePayload);
  if (!changed) {
    // Nothing moved. `last_detected_at` is deliberately *not* bumped: it would
    // make every replay a write and take `'replaying the consumer twice
    // produces identical rows'` with it. "When did we last look?" is a question
    // about the consumer offset, which the platform already answers.
    return { row: existing, inserted: false, changed: false, previous: existing };
  }

  const updated = await executor
    .update(recurringSeries)
    .set({ ...candidateRow, lastDetectedAt: now, updatedAt: now })
    .where(eq(recurringSeries.id, existing.id))
    .returning();
  return {
    row: updated[0] as RecurringSeriesRow,
    inserted: false,
    changed: true,
    previous: existing,
  };
}

function sourcesOf(row: RecurringSeriesRow | null): readonly SourceEntry[] {
  if (row === null) return [];
  return (row.sources as SourceEntry[] | null) ?? [];
}

/**
 * Append a source without rewriting the one already there.
 *
 * `at` is "when this detector first said so" and must survive a re-run, or the
 * row would differ on every pass and idempotence would be unprovable. A second
 * source (Plaid's streams, 07 §2.11's hybrid) appends; the same source at the
 * same version updates only its confidence.
 */
export function mergeSources(
  existing: readonly SourceEntry[],
  incoming: readonly SourceEntry[],
  now: Date,
): SourceEntry[] {
  const merged = existing.map((entry) => ({ ...entry }));
  for (const entry of incoming) {
    const found = merged.find(
      (candidate) => candidate.source === entry.source && candidate.version === entry.version,
    );
    if (found === undefined) merged.push({ ...entry, at: entry.at || now.toISOString() });
    else found.confidence = entry.confidence;
  }
  return merged;
}

function seriesDiffers(row: RecurringSeriesRow, next: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(next)) {
    const current = (row as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value) && Array.isArray(current)) {
      if (!sameStringArray(value.map(String), current.map(String))) return true;
      continue;
    }
    if (value instanceof Date || current instanceof Date) {
      const a = value instanceof Date ? value.getTime() : null;
      const b = current instanceof Date ? current.getTime() : null;
      if (a !== b) return true;
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      if (!sameJson(value, current)) return true;
      continue;
    }
    if ((value ?? null) !== (current ?? null)) return true;
  }
  return false;
}

export async function markSeriesArchived(
  executor: RecurringExecutor,
  context: RecurringContext,
  seriesId: string,
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(recurringSeries)
    .set({ state: 'ARCHIVED', archivedAt: now, nextDueDate: null, nextDueUncertaintyDays: null, nextDueAmountMinor: null, updatedAt: now })
    .where(and(eq(recurringSeries.id, seriesId), eq(recurringSeries.userConfirmed, false)));
}

export async function setSeriesConfirmed(
  executor: RecurringExecutor,
  context: RecurringContext,
  seriesId: string,
): Promise<RecurringSeriesRow | null> {
  const now = context.clock.now();
  const rows = await executor
    .update(recurringSeries)
    .set({ userConfirmed: true, confirmedAt: now, state: 'ACTIVE', archivedAt: null, updatedAt: now })
    .where(and(eq(recurringSeries.userId, context.userId), eq(recurringSeries.id, seriesId)))
    .returning();
  return rows[0] ?? null;
}

export async function setSeriesMerged(
  executor: RecurringExecutor,
  context: RecurringContext,
  input: { readonly sourceSeriesId: string; readonly targetSeriesId: string },
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(recurringSeries)
    .set({
      mergedIntoId: input.targetSeriesId,
      state: 'ARCHIVED',
      archivedAt: now,
      userConfirmed: false,
      confirmedAt: null,
      nextDueDate: null,
      nextDueUncertaintyDays: null,
      nextDueAmountMinor: null,
      updatedAt: now,
    })
    .where(
      and(eq(recurringSeries.userId, context.userId), eq(recurringSeries.id, input.sourceSeriesId)),
    );
  await executor
    .update(recurringOccurrences)
    .set({ seriesId: input.targetSeriesId, updatedAt: now })
    .where(
      and(
        eq(recurringOccurrences.userId, context.userId),
        eq(recurringOccurrences.seriesId, input.sourceSeriesId),
      ),
    );
}

export async function setDuplicateFinding(
  executor: RecurringExecutor,
  context: RecurringContext,
  input: {
    readonly seriesId: string;
    readonly node: string | null;
    readonly peerKeys: readonly string[] | null;
    readonly annualImpactMinor: bigint | null;
  },
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(recurringSeries)
    .set({
      duplicateNode: input.node,
      duplicatePeerKeys: input.peerKeys === null ? null : [...input.peerKeys],
      duplicateAnnualImpactMinor: input.annualImpactMinor,
      updatedAt: now,
    })
    .where(eq(recurringSeries.id, input.seriesId));
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

export interface OccurrenceValues {
  readonly transactionId: string;
  readonly accountId: string;
  readonly date: DateOnly;
  readonly amount: Money;
  readonly residualDays: number | null;
  readonly duplicateOf: string | null;
}

/**
 * Make `recurring_occurrences` for a series say exactly what this pass found.
 *
 * Inserts what is new, updates what moved, and deletes what this series no
 * longer claims — a transaction the ledger tombstoned, or one that a re-detect
 * moved into a neighbouring stream. The delete is scoped to this series, so a
 * transaction that *moved* is updated by the insert branch (the natural key is
 * `(user_id, transaction_id)`, the engine's own partition property) rather than
 * deleted and re-created with a new id.
 */
export async function syncOccurrences(
  executor: RecurringExecutor,
  context: RecurringContext,
  seriesId: string,
  values: readonly OccurrenceValues[],
): Promise<{ readonly written: number; readonly removed: number }> {
  const now = context.clock.now();
  const existing = await loadOccurrences(executor, seriesId);
  const byTransaction = new Map(existing.map((row) => [row.transactionId, row]));
  const wanted = new Set(values.map((value) => value.transactionId));

  let written = 0;
  for (const value of values) {
    const current = byTransaction.get(value.transactionId);
    if (current === undefined) {
      await executor
        .insert(recurringOccurrences)
        .values({
          id: newId(),
          userId: context.userId,
          seriesId,
          transactionId: value.transactionId,
          accountId: value.accountId,
          occurredOn: value.date,
          amountMinor: value.amount.minor,
          amountCurrency: value.amount.currency,
          residualDays: value.residualDays,
          duplicateOf: value.duplicateOf,
          createdAt: now,
          updatedAt: now,
        })
        // A transaction that moved between series: the unique key is
        // (user_id, transaction_id), so this is an update of the row that
        // already exists, not a second row the old series never cleans up.
        .onConflictDoUpdate({
          target: [recurringOccurrences.userId, recurringOccurrences.transactionId],
          set: {
            seriesId,
            accountId: value.accountId,
            occurredOn: value.date,
            amountMinor: value.amount.minor,
            amountCurrency: value.amount.currency,
            residualDays: value.residualDays,
            duplicateOf: value.duplicateOf,
            updatedAt: now,
          },
        });
      written += 1;
      continue;
    }
    const differs =
      current.accountId !== value.accountId ||
      current.occurredOn !== value.date ||
      current.amountMinor !== value.amount.minor ||
      current.amountCurrency !== value.amount.currency ||
      (current.residualDays ?? null) !== value.residualDays ||
      (current.duplicateOf ?? null) !== value.duplicateOf;
    if (!differs) continue;
    await executor
      .update(recurringOccurrences)
      .set({
        accountId: value.accountId,
        occurredOn: value.date,
        amountMinor: value.amount.minor,
        amountCurrency: value.amount.currency,
        residualDays: value.residualDays,
        duplicateOf: value.duplicateOf,
        updatedAt: now,
      })
      .where(eq(recurringOccurrences.id, current.id));
    written += 1;
  }

  const stale = existing.filter((row) => !wanted.has(row.transactionId)).map((row) => row.id);
  if (stale.length > 0) {
    await executor.delete(recurringOccurrences).where(inArray(recurringOccurrences.id, stale));
  }
  return { written, removed: stale.length };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface CandidateValues {
  readonly merchantId: string;
  readonly streamKey: string;
  readonly seriesId: string;
  readonly cadence: string;
  readonly type: string;
  readonly confidence: number;
  readonly amount: Money;
  readonly sources: readonly SourceEntry[];
}

export interface CandidateWriteResult {
  readonly row: RecurringCandidateRow;
  readonly inserted: boolean;
}

/**
 * Propose a candidate, once.
 *
 * Once a row exists it is never re-proposed and never reset: a `PROPOSED` row
 * is a question already on the user's screen, and every decided state
 * (`CONFIRMED`, `REJECTED`, `MERGED`, `EXPIRED`) is an answer that outranks
 * anything a later pass has to say. The only field a later pass may touch is
 * `series_id`, and only to point an existing decision at a series that has
 * since been (re)created.
 */
export async function proposeCandidate(
  executor: RecurringExecutor,
  context: RecurringContext,
  values: CandidateValues,
  existing: RecurringCandidateRow | null,
): Promise<CandidateWriteResult> {
  const now = context.clock.now();
  if (existing !== null) {
    if (existing.seriesId !== values.seriesId) {
      const relinked = await executor
        .update(recurringCandidates)
        .set({ seriesId: values.seriesId, updatedAt: now })
        .where(eq(recurringCandidates.id, existing.id))
        .returning();
      return { row: relinked[0] as RecurringCandidateRow, inserted: false };
    }
    return { row: existing, inserted: false };
  }

  const rows = await executor
    .insert(recurringCandidates)
    .values({
      id: newId(),
      userId: context.userId,
      merchantId: values.merchantId,
      streamKey: values.streamKey,
      seriesId: values.seriesId,
      state: 'PROPOSED',
      override: null,
      overrideScope: null,
      proposedCadence: values.cadence,
      proposedType: values.type,
      proposedConfidence: scoreText(values.confidence),
      proposedAmountMinor: values.amount.minor,
      proposedAmountCurrency: values.amount.currency,
      sources: values.sources,
      decidedAt: null,
      decidedReason: null,
      mergedIntoSeriesId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { row: rows[0] as RecurringCandidateRow, inserted: true };
}

export async function decideCandidate(
  executor: RecurringExecutor,
  context: RecurringContext,
  input: {
    readonly candidateId: string;
    readonly state: CandidateState;
    readonly reason?: string | null;
    readonly override?: 'NOT_RECURRING' | null;
    readonly overrideScope?: OverrideScope | null;
    readonly mergedIntoSeriesId?: string | null;
  },
): Promise<RecurringCandidateRow | null> {
  const now = context.clock.now();
  const rows = await executor
    .update(recurringCandidates)
    .set({
      state: input.state,
      decidedAt: now,
      decidedReason: input.reason ?? null,
      override: input.override ?? null,
      overrideScope: input.overrideScope ?? null,
      mergedIntoSeriesId: input.mergedIntoSeriesId ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(recurringCandidates.userId, context.userId),
        eq(recurringCandidates.id, input.candidateId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Record a rejection for a stream that has no candidate row.
 *
 * Reachable when a user rejects a series that was auto-confirmed above the 0.80
 * bar and therefore never queued a question. The override is what matters and
 * it lives on this table, so the row is created rather than the rejection being
 * silently dropped.
 */
export async function recordRejection(
  executor: RecurringExecutor,
  context: RecurringContext,
  values: CandidateValues & { readonly scope: OverrideScope; readonly reason: string | null },
): Promise<RecurringCandidateRow> {
  const now = context.clock.now();
  const rows = await executor
    .insert(recurringCandidates)
    .values({
      id: newId(),
      userId: context.userId,
      merchantId: values.merchantId,
      streamKey: values.streamKey,
      seriesId: values.seriesId,
      state: 'REJECTED',
      override: 'NOT_RECURRING',
      overrideScope: values.scope,
      proposedCadence: values.cadence,
      proposedType: values.type,
      proposedConfidence: scoreText(values.confidence),
      proposedAmountMinor: values.amount.minor,
      proposedAmountCurrency: values.amount.currency,
      sources: values.sources,
      decidedAt: now,
      decidedReason: values.reason,
      mergedIntoSeriesId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0] as RecurringCandidateRow;
}

// ---------------------------------------------------------------------------
// Price changes
// ---------------------------------------------------------------------------

export interface PriceChangeValues {
  readonly seriesId: string;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly effectiveDate: DateOnly;
  readonly from: Money;
  readonly to: Money;
  readonly delta: Money;
  readonly annualImpact: Money;
  readonly confirmed: boolean;
  readonly priorTransactionIds: readonly string[];
  readonly recentTransactionIds: readonly string[];
}

export interface PriceChangeWriteResult {
  readonly row: PriceChangeEventRow;
  readonly inserted: boolean;
  /** An already-recorded provisional change that this pass confirmed. */
  readonly newlyConfirmed: boolean;
}

export async function upsertPriceChange(
  executor: RecurringExecutor,
  context: RecurringContext,
  values: PriceChangeValues,
): Promise<PriceChangeWriteResult> {
  const now = context.clock.now();
  const existing = await executor
    .select()
    .from(priceChangeEvents)
    .where(
      and(
        eq(priceChangeEvents.seriesId, values.seriesId),
        eq(priceChangeEvents.effectiveDate, values.effectiveDate),
        eq(priceChangeEvents.direction, values.direction),
      ),
    )
    .limit(1);

  const current = existing[0];
  if (current === undefined) {
    const rows = await executor
      .insert(priceChangeEvents)
      .values({
        id: newId(),
        userId: context.userId,
        seriesId: values.seriesId,
        direction: values.direction,
        effectiveDate: values.effectiveDate,
        fromMinor: Money.absolute(values.from).minor,
        toMinor: Money.absolute(values.to).minor,
        deltaMinor: Money.absolute(values.delta).minor,
        annualImpactMinor: Money.absolute(values.annualImpact).minor,
        currency: values.delta.currency,
        confirmed: values.confirmed,
        priorTransactionIds: [...values.priorTransactionIds],
        recentTransactionIds: [...values.recentTransactionIds],
        notifiedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { row: rows[0] as PriceChangeEventRow, inserted: true, newlyConfirmed: false };
  }

  const newlyConfirmed = values.confirmed && !current.confirmed;
  const differs =
    newlyConfirmed ||
    !sameStringArray(current.recentTransactionIds, [...values.recentTransactionIds]) ||
    !sameStringArray(current.priorTransactionIds, [...values.priorTransactionIds]);
  if (!differs) return { row: current, inserted: false, newlyConfirmed: false };

  const rows = await executor
    .update(priceChangeEvents)
    .set({
      confirmed: values.confirmed || current.confirmed,
      priorTransactionIds: [...values.priorTransactionIds],
      recentTransactionIds: [...values.recentTransactionIds],
      updatedAt: now,
    })
    .where(eq(priceChangeEvents.id, current.id))
    .returning();
  return { row: rows[0] as PriceChangeEventRow, inserted: false, newlyConfirmed };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface MetadataPatch {
  readonly serviceNode?: string | null;
  readonly bundleSku?: string | null;
  readonly forSomeoneElse?: boolean;
  readonly merchantClass?: MerchantClass | null;
  readonly planName?: string | null;
  readonly standardPrice?: Money | null;
  readonly usageDeclaration?: 'USED' | 'UNUSED' | 'UNKNOWN' | null;
  readonly usageSource?: 'USER_DECLARED' | 'HEURISTIC' | null;
  readonly cancelUrl?: string | null;
  readonly notes?: string | null;
}

export async function upsertMetadata(
  executor: RecurringExecutor,
  context: RecurringContext,
  seriesId: string,
  patch: MetadataPatch,
): Promise<SubscriptionMetadataRow> {
  const now = context.clock.now();
  const existing = await executor
    .select()
    .from(subscriptionMetadata)
    .where(eq(subscriptionMetadata.seriesId, seriesId))
    .limit(1);

  const usageDeclared = patch.usageDeclaration !== undefined && patch.usageDeclaration !== null;
  const next = {
    serviceNode: patch.serviceNode ?? existing[0]?.serviceNode ?? null,
    bundleSku: patch.bundleSku ?? existing[0]?.bundleSku ?? null,
    forSomeoneElse: patch.forSomeoneElse ?? existing[0]?.forSomeoneElse ?? false,
    merchantClass: patch.merchantClass ?? existing[0]?.merchantClass ?? null,
    planName: patch.planName ?? existing[0]?.planName ?? null,
    standardPriceMinor: patch.standardPrice?.minor ?? existing[0]?.standardPriceMinor ?? null,
    standardPriceCurrency:
      patch.standardPrice?.currency ?? existing[0]?.standardPriceCurrency ?? null,
    usageDeclaration: patch.usageDeclaration ?? existing[0]?.usageDeclaration ?? null,
    // 07 §2.10: a usage claim without a source is a claim we cannot stand
    // behind. Defaulting to USER_DECLARED here would launder a heuristic into a
    // confident message, so an unsourced declaration is recorded as HEURISTIC.
    usageSource: patch.usageSource ?? existing[0]?.usageSource ?? (usageDeclared ? 'HEURISTIC' : null),
    usageDeclaredAt: usageDeclared ? now : (existing[0]?.usageDeclaredAt ?? null),
    cancelUrl: patch.cancelUrl ?? existing[0]?.cancelUrl ?? null,
    notes: patch.notes ?? existing[0]?.notes ?? null,
    updatedAt: now,
  };

  if (existing[0] === undefined) {
    const rows = await executor
      .insert(subscriptionMetadata)
      .values({
        id: newId(),
        userId: context.userId,
        seriesId,
        createdAt: now,
        ...next,
      })
      .returning();
    return rows[0] as SubscriptionMetadataRow;
  }

  const rows = await executor
    .update(subscriptionMetadata)
    .set(next)
    .where(eq(subscriptionMetadata.id, existing[0].id))
    .returning();
  return rows[0] as SubscriptionMetadataRow;
}
