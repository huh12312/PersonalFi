// SPDX-License-Identifier: MIT
/**
 * WP 10.5 — the price-refresh planner, and the one function both the 03:45 job
 * and "Refresh prices" run (WP 10.4 §0, defect (f)).
 *
 * Until this file existed, `module.integrations` ran "the honest empty plan"
 * every night: nothing ever supplied `planFor`, so a Tiingo or CoinGecko key —
 * by file or, since WP 10.4, through Settings — priced nothing, and a holder's
 * BTC showed no gain however many keys they saved.
 *
 * ## The plan
 *
 * One read (`@ctx/investments`' `readPricingPositions`: every security with a
 * non-zero position across every account), then pure routing:
 *
 *   * `kind = securities.type`, and `PROVIDER_FOR_KIND` names the source that
 *     prices it (D17): `equity | etf | mutual_fund` → Tiingo, `crypto` →
 *     CoinGecko. A kind with no source (`cash`, `bond`, `other`) is left out of
 *     the plan and **counted** in `notPricedByProvider` — the ladder's
 *     `last_known` / face value answers for it, and asking a provider would be
 *     a request on behalf of nothing it can price.
 *   * The subject is built the way each `PriceSource` expects it: Tiingo takes a
 *     ticker; CoinGecko takes its coin id, which for a chain's own coin
 *     (`contract = 'native'`, WP 3.1's sentinel) is WP 3.4's
 *     `CHAIN_NATIVE_COIN_IDS`. A security whose subject cannot be built — an
 *     equity with no ticker, a token contract CoinGecko has no offline id for —
 *     is **named** in `unplannable` with its reason, never silently dropped.
 *   * `fxPairs`: every distinct non-base currency any position is held in →
 *     base. The identity pair is never planned (D4: a stored 1.0 is forbidden).
 *
 * The planner spends nothing. The per-provider budgets are the job's and the
 * adapters' (`rate-limit.ts`, primed from `market_data_runs`), so a refresh can
 * never ask a provider for more than its published allowance however many
 * positions the plan names; it is the planner's job only to make that one read.
 */
import type { Clock } from '@core/kernel';
import type { Database } from '@core/db';
import {
  CHAIN_NATIVE_COIN_IDS,
  PROVIDER_FOR_KIND,
  createPriceRefreshJob,
  type MarketDataProvider,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceRefreshResult,
  type PriceSubject,
  type RefreshFxPair,
  type RefreshPlan,
  type RefreshSubject,
} from '@ctx/integrations';
import { readPricingPositions, type PricingPosition } from '@ctx/investments';
import type { MarketDataView } from './domain.ts';

/** Why the planner could not build a subject for a security a provider would price. */
export const PLAN_EXCLUSION_REASONS = ['no_ticker', 'no_coin_id'] as const;
export type PlanExclusionReason = (typeof PLAN_EXCLUSION_REASONS)[number];

/** A held security, as a person would recognise it in a result. */
export interface HeldSecurity {
  readonly securityId: string;
  readonly kind: string;
  readonly symbol: string | null;
  readonly name: string | null;
}

export interface UnplannableSecurity extends HeldSecurity {
  /** The source that would have priced it. */
  readonly provider: MarketDataProvider;
  readonly reason: PlanExclusionReason;
  readonly detail: string;
}

/**
 * `RefreshPlan` plus what the planner decided about everything it left out.
 * Structurally a `RefreshPlan`, so `createPriceRefreshJob` takes it unchanged.
 */
export interface PriceRefreshPlan extends RefreshPlan {
  /** Every security with a non-zero position, planned or not. */
  readonly held: readonly HeldSecurity[];
  /** A source prices its kind, but no subject could be built. Named, never dropped. */
  readonly unplannable: readonly UnplannableSecurity[];
  /** No source prices its kind (`cash`, `bond`, `other`). Counted, not asked about. */
  readonly notPricedByProvider: readonly HeldSecurity[];
}

export type PriceRefreshPlanner = (userId: string, asOfDate: string) => Promise<PriceRefreshPlan>;

/** What one security becomes: a subject a provider understands, or the reason there is none. */
export type SubjectDecision =
  | { readonly outcome: 'subject'; readonly subject: PriceSubject }
  | {
      readonly outcome: 'unplannable';
      readonly reason: PlanExclusionReason;
      readonly detail: string;
    };

/**
 * The subject each `PriceSource` expects. Pure, and exported so the routing is
 * testable without a database.
 */
export function subjectOf(
  position: PricingPosition,
  provider: MarketDataProvider,
): SubjectDecision {
  if (provider === 'coingecko') {
    // CoinGecko keys on its own coin id, never a ticker (several assets trade as
    // "ETH"). The one offline mapping we have is WP 3.4's, for a chain's own coin.
    if (position.contract === 'native' && position.chain !== null) {
      const coinId = CHAIN_NATIVE_COIN_IDS[position.chain];
      if (coinId !== undefined) return { outcome: 'subject', subject: { kind: 'coin_id', coinId } };
    }
    return {
      outcome: 'unplannable',
      reason: 'no_coin_id',
      detail:
        position.contract !== null && position.contract !== 'native'
          ? `no CoinGecko coin id is known for token contract ${position.contract} on ${position.chain ?? 'an unnamed chain'}`
          : `no CoinGecko coin id is known for ${position.ticker ?? position.name ?? 'this asset'}`,
    };
  }
  const ticker = position.ticker?.trim() ?? '';
  if (ticker.length === 0) {
    return {
      outcome: 'unplannable',
      reason: 'no_ticker',
      detail: `${position.name ?? 'this security'} has no ticker, and ${provider} prices by ticker`,
    };
  }
  return { outcome: 'subject', subject: { kind: 'ticker', symbol: ticker, mic: position.mic } };
}

/**
 * The planner. `baseCurrency` is the currency net worth is stated in
 * (`ModuleWiringOptions.baseCurrency`, `BASE_CURRENCY` on the routes).
 */
export function createPriceRefreshPlanner(
  database: Database,
  options: { readonly baseCurrency?: string } = {},
): PriceRefreshPlanner {
  const base = (options.baseCurrency ?? 'USD').toUpperCase();
  return async (userId, asOfDate) => {
    const positions = await readPricingPositions(database, userId);
    const held: HeldSecurity[] = [];
    const securities: RefreshSubject[] = [];
    const unplannable: UnplannableSecurity[] = [];
    const notPricedByProvider: HeldSecurity[] = [];
    const quotes = new Set<string>();

    for (const position of positions) {
      const security: HeldSecurity = {
        securityId: position.securityId,
        kind: position.type,
        symbol: position.ticker,
        name: position.name,
      };
      held.push(security);
      for (const currency of position.positionCurrencies) {
        if (currency !== base) quotes.add(currency);
      }

      const provider = PROVIDER_FOR_KIND[position.type];
      if (provider === undefined) {
        notPricedByProvider.push(security);
        continue;
      }
      const decision = subjectOf(position, provider);
      if (decision.outcome === 'unplannable') {
        unplannable.push({
          ...security,
          provider,
          reason: decision.reason,
          detail: decision.detail,
        });
        continue;
      }
      securities.push({
        securityId: position.securityId,
        kind: position.type,
        subject: decision.subject,
        // The currency the security is quoted in when a provider said so, else
        // the one its positions are held in. Tiingo answers `no_data` for
        // anything but USD rather than converting (D4), and says so.
        currency: position.currency ?? position.positionCurrencies[0] ?? base,
      });
    }

    const fxPairs: RefreshFxPair[] = [...quotes]
      .sort()
      .map((quote) => ({ base: quote, quote: base }));
    return { asOfDate, securities, fxPairs, held, unplannable, notPricedByProvider };
  };
}

export interface PriceRefreshRun {
  readonly plan: PriceRefreshPlan;
  readonly result: PriceRefreshResult;
}

/**
 * The refresh itself, for one holder: plan, then `createPriceRefreshJob` over
 * the holder's view, in one transaction so the price rows and the events that
 * announce them commit together. The 03:45 job (`modules.ts`) and
 * `POST /market-data/refresh` both call exactly this.
 */
export async function runPriceRefresh(input: {
  readonly database: Database;
  readonly clock: Clock;
  readonly userId: string;
  readonly correlationId: string;
  readonly asOfDate: string;
  readonly planFor: PriceRefreshPlanner;
  readonly view: MarketDataView;
  readonly writer: MarketDataWriter;
  readonly recorder: MarketDataRunRecorder;
}): Promise<PriceRefreshRun> {
  const plan = await input.planFor(input.userId, input.asOfDate);
  const result = await input.database.transaction(async (tx) => {
    const job = createPriceRefreshJob({
      userId: input.userId,
      sources: input.view.sources,
      writer: input.writer,
      recorder: input.recorder,
      outbox: { execute: (query) => tx.execute(query) as never },
      correlationId: input.correlationId,
      clock: input.clock,
      keys: input.view.keys,
    });
    return job.run(plan);
  });
  return { plan, result };
}
