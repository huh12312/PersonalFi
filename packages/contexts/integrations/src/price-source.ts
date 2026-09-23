// SPDX-License-Identifier: MIT
/**
 * The `PriceSource` port. **One** port, three methods, four adapters.
 *
 * 03-phase-3-dispatch.md §3: *"**One** `PriceSource` port —
 * `price(securityId, date, currency)`, `fxRate(from, to, date)`,
 * `search(symbol)` — with Tiingo …, FRED … and CoinGecko Demo … behind it."*
 * 01 §4.3 says why: *"put price data behind a `PriceSource` port. Ghostfolio's
 * pluggable-provider design is the validated pattern; its Yahoo issues are the
 * validated failure mode."*
 *
 * ## What the port takes, and what it deliberately does not
 *
 * A `securityId` is a UUID in *our* database and means nothing to Tiingo. So
 * the port's request carries a `PriceSubject` — the ticker, or the CoinGecko
 * coin id, or the chain+contract — which the caller derived from the security.
 * `PriceReader.price(securityId, date, currency)` in `@ctx/investments` is the
 * signature 08 §1.3 #7 specifies and is the one the rest of the app uses; this
 * is the layer beneath it, and it takes what a provider can actually answer.
 *
 * The port takes **no headers, no URL and no host** from its caller. There is
 * no `baseUrl` option and no `extraHeaders`. That is not an oversight: a port
 * that accepts a URL is an SSRF primitive with a domain-shaped wrapper, and 08
 * §4.4's egress rule ("no user-supplied headers") has to be enforceable by
 * reading the interface, not by auditing the call sites.
 *
 * ## Why every failure is a value and not an exception
 *
 * Six of these outcomes are *expected*. A missing key is expected — §6 of the
 * dispatch: "Phase 3 completes with zero keys". A provider with no data for a
 * bank holiday is expected. A budget that is spent is expected at 03:45 on a
 * day with a large backfill. An egress refusal is expected the first time
 * somebody mistypes a host.
 *
 * Each of them means something different to the caller and each is recorded
 * differently in `market_data_runs`, so collapsing them into `throw` (or worse,
 * into `null`) would lose the distinction exactly where it matters. The refresh
 * job switches on this union; nothing in the happy path is in a `catch`.
 */
import type { MarketDataProvider } from '../schema/index.ts';
import type { Attribution } from './attribution.ts';

/**
 * What to ask a provider about.
 *
 * A discriminated union rather than a string, because "AAPL" and
 * "ethereum" and "0xa0b8…" are three different kinds of thing and an adapter
 * that took a bare string would have to guess which. Tiingo understands
 * `ticker`; CoinGecko understands `coin_id`; neither understands the other's.
 */
export type PriceSubject =
  | { readonly kind: 'ticker'; readonly symbol: string; readonly mic: string | null }
  | { readonly kind: 'coin_id'; readonly coinId: string }
  | { readonly kind: 'chain_contract'; readonly chain: string; readonly contract: string };

export interface PriceRequest {
  readonly subject: PriceSubject;
  /** The calendar day whose close is wanted, `YYYY-MM-DD`, at UTC 00:00 (07 §6.1). */
  readonly date: string;
  /** ISO-4217. A provider that cannot quote in it answers `no_data`, never a converted guess. */
  readonly currency: string;
}

/**
 * One close.
 *
 * `close` is a **decimal string**, never a number. D3, and the Phase 3 risk
 * table's first row: "A float reaches a quantity or a price… the error
 * compounds where nobody looks." The adapters parse provider JSON and re-render
 * the numeric literal as a string rather than letting it round-trip through an
 * IEEE double — see `decimalStringOf` in `src/json.ts`.
 */
export interface PriceQuote {
  readonly subject: PriceSubject;
  readonly date: string;
  readonly close: string;
  readonly currency: string;
  readonly provider: MarketDataProvider;
  /** The provider served a carry-forward rather than a close for `date`. */
  readonly stale: boolean;
  /** When the provider answered. The input to 07 §6.1's 24-hour rule. */
  readonly observedAt: Date;
  /** Travels with the number, so a UI cannot render the price and omit the obligation. */
  readonly attribution: Attribution;
}

export interface FxQuote {
  readonly base: string;
  readonly quote: string;
  readonly date: string;
  /** 1 `base` = `rate` `quote`. A decimal string. */
  readonly rate: string;
  readonly provider: MarketDataProvider;
  readonly observedAt: Date;
  readonly attribution: Attribution;
}

/** One macro observation — CPI, DGS10 — for the market rate C1/C2 have withheld for. */
export interface MacroObservation {
  readonly seriesId: string;
  readonly date: string;
  /** A decimal string. Units are the series'; we do not reinterpret them. */
  readonly value: string;
  readonly provider: MarketDataProvider;
  readonly observedAt: Date;
  readonly attribution: Attribution;
}

export interface SearchHit {
  readonly symbol: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly provider: MarketDataProvider;
}

/**
 * Every way a provider call can end.
 *
 * `refused` carries `@core/platform`'s `RefusalCode` verbatim, so
 * `market_data_runs.refusal_code` is written without parsing a message and the
 * gate's "which refusal fired?" is a query.
 */
export type SourceOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The provider answered, and has nothing for this subject on this date. */
  | { readonly kind: 'no_data'; readonly detail: string }
  /** No key is configured. A configuration state, not a failure (§6). */
  | { readonly kind: 'skipped_no_key' }
  /** Our own budget said no — see `rate-limit.ts` for why it is ours and not theirs. */
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number; readonly detail: string }
  /** The egress guard said no. This one is a security event. */
  | { readonly kind: 'refused'; readonly code: string; readonly detail: string }
  /** The provider is down, malformed, or told us something we will not believe. */
  | { readonly kind: 'error'; readonly detail: string };

export interface PriceSourceCapabilities {
  readonly prices: boolean;
  readonly fx: boolean;
  readonly macro: boolean;
  readonly search: boolean;
}

/**
 * The port.
 *
 * `capabilities` is declared rather than discovered, and an adapter that cannot
 * do a thing says so instead of throwing `NotImplemented` — 08 §2.6's
 * "adapters degrade honestly", the same rule WP 3.5's Coinbase connector
 * follows for `liabilities`. The refresh job skips a source that declares
 * `fx: false` rather than calling it and catching.
 */
export interface PriceSource {
  readonly provider: MarketDataProvider;
  readonly capabilities: PriceSourceCapabilities;
  /** The licence obligation that travels with anything this source returns. */
  readonly attribution: Attribution;
  /** Whether a key is configured. `false` ⇒ every call answers `skipped_no_key`. */
  readonly hasKey: boolean;
  /** What this source has spent against its published budget, for the settings screen. */
  budget(now: Date): readonly { readonly label: string; readonly used: number; readonly limit: number }[];

  price(request: PriceRequest): Promise<SourceOutcome<PriceQuote>>;
  fxRate(from: string, to: string, date: string): Promise<SourceOutcome<FxQuote>>;
  search(symbol: string): Promise<SourceOutcome<readonly SearchHit[]>>;
}

/** A source that declares a capability it does not have is a bug; this is the honest refusal. */
export function unsupported<T>(provider: string, what: string): SourceOutcome<T> {
  return {
    kind: 'error',
    detail: `${provider} does not provide ${what}; check \`capabilities\` before calling`,
  };
}
