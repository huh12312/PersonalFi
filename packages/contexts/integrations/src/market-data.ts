// SPDX-License-Identifier: MIT
/**
 * The 03:45 refresh — 08 §3.7's `integrations.price_refresh`.
 *
 * *"03:45 local price refresh → `PricesUpdated`; net worth seals with last
 * known price flagged `stale_price`."*
 *
 * This is the job the security case is actually about. §5 of the dispatch:
 * *"Market data is the second egress surface, and the first one that runs on a
 * schedule with no human present. An SSRF here reaches `db:5432` and the
 * container metadata endpoint on a timer."* Everything defensive in this
 * package — the one-host-per-adapter policy, the client-side budgets, the
 * redactor — exists because this function runs unattended.
 *
 * ## Why this context never writes a price row
 *
 * `prices` and `fx_rates` belong to `@ctx/investments` (08 §1.3 #7, and both
 * OWNERSHIP.md files say so). This job *fetches*; it hands rows to an injected
 * `MarketDataWriter` that the composition root adapts onto `@ctx/investments`.
 *
 * That keeps "exactly one context may write a table" structurally true across a
 * seam that spans two contexts, and it is not merely bookkeeping:
 * `personalfi/layer-imports` forbids `@ctx/integrations` from importing
 * `@ctx/investments` at all, so the port is the only shape this could take.
 * `lint:schema-ownership` checks the claim; the port is what makes the claim
 * survive contact with the code.
 *
 * ## Every outcome is recorded, including the boring ones
 *
 * One `market_data_runs` row per provider per run, always — including
 * `skipped_no_key`. Two reasons. It is the durable spend the budgets hydrate
 * from at boot (`rate-limit.ts`: a worker that restarts at 03:44 would
 * otherwise start the day with an empty counter and no memory of the 900
 * requests it made at 03:15). And it is the audit trail for a refusal: a run
 * whose outcome is `refused` carries the guard's `RefusalCode`, so "the price
 * source tried to reach something it should not" is a query rather than a log
 * grep.
 *
 * ## Partial failure is the normal case
 *
 * A refresh where Tiingo answers, CoinGecko is rate-limited and FRED has no key
 * is not a failed refresh — it is Tuesday. So a source that cannot answer emits
 * `PriceSourceUnavailable` and the job continues to the next one; nothing here
 * throws on a provider outcome, because a throw would abandon the securities
 * that were still priceable.
 */
import { appendEvent, type EventContext, type Executor } from '@core/platform';
import { newId, systemClock, type Clock } from '@core/kernel';
import type {
  MarketDataOperation,
  MarketDataOutcome,
  MarketDataProvider,
} from '../schema/index.ts';
import { attributionRequirementsOf, type Attribution } from './attribution.ts';
import {
  PriceSourceUnavailable,
  PricesUpdated,
  type PriceSourceUnavailableReason,
} from './events.ts';
import type { PriceSource, PriceSubject, SourceOutcome } from './price-source.ts';
import { redactSecrets, type ApiKey } from './secrets.ts';

/** A security the refresh should price, as the caller's read model describes it. */
export interface RefreshSubject {
  readonly securityId: string;
  /** `securities.type` — chooses which source prices it (D17). */
  readonly kind: string;
  readonly subject: PriceSubject;
  /** The currency the position is held in. */
  readonly currency: string;
}

export interface RefreshFxPair {
  readonly base: string;
  readonly quote: string;
}

/** What to refresh. Supplied by the caller; this job does not query holdings. */
export interface RefreshPlan {
  readonly asOfDate: string;
  readonly securities: readonly RefreshSubject[];
  readonly fxPairs: readonly RefreshFxPair[];
}

export interface PriceRowToWrite {
  readonly securityId: string;
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
  readonly source: MarketDataProvider;
  /** The provider served a carry-forward, not a close for the day asked about. */
  readonly stale: boolean;
  readonly observedAt: Date;
}

export interface FxRowToWrite {
  readonly base: string;
  readonly quote: string;
  readonly rateDate: string;
  readonly rate: string;
  readonly source: MarketDataProvider;
  readonly observedAt: Date;
}

/**
 * The seam to `@ctx/investments`. Two methods, both returning how many rows
 * actually landed, because an upsert that changed nothing is not a write and
 * `PricesUpdated.priceRowsWritten` should not claim it was.
 */
export interface MarketDataWriter {
  writePrices(userId: string, rows: readonly PriceRowToWrite[]): Promise<number>;
  writeFxRates(userId: string, rows: readonly FxRowToWrite[]): Promise<number>;
}

/** One `market_data_runs` row. Written by this context, which owns that table. */
export interface MarketDataRun {
  readonly userId: string;
  readonly provider: MarketDataProvider;
  readonly operation: MarketDataOperation;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly outcome: MarketDataOutcome;
  readonly requestsMade: number;
  readonly unitsSpent: number;
  readonly symbolsAsked: number;
  readonly rowsWritten: number;
  readonly refusalCode: string | null;
  /** Already redacted when it reaches here. */
  readonly errorMessage: string | null;
  readonly retryAfterMs: number | null;
}

export interface MarketDataRunRecorder {
  record(run: MarketDataRun): Promise<void>;
}

export interface PriceRefreshOptions {
  readonly userId: string;
  /** Price sources by provider. A provider absent here is simply not consulted. */
  readonly sources: readonly PriceSource[];
  readonly writer: MarketDataWriter;
  readonly recorder: MarketDataRunRecorder;
  /** The outbox. Events are appended in the caller's transaction. */
  readonly outbox: Executor;
  readonly correlationId: string;
  readonly clock?: Clock;
  /** Every key this process holds, so nothing provider-authored is logged raw. */
  readonly keys?: readonly ApiKey[];
}

/**
 * Why one planned security got no price this run (WP 10.5). Every entry of
 * `securitiesUnpriced` has exactly one of these, so a screen can say "1 unpriced:
 * no CoinGecko key" rather than a bare count.
 *
 *   * `no_provider_for_kind` — `PROVIDER_FOR_KIND` names no source for the kind.
 *   * `source_not_configured` — a source prices the kind, but none is registered
 *     in this view: no key (by file or in Settings), or narrowed out of
 *     `MARKET_DATA_ALLOWED_HOSTS`. No request was made.
 *   * `no_data` — the provider answered and had no close for the subject.
 *   * the four `PriceSourceUnavailableReason`s, as the adapter reported them.
 */
export const UNPRICED_REASONS = [
  'no_provider_for_kind',
  'source_not_configured',
  'no_data',
  'skipped_no_key',
  'rate_limited',
  'refused',
  'error',
] as const;
export type UnpricedReason = (typeof UNPRICED_REASONS)[number];

export interface UnpricedSecurity {
  readonly securityId: string;
  /** The provider that would have priced it, or `null` when no provider prices its kind. */
  readonly provider: MarketDataProvider | null;
  readonly reason: UnpricedReason;
  /** The adapter's own sentence, redacted. `null` when there is nothing to add. */
  readonly detail: string | null;
}

/** One FX pair the run could not fetch, and why. */
export interface UnfetchedFxPair {
  readonly base: string;
  readonly quote: string;
  readonly reason: UnpricedReason;
  readonly detail: string | null;
}

/** What one provider was asked, as recorded in `market_data_runs`. */
export interface RefreshProviderTally {
  readonly provider: MarketDataProvider;
  readonly operation: MarketDataOperation;
  readonly requestsMade: number;
  readonly symbolsAsked: number;
  readonly outcome: MarketDataOutcome;
}

export interface PriceRefreshResult {
  readonly asOfDate: string;
  readonly priceRowsWritten: number;
  readonly fxRowsWritten: number;
  readonly securitiesPriced: readonly string[];
  readonly securitiesUnpriced: readonly string[];
  /** WP 10.5: one entry per id in `securitiesUnpriced`, with its reason. */
  readonly unpriced: readonly UnpricedSecurity[];
  /** WP 10.5: the FX pairs that were planned and not fetched, with the reason. */
  readonly fxUnfetched: readonly UnfetchedFxPair[];
  /** WP 10.5: one entry per provider and operation, the same numbers `market_data_runs` records. */
  readonly tallies: readonly RefreshProviderTally[];
  readonly unavailable: readonly {
    readonly provider: MarketDataProvider;
    readonly reason: PriceSourceUnavailableReason;
  }[];
  /** The licence obligations any surface showing these numbers must satisfy. */
  readonly attributionRequirements: readonly Attribution[];
}

/**
 * Which source prices which kind of thing (D17).
 *
 * Crypto goes to CoinGecko, everything tradable goes to Tiingo. A kind with no
 * entry is not priced by a provider at all — `cash` is worth its face value and
 * `bond` has no free source we would trust — and the ladder's `last_known` rung
 * in `@ctx/investments` is what answers for it.
 */
export const PROVIDER_FOR_KIND: Readonly<Record<string, MarketDataProvider>> = Object.freeze({
  equity: 'tiingo',
  etf: 'tiingo',
  mutual_fund: 'tiingo',
  crypto: 'coingecko',
});

export function createPriceRefreshJob(options: PriceRefreshOptions) {
  const clock = options.clock ?? systemClock;
  const keys = options.keys ?? [];
  const byProvider = new Map(options.sources.map((source) => [source.provider, source]));

  /**
   * Turn a failure outcome into the event vocabulary, once.
   *
   * `no_data` is deliberately absent: a provider that says "no close on a bank
   * holiday" answered correctly and is not unavailable. Treating it as a
   * failure would emit an alert every Christmas.
   */
  function unavailabilityOf(outcome: SourceOutcome<unknown>): {
    reason: PriceSourceUnavailableReason;
    detail: string;
    retryAfterMs: number | null;
    refusalCode: string | null;
  } | null {
    switch (outcome.kind) {
      case 'ok':
      case 'no_data':
        return null;
      case 'skipped_no_key':
        return {
          reason: 'skipped_no_key',
          detail: 'no API key is configured for this provider',
          retryAfterMs: null,
          refusalCode: null,
        };
      case 'rate_limited':
        return {
          reason: 'rate_limited',
          detail: redactSecrets(outcome.detail, keys),
          retryAfterMs: outcome.retryAfterMs,
          refusalCode: null,
        };
      case 'refused':
        return {
          reason: 'refused',
          detail: redactSecrets(outcome.detail, keys),
          retryAfterMs: null,
          refusalCode: outcome.code,
        };
      case 'error':
        return {
          reason: 'error',
          detail: redactSecrets(outcome.detail, keys),
          retryAfterMs: null,
          refusalCode: null,
        };
    }
  }

  return {
    async run(plan: RefreshPlan): Promise<PriceRefreshResult> {
      const context: EventContext = {
        userId: options.userId,
        correlationId: options.correlationId,
        aggregateId: options.userId,
      };

      const priceRows: PriceRowToWrite[] = [];
      const fxRows: FxRowToWrite[] = [];
      const priced: string[] = [];
      const unpriced: string[] = [];
      const unpricedDetail: UnpricedSecurity[] = [];
      const fxUnfetched: UnfetchedFxPair[] = [];
      const tallyReport: RefreshProviderTally[] = [];
      const unavailable: { provider: MarketDataProvider; reason: PriceSourceUnavailableReason }[] =
        [];
      const contributing = new Set<MarketDataProvider>();

      // One run row per provider per operation, accumulated as we go and
      // written at the end so a single provider's several calls are one ledger
      // entry rather than one per security.
      const tallies = new Map<string, MutableTally>();

      function tally(provider: MarketDataProvider, operation: MarketDataOperation): MutableTally {
        const key = `${provider}:${operation}`;
        const existing = tallies.get(key);
        if (existing !== undefined) return existing;
        const fresh: MutableTally = {
          provider,
          operation,
          startedAt: clock.now(),
          requestsMade: 0,
          unitsSpent: 0,
          symbolsAsked: 0,
          rowsWritten: 0,
          worstReason: null,
          detail: null,
          refusalCode: null,
          retryAfterMs: null,
        };
        tallies.set(key, fresh);
        return fresh;
      }

      // -------------------------------------------------------------------
      // Prices
      // -------------------------------------------------------------------
      for (const security of plan.securities) {
        const provider = PROVIDER_FOR_KIND[security.kind];
        const source = provider === undefined ? undefined : byProvider.get(provider);
        if (provider === undefined || source === undefined) {
          // No provider prices this kind. Not a failure: `@ctx/investments`'
          // ladder answers from `exchange_fill` or `last_known`.
          unpriced.push(security.securityId);
          unpricedDetail.push({
            securityId: security.securityId,
            provider: provider ?? null,
            reason: provider === undefined ? 'no_provider_for_kind' : 'source_not_configured',
            detail: null,
          });
          continue;
        }

        const entry = tally(provider, 'price_refresh');
        entry.symbolsAsked += 1;

        const outcome = await source.price({
          subject: security.subject,
          date: plan.asOfDate,
          currency: security.currency,
        });

        if (outcome.kind === 'ok') {
          entry.requestsMade += 1;
          contributing.add(provider);
          priced.push(security.securityId);
          priceRows.push({
            securityId: security.securityId,
            priceDate: outcome.value.date,
            close: outcome.value.close,
            currency: outcome.value.currency,
            source: provider,
            stale: outcome.value.stale,
            observedAt: outcome.value.observedAt,
          });
          continue;
        }

        unpriced.push(security.securityId);
        const failure = unavailabilityOf(outcome);
        if (failure === null) {
          // `no_data`. The request was still made and still cost a unit.
          entry.requestsMade += 1;
          unpricedDetail.push({
            securityId: security.securityId,
            provider,
            reason: 'no_data',
            detail: outcome.kind === 'no_data' ? redactSecrets(outcome.detail, keys) : null,
          });
          continue;
        }
        // A refusal never left the process, so it is not a request. Everything
        // else reached the provider.
        if (failure.reason !== 'refused' && failure.reason !== 'skipped_no_key') {
          entry.requestsMade += 1;
        }
        unpricedDetail.push({
          securityId: security.securityId,
          provider,
          reason: failure.reason,
          detail: failure.detail,
        });
        recordFailure(entry, failure);
      }

      // -------------------------------------------------------------------
      // FX — FRED, always, because it is the only FX source (D17)
      // -------------------------------------------------------------------
      const fredSource = byProvider.get('fred');
      for (const pair of plan.fxPairs) {
        // The identity is answered by `FxReader` without a row and must never
        // be fetched: a stored 1.0 is exactly what D4 forbids.
        if (pair.base.toUpperCase() === pair.quote.toUpperCase()) continue;
        if (fredSource === undefined) {
          // WP 10.5: named rather than silently skipped. No FRED key, so no
          // request; the pair is reported so a screen can say why.
          fxUnfetched.push({ ...pair, reason: 'source_not_configured', detail: null });
          continue;
        }

        const entry = tally('fred', 'fx_refresh');
        entry.symbolsAsked += 1;
        const outcome = await fredSource.fxRate(pair.base, pair.quote, plan.asOfDate);

        if (outcome.kind === 'ok') {
          entry.requestsMade += 1;
          contributing.add('fred');
          fxRows.push({
            base: outcome.value.base,
            quote: outcome.value.quote,
            rateDate: outcome.value.date,
            rate: outcome.value.rate,
            source: 'fred',
            observedAt: outcome.value.observedAt,
          });
          continue;
        }
        const failure = unavailabilityOf(outcome);
        if (failure === null) {
          entry.requestsMade += 1;
          fxUnfetched.push({
            ...pair,
            reason: 'no_data',
            detail: outcome.kind === 'no_data' ? redactSecrets(outcome.detail, keys) : null,
          });
          continue;
        }
        if (failure.reason !== 'refused' && failure.reason !== 'skipped_no_key') {
          entry.requestsMade += 1;
        }
        fxUnfetched.push({ ...pair, reason: failure.reason, detail: failure.detail });
        recordFailure(entry, failure);
      }

      // -------------------------------------------------------------------
      // Hand the rows across the seam, then state the facts
      // -------------------------------------------------------------------
      const priceRowsWritten =
        priceRows.length === 0 ? 0 : await options.writer.writePrices(options.userId, priceRows);
      const fxRowsWritten =
        fxRows.length === 0 ? 0 : await options.writer.writeFxRates(options.userId, fxRows);

      for (const entry of tallies.values()) {
        const rowsWritten = entry.operation === 'price_refresh' ? priceRowsWritten : fxRowsWritten;
        tallyReport.push({
          provider: entry.provider,
          operation: entry.operation,
          requestsMade: entry.requestsMade,
          symbolsAsked: entry.symbolsAsked,
          outcome: runOutcomeOf(entry),
        });
        await options.recorder.record({
          userId: options.userId,
          provider: entry.provider,
          operation: entry.operation,
          startedAt: entry.startedAt,
          finishedAt: clock.now(),
          outcome: runOutcomeOf(entry),
          requestsMade: entry.requestsMade,
          // CoinGecko bills credits and OpenFIGI jobs; for the price path a
          // request is a unit, which keeps the column readable in the units the
          // provider's ToS is written in.
          unitsSpent: entry.requestsMade,
          symbolsAsked: entry.symbolsAsked,
          rowsWritten,
          refusalCode: entry.refusalCode,
          errorMessage: entry.detail,
          retryAfterMs: entry.retryAfterMs,
        });

        if (entry.worstReason !== null) {
          unavailable.push({ provider: entry.provider, reason: entry.worstReason });
          await appendEvent(
            options.outbox,
            PriceSourceUnavailable.create(
              {
                provider: entry.provider,
                reason: entry.worstReason,
                detail: entry.detail ?? '',
                retryAfterMs: entry.retryAfterMs,
                refusalCode: entry.refusalCode,
                asOfDate: plan.asOfDate,
              },
              context,
              clock,
            ),
          );
        }
      }

      // Fired even when nothing moved: "the refresh ran and changed nothing" is
      // a fact a scheduler and a settings screen both need, and its absence is
      // how a silently broken job stays silent.
      await appendEvent(
        options.outbox,
        PricesUpdated.create(
          {
            asOfDate: plan.asOfDate,
            securityIds: priced,
            priceRowsWritten,
            fxRowsWritten,
            securitiesUnpricedCount: unpriced.length,
            providers: [...contributing].sort(),
          },
          context,
          clock,
        ),
      );

      return {
        asOfDate: plan.asOfDate,
        priceRowsWritten,
        fxRowsWritten,
        securitiesPriced: priced,
        securitiesUnpriced: unpriced,
        unpriced: unpricedDetail,
        fxUnfetched,
        tallies: tallyReport,
        unavailable,
        // The obligations the UI owes for the providers that actually
        // contributed. CoinGecko's is `required: true`, so any screen showing
        // one of these crypto closes must render the badge.
        attributionRequirements: attributionRequirementsOf(contributing),
      };
    },
  };
}

interface MutableTally {
  readonly provider: MarketDataProvider;
  readonly operation: MarketDataOperation;
  readonly startedAt: Date;
  requestsMade: number;
  unitsSpent: number;
  symbolsAsked: number;
  rowsWritten: number;
  worstReason: PriceSourceUnavailableReason | null;
  detail: string | null;
  refusalCode: string | null;
  retryAfterMs: number | null;
}

/**
 * Keep the most serious failure seen for a provider this run.
 *
 * A refusal outranks everything: if the egress guard said no even once, that is
 * the fact worth surfacing, and letting a subsequent ordinary error overwrite
 * it would bury a security event under a timeout.
 */
const REASON_SEVERITY: Readonly<Record<PriceSourceUnavailableReason, number>> = Object.freeze({
  refused: 4,
  error: 3,
  rate_limited: 2,
  skipped_no_key: 1,
});

function recordFailure(
  entry: MutableTally,
  failure: {
    reason: PriceSourceUnavailableReason;
    detail: string;
    retryAfterMs: number | null;
    refusalCode: string | null;
  },
): void {
  const current = entry.worstReason;
  if (current !== null && REASON_SEVERITY[current] >= REASON_SEVERITY[failure.reason]) return;
  entry.worstReason = failure.reason;
  entry.detail = failure.detail;
  entry.refusalCode = failure.refusalCode;
  entry.retryAfterMs = failure.retryAfterMs;
}

function runOutcomeOf(entry: MutableTally): MarketDataOutcome {
  if (entry.worstReason === null) return 'ok';
  // Some symbols answered and some did not: `partial` is the honest word, and
  // colouring the whole run red would train an operator to ignore it.
  if (entry.worstReason === 'error' && entry.requestsMade > 0 && entry.symbolsAsked > 1) {
    return 'partial';
  }
  return outcomeOfReason(entry.worstReason);
}

function outcomeOfReason(reason: PriceSourceUnavailableReason): MarketDataOutcome {
  switch (reason) {
    case 'skipped_no_key':
      return 'skipped_no_key';
    case 'rate_limited':
      return 'rate_limited';
    case 'refused':
      return 'refused';
    case 'error':
      return 'failed';
  }
}

/** A run recorder that keeps rows in memory, for the unit proofs. */
export function inMemoryRunRecorder(): MarketDataRunRecorder & {
  readonly runs: readonly MarketDataRun[];
} {
  const runs: MarketDataRun[] = [];
  return {
    runs,
    record(run) {
      runs.push(run);
      return Promise.resolve();
    },
  };
}

/** A writer that keeps rows in memory, for the unit proofs. */
export function inMemoryMarketDataWriter(): MarketDataWriter & {
  readonly prices: readonly PriceRowToWrite[];
  readonly fx: readonly FxRowToWrite[];
} {
  const priceRows: PriceRowToWrite[] = [];
  const fxRows: FxRowToWrite[] = [];
  return {
    prices: priceRows,
    fx: fxRows,
    writePrices(_userId, rows) {
      priceRows.push(...rows);
      return Promise.resolve(rows.length);
    },
    writeFxRates(_userId, rows) {
      fxRows.push(...rows);
      return Promise.resolve(rows.length);
    },
  };
}

/** Mint an id for a run row. Exported so the composition root does not re-derive it. */
export function newRunId(): string {
  return newId();
}
