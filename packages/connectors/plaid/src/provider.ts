// SPDX-License-Identifier: MIT
/**
 * Who this adapter is, and what it honestly claims it can do.
 *
 * Split out from `connector.ts` so the manifest and the capability declaration
 * can be imported by the composition root, by a test, and by the evidence doc's
 * generator without dragging in the SDK types or the connector itself.
 */
import type { Capability, ConnectorCapabilities, ConnectorManifest } from '@connector/port';

/** Matches `accounts.provider`, `connections.provider`, and the registry key. */
export const PLAID_PROVIDER = 'plaid';

/**
 * Pinned, explicitly, in code (01 §1.9).
 *
 * > "If the header is omitted, the Dashboard-configured default applies."
 *
 * A Dashboard setting is invisible, un-reviewable configuration drift: the same
 * container would decode different response shapes depending on a checkbox
 * somebody ticked in a browser eighteen months ago. `client.ts` sets this header
 * on every request and `pins.test.ts` asserts it.
 */
export const PLAID_API_VERSION = '2020-09-14';

/**
 * The name of the one credential this adapter holds.
 *
 * `connect` returns it under this key, `@ctx/connections` seals it, and every
 * later call reads it back through `ConnectionHandle.secret(PLAID_ACCESS_TOKEN)`.
 * The adapter never stores it on `this`, in a module, or in a cache.
 *
 * Plaid access tokens do not expire (01 §1.10), which is precisely why losing
 * control of one matters more than it would for a bearer token with a lifetime.
 */
export const PLAID_ACCESS_TOKEN = 'access_token';

/** Plaid's ceiling for `/transactions/sync` `count` (01 §5.1). */
export const PLAID_MAX_PAGE_SIZE = 500;

/**
 * D16 / 01 §5.1. `days_requested` defaults to **90**, not the 730 maximum, and
 * accepting that default silently loses ~21 months that cannot be recovered
 * without deleting the Item and re-linking.
 */
export const PLAID_MAX_HISTORY_DAYS = 730;

/** 01 §5.4: pinned in code even though a new account is on v2 by default. */
export const PLAID_PFC_VERSION = 'v2';

/**
 * D16: Trial requests exactly these three. **Not** Auth, **not** Identity.
 *
 * 01 §1.5: Auth exists "to initiate credits or debits via ACH" and we never move
 * money; Identity verifies the account owner, and in a single-user app the user
 * *is* the owner. Both add Link friction and a per-Item fee for zero benefit.
 */
export const PLAID_PRODUCTS = Object.freeze(['transactions', 'investments', 'liabilities'] as const);

export interface PlaidCapabilityOptions {
  /**
   * `true` only when a webhook URL is actually configured.
   *
   * D12 is "polling of `/transactions/sync` on a 4–6 h cadence plus manual sync;
   * webhooks are an optional compose profile". Declaring `supportsWebhooks: true`
   * because *Plaid* supports them, while this deployment has registered no URL,
   * would be a claim about a push that never arrives.
   */
  readonly webhooksConfigured?: boolean;
}

/**
 * What the orchestrator and the UI branch on.
 *
 * A method-shaped input rather than a frozen constant because one field —
 * `supportsWebhooks` — is a property of *this deployment* and not of Plaid.
 *
 * Notes on the values that are not obvious:
 *
 *   * **`minSyncIntervalSeconds: 14_400`** — D12's "4–6 h cadence", as the
 *     politeness floor the orchestrator refuses to sync inside of. A `manual`
 *     trigger bypasses it, which is right: the user is standing there.
 *   * **`refreshBudgetPerDay: null`** — `/transactions/sync` has a per-minute
 *     limit (50/Item, 01 §1.8), not a daily one, and the interval floor already
 *     keeps us three orders of magnitude clear of it. This field exists for
 *     SimpleFIN's hard ~24/day cap; claiming a number here that Plaid does not
 *     enforce would just be a second, wrong, rate limiter.
 *   * **`consentWindowDays: null`** — there is no single figure. 01 §1.7 lists
 *     Chase (user picks 6 months / 1 year / never), BofA and Capital One
 *     (yearly), USAA (18 months), Brex (3 months). The honest per-Item answer is
 *     Plaid's own `consent_expiration_time`, which `connect` returns as
 *     `ConnectResult.consentExpiresAt`, and `PENDING_EXPIRATION` /
 *     `PENDING_DISCONNECT`, which map to `CONSENT_EXPIRED`.
 *   * **`investment_txns` without a cursor** — 01 §5.5: "There is no
 *     `/investments/transactions/sync`". They arrive through a date window, so
 *     `incremental_sync` describes `/transactions/sync` and nothing else.
 */
export function plaidCapabilities(options: PlaidCapabilityOptions = {}): ConnectorCapabilities {
  return {
    supports: [
      'accounts',
      'balances',
      'transactions',
      'investment_txns',
      'holdings',
      'liabilities',
      'incremental_sync',
      'historical_backfill',
      ...(options.webhooksConfigured === true ? (['webhooks'] as const) : []),
    ] satisfies readonly Capability[],
    historyWindowDays: PLAID_MAX_HISTORY_DAYS,
    minSyncIntervalSeconds: 4 * 60 * 60,
    refreshBudgetPerDay: null,
    supportsWebhooks: options.webhooksConfigured === true,
    // Link in update mode. 01 §1.7: "the `access_token` does not change when
    // using Link in update mode, so there is no need to repeat the exchange
    // token process" — which is why `createUpdateLinkToken` needs the handle and
    // returns nothing to re-seal.
    reconnectFlow: 'provider_hosted',
    consentWindowDays: null,
    currencies: 'multi',
  };
}

export const PLAID_MANIFEST: ConnectorManifest = Object.freeze({
  provider: PLAID_PROVIDER,
  displayName: 'Bank or brokerage (Plaid)',
  description:
    'Connect a bank, credit card, loan or brokerage through Plaid. Transactions, balances, ' +
    'holdings and loan terms sync on a schedule; you sign in at your institution, never here.',
  iconKey: 'bank',
  // Plaid Link runs the flow, including the institution's own OAuth page.
  linkKind: 'provider_hosted',
  docsUrl: 'https://plaid.com/docs/link/',
});
