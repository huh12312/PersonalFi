// SPDX-License-Identifier: MIT
/**
 * Who this adapter is, and what it honestly claims (08 §2.2, §2.6).
 */
import type { Capability, ConnectorCapabilities, ConnectorManifest } from '@connector/port';

/** Matches `accounts.provider`, `connections.provider`, and the registry key. */
export const WALLETRPC_PROVIDER = 'wallet_rpc';

export const WALLETRPC_CHAINS = ['bitcoin', 'ethereum'] as const;
export type WalletChain = (typeof WALLETRPC_CHAINS)[number];

/** Bound on any per-address or per-scan-chain loop. */
export const WALLETRPC_MAX_ADDRESSES_PER_SYNC = 500;

/**
 * What this adapter honestly claims.
 *
 * `transactions` is declared **only because the shared conformance suite
 * requires every adapter to** (`connector-port`'s `capabilities/declared`
 * check: `"every adapter in Phase 1 must support transactions"`) — the same
 * reason `CoinbaseConnector` declares it even though a $5,000 BTC buy is
 * deliberately *not* expressed as one. This connector has no cash-movement
 * concept at all: `syncTransactions` always returns an empty terminal page
 * (`emptyPage`), which is honest rather than a widening, because a watch-only
 * balance/holdings connector genuinely has no transaction stream to report.
 *
 * `holdings` and `balances` are declared because the connector can read chain
 * state — but see `connector.ts`'s header for what it does when it cannot
 * *price* what it read: 08 §2.2's rule that an honest adapter never reports
 * $0.00 for an unpriced asset means every non-zero balance this connector
 * finds surfaces as a named `DATA_UNAVAILABLE` rather than a fabricated fiat
 * value, because this connector has no price source of its own (out of scope
 * — WP 3.4's `PriceSource` + the resolver's `security_id` join is where a real
 * valuation for these balances eventually comes from).
 */
export function walletRpcCapabilities(): ConnectorCapabilities {
  return {
    supports: ['accounts', 'balances', 'holdings', 'transactions'] satisfies readonly Capability[],
    // There is no transaction history to window; the trivial `transactions`
    // leg never asks for one. Kept non-zero (rather than 0) so a caller that
    // computes a display string from it does not divide by zero.
    historyWindowDays: 730,
    // Esplora and Etherscan are both polled on a schedule, not on demand; an
    // on-chain balance does not need sub-minute freshness for a personal
    // finance app. Etherscan's own ceiling is 5/s and 100,000/day (01 §3.5);
    // Esplora publishes no numeric limit ("fair use", 429 enforced) — both are
    // comfortably inside a 15-minute floor for one user's addresses.
    minSyncIntervalSeconds: 15 * 60,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    // There is no provider-hosted flow: the user pastes an xpub/ypub/zpub or
    // an address into our own form.
    reconnectFlow: 'credential_form',
    // No consent to expire — this is public chain data.
    consentWindowDays: null,
    currencies: 'multi',
  };
}

export const WALLETRPC_MANIFEST: ConnectorManifest = Object.freeze({
  provider: WALLETRPC_PROVIDER,
  displayName: 'Bitcoin / Ethereum wallet (watch-only)',
  description:
    'Watch a Bitcoin xpub/ypub/zpub or an Ethereum address. No private key or seed phrase is ever ' +
    'accepted, stored, or sent anywhere — addresses are derived locally and balances come from ' +
    'public block explorers.',
  iconKey: 'crypto',
  linkKind: 'credential_form',
  docsUrl: null,
});
