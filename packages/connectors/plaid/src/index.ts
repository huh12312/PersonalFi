// SPDX-License-Identifier: MIT
/**
 * `@connector/plaid` — the Plaid adapter for the `Connector` port (WP 1.3).
 *
 * Registered at the composition root:
 *
 * ```ts
 * registry.register({
 *   connector: new PlaidConnector({ api: createPlaidApi(credentials), settings, clock }),
 *   manifest: PLAID_MANIFEST,
 * });
 * ```
 *
 * `createPlaidApi` is the only export that performs I/O or loads axios; import
 * it from `@connector/plaid/…` only where a real client is wanted.
 */
export {
  PLAID_ACCESS_TOKEN,
  PLAID_API_VERSION,
  PLAID_MANIFEST,
  PLAID_MAX_HISTORY_DAYS,
  PLAID_MAX_PAGE_SIZE,
  PLAID_PFC_VERSION,
  PLAID_PRODUCTS,
  PLAID_PROVIDER,
  plaidCapabilities,
  type PlaidCapabilityOptions,
} from './provider.ts';

export {
  silentPlaidLogger,
  type PlaidApiLike,
  type PlaidLinkSettings,
  type PlaidLogger,
  type PlaidResponse,
  type PlaidSandboxApiLike,
} from './api.ts';

export {
  PLAID_CONDITION_BY_CODE,
  PLAID_CONDITION_BY_TYPE,
  asPlaidConnectorError,
  mapPlaidError,
  plaidErrorShapeOf,
  retryAfterMsOf,
  type MapPlaidErrorOptions,
  type PlaidErrorShape,
} from './errors.ts';

export {
  currencyOf,
  moneyOf,
  moneyOrNullOf,
  netWorthSignOf,
  signedAmountOf,
  signedBalanceOf,
} from './amount.ts';

export {
  accountCapabilitiesOf,
  accountFactOf,
  accountTypeOf,
  balanceFactOf,
  currencyByAccountOf,
  decimalStringOf,
  holdingFactOf,
  investmentTransactionFactOf,
  liabilityFactsOf,
  securitiesByIdOf,
  transactionFactOf,
  type PlaidInvestmentTransactionFact,
} from './map.ts';

export {
  PlaidConnector,
  type PlaidConnectInput,
  type PlaidConnectorOptions,
  type PlaidLinkToken,
  type PlaidLinkTokenInput,
  type PlaidUpdateLinkTokenInput,
} from './connector.ts';

export {
  PLAID_ENVIRONMENTS,
  createPlaidApi,
  plaidBasePath,
  plaidRequestHeaders,
  type PlaidCredentials,
  type PlaidEnvironment,
} from './client.ts';
