// SPDX-License-Identifier: MIT
/**
 * Who this adapter is, what it is allowed to touch, and what it honestly claims.
 *
 * Split out from `connector.ts` so the manifest, the capability declaration and
 * the four constants that define the *blast radius* of a leaked CDP key can be
 * imported by the composition root, by a test, and by the evidence doc without
 * dragging in the client.
 *
 * ## The two constants that are security controls, not configuration
 *
 *   * **`COINBASE_READ_ONLY_PATHS`** — the complete list of request paths this
 *     package is permitted to construct. `client.ts` asserts membership before
 *     it signs anything, and `no-trade-surface.test.ts` greps `src/**` for any
 *     other `/api/v3/brokerage/…` literal. Advanced Trade's trading surface is
 *     `POST /orders`, `POST /orders/batch_cancel`, `POST /orders/edit` and
 *     `POST /portfolios/{uuid}/move_funds`; none of those strings exists in this
 *     package, and the allow-list is what keeps that true after the next edit
 *     rather than only today.
 *   * **`CDP_JWT_LIFETIME_SECONDS = 120`** — 01 §3.2: "Your JWT expires after 2
 *     minutes, after which all requests are unauthenticated." A longer lifetime
 *     is not ours to choose; a *shorter* one would be, and 120 is the documented
 *     maximum rather than a default we accepted without reading.
 */
import type { Capability, ConnectorCapabilities, ConnectorManifest } from '@connector/port';

/** Matches `accounts.provider`, `connections.provider`, and the registry key. */
export const COINBASE_PROVIDER = 'coinbase';

/**
 * The host the `uri` claim is bound to. Part of the JWT, so it is not a base URL
 * a caller may override: signing `GET api.coinbase.com/…` and sending it
 * somewhere else produces a token that the somewhere-else cannot use, which is
 * the entire point of the `uri` binding.
 */
export const COINBASE_API_HOST = 'api.coinbase.com';

export const COINBASE_BROKERAGE_PREFIX = '/api/v3/brokerage';

/**
 * Every path this adapter may ever build. All five are `GET`.
 *
 * `{product_id}` is the one placeholder; `assertReadOnlyPath` matches it
 * structurally so that a product id can vary without the allow-list becoming a
 * prefix check (a prefix check would happily admit `/orders/historical/fills`
 * *and* `/orders`).
 */
export const COINBASE_READ_ONLY_PATHS = Object.freeze([
  `${COINBASE_BROKERAGE_PREFIX}/key_permissions`,
  `${COINBASE_BROKERAGE_PREFIX}/accounts`,
  `${COINBASE_BROKERAGE_PREFIX}/portfolios`,
  `${COINBASE_BROKERAGE_PREFIX}/orders/historical/fills`,
  `${COINBASE_BROKERAGE_PREFIX}/products/{product_id}/ticker`,
] as const);

export type CoinbaseReadOnlyPath = (typeof COINBASE_READ_ONLY_PATHS)[number];

// ---------------------------------------------------------------------------
// CDP JWT (01 §3.2). Explicitly **not** ES256.
// ---------------------------------------------------------------------------

/**
 * 01 §3.2: "ECDSA is a legacy key algorithm. You should use Ed25519 instead."
 *
 * Plaid's *webhook* verification is ES256 and lives in a different package for a
 * reason. 01 §3.2 warns in as many words against cargo-culting between them, so
 * this constant is asserted by `jwt.test.ts` rather than merely used.
 */
export const CDP_JWT_ALGORITHM = 'EdDSA';
export const CDP_JWT_ISSUER = 'cdp';
export const CDP_JWT_AUDIENCE = Object.freeze(['cdp_service'] as const);
/** 01 §3.2. The documented maximum, and a fresh token is minted per request. */
export const CDP_JWT_LIFETIME_SECONDS = 120;
/** 16 bytes of CSPRNG per request. Replay protection is the provider's, not ours. */
export const CDP_JWT_NONCE_BYTES = 16;

// ---------------------------------------------------------------------------
// The two sealed credential names
// ---------------------------------------------------------------------------

/**
 * `connect` returns both under these names, `@ctx/connections` seals them with
 * `SecretBox`, and every later call reads them back through
 * `ConnectionHandle.secret(...)`. The adapter never stores either on `this`, in
 * a module, or in a cache: `jwt.ts` parses the key, signs one request and drops
 * the `KeyObject` on the next tick.
 */
export const CDP_KEY_NAME = 'cdp_key_name';
export const CDP_PRIVATE_KEY = 'cdp_private_key';

/** Both credential names, for the custody scan and for `@ctx/connections`. */
export const COINBASE_CREDENTIAL_NAMES = Object.freeze([CDP_KEY_NAME, CDP_PRIVATE_KEY] as const);

/**
 * `organizations/{org_uuid}/apiKeys/{key_uuid}` — the CDP key name, which is
 * also the JWT's `kid` **and** its `sub` (01 §3.2).
 *
 * Validated at `connect` so that a user who pasted the *private key* into the
 * name box gets `invalid_input` instead of a signed request that leaks the key
 * material into a `kid` header field on the wire.
 */
export const CDP_KEY_NAME_PATTERN =
  /^organizations\/[0-9a-fA-F-]{36}\/apiKeys\/[0-9a-fA-F-]{36}$/;

// ---------------------------------------------------------------------------
// Paging and window
// ---------------------------------------------------------------------------

/** 01 §3.3: `/accounts` page size default 49, max 250. */
export const COINBASE_MAX_ACCOUNTS_PAGE_SIZE = 250;
/** `/orders/historical/fills` `limit`. Conservative; see the evidence doc §6. */
export const COINBASE_MAX_FILLS_PAGE_SIZE = 250;

/**
 * D16's 730 days, not because Coinbase publishes a limit but because the
 * orchestrator must be told *something* and 730 is the house figure. What v3
 * actually bounds is not the age of a fill but which movements exist at all —
 * see `ledger-gap.ts`, which is the real answer to "how far back can we go".
 */
export const COINBASE_HISTORY_WINDOW_DAYS = 730;

/**
 * What this adapter honestly claims.
 *
 * Notes on the values that are not obvious:
 *
 *   * **`transactions` is declared** even though the dispatch's capability list
 *     names only `accounts, balances, holdings, investment_txns`. It is not a
 *     widening: Coinbase genuinely produces cash-movement transactions — a fiat
 *     on-ramp deposit is a transfer on the USD wallet and belongs in the ledger
 *     — and the shared conformance suite's first check requires it of every
 *     adapter. What `syncTransactions` deliberately does **not** emit is a trade
 *     leg: a $5,000 BTC buy is an investment transaction, and expressing it as a
 *     ledger transaction is exactly the v0.5 rung failure this WP exists to
 *     prevent. See `ledger.ts`.
 *   * **`liabilities` is absent.** 08 §2.6: adapters "degrade honestly". There
 *     is no margin or loan product behind a `can_view` CDP key, so
 *     `syncLiabilities` is not implemented and the orchestrator skips the leg
 *     rather than catching a `NotImplemented`.
 *   * **`incremental_sync` is declared** because `syncTransactions` really does
 *     carry a cursor — see `cursor.ts`. It is *our* cursor, not Coinbase's:
 *     the fills endpoint pages with a provider cursor, and the balance
 *     watermark that makes the R6 inference possible is ours.
 *   * **`historical_backfill` is absent.** This is the R6 finding as a
 *     capability flag rather than as a paragraph: v3 cannot reconstruct the
 *     movements that happened before we started watching, so claiming backfill
 *     would tell the orchestrator to ask for 730 days of a ledger that does not
 *     exist. `ledger-gap.ts` names the CSV export that can.
 *   * **`refreshBudgetPerDay: null`** — 01 §3.3 records ~15 req/s private, per
 *     IP, and marks it `[UNVERIFIED]`. A per-second limit is not a daily budget,
 *     and inventing a daily number would be a second, wrong, rate limiter.
 */
export function coinbaseCapabilities(): ConnectorCapabilities {
  return {
    supports: [
      'accounts',
      'balances',
      'transactions',
      'investment_txns',
      'holdings',
      'incremental_sync',
    ] satisfies readonly Capability[],
    historyWindowDays: COINBASE_HISTORY_WINDOW_DAYS,
    // Crypto balances move continuously and the account is one person's. Hourly
    // is polite against a ~15 req/s ceiling and frequent enough that the
    // balance-delta inference in `ledger.ts` has a usable resolution.
    minSyncIntervalSeconds: 60 * 60,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    // A CDP key is typed into our own form; there is no provider-hosted flow and
    // no refresh token. A rotated key is re-entered here.
    reconnectFlow: 'credential_form',
    // A CDP key does not expire. It is revoked, by the user, in the CDP portal.
    consentWindowDays: null,
    currencies: 'multi',
  };
}

export const COINBASE_MANIFEST: ConnectorManifest = Object.freeze({
  provider: COINBASE_PROVIDER,
  displayName: 'Coinbase (read-only)',
  description:
    'Connect Coinbase with a read-only CDP API key. Balances, holdings and Advanced Trade ' +
    'fills sync on a schedule. The key must have view permission only — a key that can trade ' +
    'or transfer is refused, and no part of this app can place an order.',
  iconKey: 'crypto',
  linkKind: 'credential_form',
  docsUrl: 'https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication',
});
