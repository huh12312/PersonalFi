// SPDX-License-Identifier: MIT
/**
 * `@connector/coinbase/test` — the fake server and the harness, for other
 * packages' suites.
 *
 * The orchestrator's connections tests need a connector that behaves like a real
 * one without a network, and `@ctx/connections` may not import from an adapter's
 * `src/` by path. This barrel is the supported surface, exactly as
 * `@connector/plaid/test` is.
 *
 * **Nothing exported here is a credential.** `TEST_PRIVATE_KEY_PEM` and
 * `TEST_PRIVATE_KEY_BASE64` are an Ed25519 key generated from a constant seed
 * that is written down in `fake.ts` and has never been near Coinbase. They exist
 * so that a log-hygiene scan has an unmistakable string to search for.
 */
export {
  ACCOUNTS_FIXTURE,
  FILLS_FIXTURE,
  FakeCoinbaseApi,
  KEY_PERMISSIONS_FIXTURE,
  PORTFOLIOS_FIXTURE,
  TEST_ECDSA_PRIVATE_KEY_PEM,
  TEST_KEY_NAME,
  TEST_PRIVATE_KEY_BASE64,
  TEST_PRIVATE_KEY_PEM,
  TICKERS_FIXTURE,
  endpointOf,
  type FakeCoinbaseOptions,
  type RecordedRequest,
  type ScriptedFailure,
} from './fake.ts';

export {
  BTC_WALLET,
  DOGE_WALLET,
  ETH_WALLET,
  NOW,
  PORTFOLIO_UUID,
  USD_WALLET,
  clientHarness,
  cursorBeforeTheDeposit,
  handleFor,
  harness,
  recordingLogger,
  syncOptions,
  testClock,
  testCredentials,
  watermarkBeforeTheDeposit,
  type Harness,
  type LogLine,
  type RecordingLogger,
} from './harness.ts';
