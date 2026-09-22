// SPDX-License-Identifier: MIT
/**
 * Everything the Coinbase suites share: the fake server, a connector wired to
 * it, a fixed clock and a handle that really does hand back a key.
 *
 * Re-stated here rather than imported from `@ctx/connections`' harness for the
 * same reason `@connector/plaid`'s is: `personalfi/layer-imports` denies
 * `packages/connectors/*` → `@ctx/*`, and that rule is what keeps an adapter
 * free of the orchestrator. Thirty lines of duplication is the price and it is
 * the right price.
 *
 * The handle's `secret` is a **closure over a parameter**, never a field. The
 * conformance check `secrets/a serialised handle contains no credential` is only
 * meaningful if the handle under test is one that genuinely holds a credential
 * to leak, and `custody.test.ts` depends on the same property.
 */
import type { ConnectionHandle, Cursor, SyncOptions } from '@connector/port';
import { mutableClock, type MutableClock } from '@core/kernel';
import type { CoinbaseLogger } from '../src/api.ts';
import { CoinbaseClient, type CoinbaseCredentials } from '../src/client.ts';
import { CoinbaseConnector } from '../src/connector.ts';
import { encodeWatermark, type CoinbaseWatermark } from '../src/cursor.ts';
import { CDP_KEY_NAME, CDP_PRIVATE_KEY } from '../src/provider.ts';
import {
  FakeCoinbaseApi,
  TEST_KEY_NAME,
  TEST_PRIVATE_KEY_BASE64,
  type FakeCoinbaseOptions,
} from './fake.ts';

/** Fixed, and after every instant in the fixtures, so nothing drifts with wall time. */
export const NOW = new Date('2026-09-22T12:00:00.000Z');

/** The uuids from `fixtures/accounts.json`, named so tests read as prose. */
export const USD_WALLET = '9f0c1a52-0000-4000-8000-0000000000u1';
export const BTC_WALLET = '9f0c1a52-0000-4000-8000-0000000000b1';
export const ETH_WALLET = '9f0c1a52-0000-4000-8000-0000000000e1';
export const DOGE_WALLET = '9f0c1a52-0000-4000-8000-0000000000d1';
export const PORTFOLIO_UUID = '3a1b8c44-0000-4000-8000-0000000000p1';

export function testClock(): MutableClock {
  return mutableClock(NOW);
}

export function syncOptions(
  clock: MutableClock = testClock(),
  overrides: Partial<SyncOptions> = {},
): SyncOptions {
  return {
    reason: 'scheduled',
    historyDays: 730,
    pageSize: 250,
    deadline: new Date(clock.nowMs() + 60_000),
    signal: new AbortController().signal,
    clock,
    ...overrides,
  };
}

export function testCredentials(): CoinbaseCredentials {
  return { keyName: TEST_KEY_NAME, privateKeyMaterial: TEST_PRIVATE_KEY_BASE64 };
}

/**
 * A handle that hands back both halves of the sealed pair, as
 * `@ctx/connections` does after opening the blob.
 */
export function handleFor(
  credentials: CoinbaseCredentials | null = testCredentials(),
  overrides: Partial<Omit<ConnectionHandle, 'secret'>> = {},
): ConnectionHandle {
  return {
    connectionId: '01930000-0000-7000-8000-00000000cb01',
    userId: '01920000-0000-7000-8000-0000000000aa',
    provider: 'coinbase',
    providerConnectionId: PORTFOLIO_UUID,
    secret: (name) => {
      if (credentials === null) return null;
      if (name === CDP_KEY_NAME) return credentials.keyName;
      if (name === CDP_PRIVATE_KEY) return credentials.privateKeyMaterial;
      return null;
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LogLine {
  readonly level: 'debug' | 'warn';
  readonly context: Record<string, unknown>;
  readonly message: string;
}

export interface RecordingLogger extends CoinbaseLogger {
  readonly lines: LogLine[];
}

/**
 * Captures every log call, context object included and **by reference**.
 *
 * A leak that only appears when something else serialises the object later — a
 * pino `util.inspect` fallback, an unhandled-rejection dump — is precisely the
 * leak `log-hygiene.test.ts` has to be able to see, and eagerly stringifying
 * here would hide it.
 */
export function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  return {
    lines,
    debug: (context, message) => void lines.push({ level: 'debug', context, message }),
    warn: (context, message) => void lines.push({ level: 'warn', context, message }),
  };
}

// ---------------------------------------------------------------------------
// The connector, wired
// ---------------------------------------------------------------------------

export interface Harness {
  readonly api: FakeCoinbaseApi;
  readonly connector: CoinbaseConnector;
  readonly logger: RecordingLogger;
  readonly clock: MutableClock;
  readonly handle: ConnectionHandle;
  readonly options: SyncOptions;
}

export function harness(options: FakeCoinbaseOptions = {}): Harness {
  const clock = testClock();
  const api = new FakeCoinbaseApi({ nowMs: () => clock.nowMs(), ...options });
  const logger = recordingLogger();
  const connector = new CoinbaseConnector({ transport: api.transport, clock, logger });
  return { api, connector, logger, clock, handle: handleFor(), options: syncOptions(clock) };
}

/** A client on the same fake, for the tests that are about one request. */
export function clientHarness(options: FakeCoinbaseOptions = {}): {
  readonly api: FakeCoinbaseApi;
  readonly client: CoinbaseClient;
  readonly logger: RecordingLogger;
  readonly clock: MutableClock;
} {
  const clock = testClock();
  const api = new FakeCoinbaseApi({ nowMs: () => clock.nowMs(), ...options });
  const logger = recordingLogger();
  const client = new CoinbaseClient({
    transport: api.transport,
    credentials: testCredentials(),
    clock,
    logger,
  });
  return { api, client, logger, clock };
}

/**
 * The watermark a previous sync would have left, with the USD wallet empty.
 *
 * `'0'` and the first of September are the two numbers the on-ramp arithmetic
 * turns into `+5,000.00`; `onramp.test.ts` shows the working.
 */
export function watermarkBeforeTheDeposit(
  overrides: Partial<CoinbaseWatermark> = {},
): CoinbaseWatermark {
  return { at: '2026-09-01T00:00:00.000Z', fiat: { [USD_WALLET]: '0' }, ...overrides };
}

export function cursorBeforeTheDeposit(): Cursor {
  return encodeWatermark(watermarkBeforeTheDeposit());
}
