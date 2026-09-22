// SPDX-License-Identifier: MIT
/**
 * The wire: five GETs, one transport seam, and the shapes they answer with.
 *
 * ## Why a transport function and not an SDK
 *
 * There is no Coinbase SDK in this package's allow-list (`scripts/eslint-boundaries.js`,
 * the `connector-coinbase` layer) and the dispatch rejected `jose` before an
 * agent could propose it: `node:crypto` signs Ed25519 natively. What is left is
 * five GET requests, which is `fetch` plus a signature.
 *
 * The seam is a **function**, not a class, and it takes an already-built request
 * including its `Authorization` header. That split is deliberate:
 *
 *   * `client.ts` decides *what* to ask for, asserts the path is one of the five
 *     read-only ones, and mints the JWT. It is pure but for the clock and the
 *     CSPRNG, so every security property it holds is testable with no network.
 *   * the transport does I/O and nothing else. The test transport can therefore
 *     **verify the token it was handed** — decode the header, check `alg`,
 *     `kid`, `uri`, `exp`, and verify the Ed25519 signature against the public
 *     half of the test key — which turns `FakeCoinbaseApi` from a stub into an
 *     adversary. A fake that accepted any `Authorization` header would let a
 *     broken signature ship green.
 *
 * ## Shapes are declared `readonly` and *narrow*
 *
 * Only the fields the adapter actually reads are declared. Everything Coinbase
 * sends is preserved verbatim in each fact's `raw`, so a Phase 4 question still
 * has a Phase 3 answer; declaring a field here is a statement that `map.ts`
 * depends on it, and `map.test.ts` pins every one of them against the recorded
 * fixtures.
 */

/** The only verb this package knows. There is no other member, deliberately. */
export type CoinbaseMethod = 'GET';

export interface CoinbaseRequest {
  readonly method: CoinbaseMethod;
  readonly host: string;
  /** Path with `{product_id}` already substituted. Never carries a query string. */
  readonly path: string;
  /** Query parameters, which are **not** part of the JWT's `uri` claim (01 §3.2). */
  readonly query: Readonly<Record<string, string>>;
  /** `Authorization: Bearer <jwt>` plus `Accept`. Nothing else. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal | null;
  /** Milliseconds before the request is abandoned. The transport owns the timer. */
  readonly timeoutMs: number;
}

export interface CoinbaseHttpResponse {
  readonly status: number;
  /** Lower-cased names. `retry-after` is the only one the adapter reads. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, or `null` when the body was empty or not JSON. */
  readonly body: unknown;
}

export type CoinbaseTransport = (request: CoinbaseRequest) => Promise<CoinbaseHttpResponse>;

/**
 * The adapter's logger.
 *
 * Two levels, a context object and a message — the same shape `@connector/plaid`
 * uses, so `apps/api` wires both to the same pino child logger. What may go in
 * `context` is enumerated in `client.ts` and asserted by `log-hygiene.test.ts`.
 */
export interface CoinbaseLogger {
  debug(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export const silentCoinbaseLogger: CoinbaseLogger = Object.freeze({
  debug: () => undefined,
  warn: () => undefined,
});

// ---------------------------------------------------------------------------
// GET /api/v3/brokerage/key_permissions
// ---------------------------------------------------------------------------

/**
 * 01 §3.2: keys carry four booleans. Three of them decide whether this connector
 * is allowed to exist at all.
 *
 * `can_receive` is read and deliberately **not** refused: a key that can receive
 * a deposit address cannot move money out, and refusing it would reject the
 * common case of a key created by ticking nothing but "view" in a portal that
 * also grants receive. `can_trade` and `can_transfer` are the two that can lose
 * money and they are refused, by name, before any data call.
 */
export interface CoinbaseKeyPermissions {
  readonly can_view?: boolean;
  readonly can_trade?: boolean;
  readonly can_transfer?: boolean;
  readonly can_receive?: boolean;
  readonly service_account_id?: string;
  readonly portfolio_uuid?: string;
  readonly portfolio_type?: string;
}

// ---------------------------------------------------------------------------
// GET /api/v3/brokerage/accounts
// ---------------------------------------------------------------------------

export interface CoinbaseAmount {
  readonly value: string;
  readonly currency: string;
}

export interface CoinbaseAccount {
  readonly uuid: string;
  readonly name: string;
  /** The asset: `USD`, `BTC`, `USDC`. Not an ISO currency for crypto wallets. */
  readonly currency: string;
  readonly available_balance: CoinbaseAmount;
  readonly hold?: CoinbaseAmount;
  readonly active?: boolean;
  readonly deleted_at?: string | null;
  /** `ACCOUNT_TYPE_FIAT` | `ACCOUNT_TYPE_CRYPTO` | `ACCOUNT_TYPE_VAULT` | … */
  readonly type?: string;
  readonly ready?: boolean;
  readonly retail_portfolio_id?: string;
  readonly platform?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface CoinbaseAccountsPage {
  readonly accounts: readonly CoinbaseAccount[];
  readonly has_next?: boolean;
  readonly cursor?: string;
  readonly size?: number;
}

// ---------------------------------------------------------------------------
// GET /api/v3/brokerage/portfolios
// ---------------------------------------------------------------------------

export interface CoinbasePortfolio {
  readonly uuid: string;
  readonly name: string;
  readonly type?: string;
  readonly deleted?: boolean;
}

export interface CoinbasePortfoliosResponse {
  readonly portfolios: readonly CoinbasePortfolio[];
}

// ---------------------------------------------------------------------------
// GET /api/v3/brokerage/orders/historical/fills
// ---------------------------------------------------------------------------

/**
 * One trade fill.
 *
 * `size_in_quote` is the field an adapter forgets and then silently books a
 * $4,000 *quantity* of BTC. When it is `true`, `size` is denominated in the
 * quote currency (USD) rather than in the base asset, which is how a retail
 * "buy $100 of BTC" order is reported. `map.ts` derives the base quantity as
 * `size / price` in that case and says so.
 */
export interface CoinbaseFill {
  readonly entry_id?: string;
  readonly trade_id: string;
  readonly order_id?: string;
  /** RFC-3339. The moment of the fill. */
  readonly trade_time: string;
  readonly trade_type?: string;
  /** Unit price, quote per base, as a decimal string. */
  readonly price: string;
  /** Filled size — base asset, unless `size_in_quote` is true. */
  readonly size: string;
  /** Fee, in the quote currency, as a decimal string. */
  readonly commission: string;
  /** `BTC-USD`. Base and quote, hyphen-separated. */
  readonly product_id: string;
  readonly sequence_timestamp?: string;
  readonly liquidity_indicator?: string;
  readonly size_in_quote?: boolean;
  readonly side: string;
  readonly retail_portfolio_id?: string;
}

export interface CoinbaseFillsPage {
  readonly fills: readonly CoinbaseFill[];
  readonly cursor?: string;
}

// ---------------------------------------------------------------------------
// GET /api/v3/brokerage/products/{product_id}/ticker
// ---------------------------------------------------------------------------

export interface CoinbaseTrade {
  readonly trade_id?: string;
  readonly product_id?: string;
  readonly price: string;
  readonly size?: string;
  readonly time?: string;
  readonly side?: string;
}

export interface CoinbaseTickerResponse {
  readonly trades?: readonly CoinbaseTrade[];
  readonly best_bid?: string;
  readonly best_ask?: string;
}

/**
 * The five calls, as an interface, so a test can implement it without a socket.
 *
 * `CoinbaseClient` implements this over the transport; `FakeCoinbaseApi`
 * implements the *transport* rather than this interface, so the fake sits below
 * the JWT rather than above it and every signing property stays under test.
 */
export interface CoinbaseApiLike {
  keyPermissions(): Promise<CoinbaseKeyPermissions>;
  accounts(options: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<CoinbaseAccountsPage>;
  portfolios(): Promise<CoinbasePortfoliosResponse>;
  fills(options: {
    readonly cursor: string | null;
    readonly limit: number;
    readonly startSequenceTimestamp: string | null;
  }): Promise<CoinbaseFillsPage>;
  ticker(productId: string): Promise<CoinbaseTickerResponse>;
}
