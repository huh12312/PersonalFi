// SPDX-License-Identifier: MIT
/**
 * `@connector/coinbase` — the read-only Coinbase adapter (WP 3.5).
 *
 * Registered at the composition root, feature-detected on the two secret files
 * exactly as Plaid is on its three:
 *
 * ```ts
 * registry.register({
 *   connector: new CoinbaseConnector({ transport: fetchTransport(), clock }),
 *   manifest: COINBASE_MANIFEST,
 * });
 * ```
 *
 * `fetchTransport` is the only export that performs I/O. Everything else is a
 * pure function over provider shapes, which is what lets the whole suite —
 * conformance, JWT, permissions, on-ramp, log hygiene — run with no network.
 */
export {
  CDP_JWT_ALGORITHM,
  CDP_JWT_AUDIENCE,
  CDP_JWT_ISSUER,
  CDP_JWT_LIFETIME_SECONDS,
  CDP_JWT_NONCE_BYTES,
  CDP_KEY_NAME,
  CDP_KEY_NAME_PATTERN,
  CDP_PRIVATE_KEY,
  COINBASE_API_HOST,
  COINBASE_BROKERAGE_PREFIX,
  COINBASE_CREDENTIAL_NAMES,
  COINBASE_HISTORY_WINDOW_DAYS,
  COINBASE_MANIFEST,
  COINBASE_MAX_ACCOUNTS_PAGE_SIZE,
  COINBASE_MAX_FILLS_PAGE_SIZE,
  COINBASE_MAX_PAGES,
  COINBASE_PROVIDER,
  COINBASE_QUOTE_CURRENCY,
  COINBASE_READ_ONLY_PATHS,
  COINBASE_REQUEST_TIMEOUT_MS,
  coinbaseCapabilities,
  coinbaseProductIdOf,
  coinbaseTickerPath,
  type CoinbaseReadOnlyPath,
} from './provider.ts';

export {
  cdpRequestUri,
  decodeCdpJwtForTest,
  mintCdpJwt,
  parseCdpPrivateKey,
  type CdpJwtInput,
  type DecodedCdpJwt,
} from './jwt.ts';

export {
  silentCoinbaseLogger,
  type CoinbaseAccount,
  type CoinbaseAccountsPage,
  type CoinbaseAmount,
  type CoinbaseApiLike,
  type CoinbaseFill,
  type CoinbaseFillsPage,
  type CoinbaseHttpResponse,
  type CoinbaseKeyPermissions,
  type CoinbaseLogger,
  type CoinbaseMethod,
  type CoinbasePortfolio,
  type CoinbasePortfoliosResponse,
  type CoinbaseRequest,
  type CoinbaseTickerResponse,
  type CoinbaseTrade,
  type CoinbaseTransport,
} from './api.ts';

export {
  COINBASE_CONDITION_BY_NAME,
  COINBASE_CONDITION_BY_STATUS,
  asCoinbaseTransportError,
  coinbaseErrorShapeOf,
  mapCoinbaseError,
  retryAfterMsOf,
  type CoinbaseErrorShape,
  type MapCoinbaseErrorOptions,
} from './errors.ts';

export {
  USD_CODE,
  fiatCurrencyOf,
  fiatMoneyOf,
  malformed,
  negatedDecimal,
  quantityOf,
  signOfDecimal,
  sumDecimals,
  usdValueOf,
  type AssetCode,
} from './amount.ts';

export {
  COINBASE_FIAT_ACCOUNT_TYPE,
  accountCapabilitiesOf,
  accountFactOf,
  accountIdByAssetOf,
  assetCodeOf,
  balanceFactOf,
  baseEffectOf,
  baseQuantityOf,
  dateOnlyOfInstant,
  fillIdOf,
  grossQuoteOf,
  holdingFactOf,
  instantOf,
  investmentTransactionFactOf,
  isFiatAccount,
  productOf,
  quoteEffectOf,
  securityFactOf,
  securityIdentifierOfAsset,
  sideOf,
  totalBalanceOf,
} from './map.ts';

export {
  COINBASE_CURSOR_PREFIX,
  decodeWatermark,
  encodeWatermark,
  type CoinbaseWatermark,
} from './cursor.ts';

export {
  COINBASE_TRANSFER_IN_PFC,
  COINBASE_TRANSFER_OUT_PFC,
  inferOnRampTransfers,
  type OnRampInference,
  type OnRampInferenceOptions,
} from './ledger.ts';

export {
  COINBASE_LEDGER_GAP,
  LEDGER_GAP_VERDICTS,
  LEDGER_MOVEMENTS,
  RECONSTRUCTIBILITY,
  probeLedgerGap,
  reconcile,
  type AssetReconciliation,
  type EndpointProbe,
  type LedgerGapReport,
  type LedgerGapRow,
  type LedgerGapVerdict,
  type LedgerMovement,
  type Reconstructibility,
} from './ledger-gap.ts';

export {
  CoinbaseClient,
  assertReadOnlyPath,
  endpointLabelOf,
  fetchTransport,
  isReadOnlyPath,
  type CoinbaseClientOptions,
  type CoinbaseCredentials,
} from './client.ts';

export {
  CoinbaseConnector,
  credentialsFrom,
  parseConnectInput,
  type CoinbaseConnectInput,
  type CoinbaseConnectorOptions,
} from './connector.ts';
