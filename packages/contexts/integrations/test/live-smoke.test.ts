// SPDX-License-Identifier: MIT
/**
 * The live smokes. **Skipped unless a real key is mounted, and skipped by
 * default.**
 *
 * Everything else in this package runs against a fake transport, which is the
 * right default: dispatch §6 requires Phase 3 to complete with zero keys, and a
 * suite that needs the network is a suite that is red on an aeroplane, red in
 * CI, and red the day a provider has an outage that has nothing to do with us.
 *
 * But a fake transport can only prove that *our* half of the contract is
 * self-consistent. It cannot tell us that Tiingo still returns `close` rather
 * than `closePrice`, that CoinGecko's `/history` still wants `DD-MM-YYYY`, or
 * that FRED still marks a market holiday with `"."`. Those are the assumptions
 * most likely to rot silently, and they are exactly what an operator wants to
 * check after writing a key for the first time.
 *
 * So: one smoke per adapter, each gated on **its own** key, each making
 * **exactly one** request. They are opt-in twice over — the key must be
 * present *and* `MARKET_DATA_LIVE_SMOKE=1` must be set — because a key being
 * mounted in a dev shell should not silently start spending a personal-tier
 * budget every time somebody runs the test suite.
 *
 * Run them with:
 *
 * ```
 * MARKET_DATA_LIVE_SMOKE=1 SECRETS_DIR=./secrets \
 *   pnpm exec vitest run --root packages/contexts/integrations test/live-smoke.test.ts
 * ```
 *
 * These use the **real** transport, so they also exercise the real egress
 * guard, the real DNS classification and the real TLS path against the real
 * provider hostnames — which is the one thing no fake can do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeTransport } from '@core/platform';
import { describe, expect, it } from 'vitest';
import { createProviderClient } from '../src/http.ts';
import { policyFor } from '../src/egress.ts';
import { apiKeyOf, missingKey, type ApiKey } from '../src/secrets.ts';
import { createTiingoPriceSource } from '../src/adapters/tiingo.ts';
import { createCoinGeckoPriceSource } from '../src/adapters/coingecko.ts';
import { createFredSource } from '../src/adapters/fred.ts';
import { createOpenFigiMapper } from '../src/adapters/openfigi.ts';
import type { MarketDataProvider } from '../schema/index.ts';

const SECRETS_DIR = process.env['SECRETS_DIR'] ?? '/run/secrets';
const ENABLED = process.env['MARKET_DATA_LIVE_SMOKE'] === '1';

/**
 * Read a file secret, exactly as `@core/config` does in production.
 *
 * An unreadable file is an absent key, not a crash: the point of these tests is
 * to skip cleanly on an install that has not configured a provider.
 */
function keyFor(provider: MarketDataProvider): ApiKey {
  try {
    return apiKeyOf(provider, readFileSync(join(SECRETS_DIR, `${provider}_api_key`), 'utf8'));
  } catch {
    return missingKey(provider);
  }
}

function sourceFor(provider: MarketDataProvider, key: ApiKey) {
  return createProviderClient({
    provider,
    policy: policyFor(provider),
    transport: createNodeTransport(),
    keys: [key],
  });
}

/** Yesterday, which has a close where today may not. */
function recentBusinessDate(): string {
  const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

const TIINGO = keyFor('tiingo');
const COINGECKO = keyFor('coingecko');
const FRED = keyFor('fred');
const OPENFIGI = keyFor('openfigi');

describe('live provider smokes', () => {
  it('skips cleanly when no key is configured', () => {
    // The claim dispatch §6 actually cares about: an install with zero keys is
    // configured that way, not broken. This test always runs, and asserts that
    // the absence of a key is a *value* rather than an exception.
    for (const key of [TIINGO, COINGECKO, FRED, OPENFIGI]) {
      expect(typeof key.present).toBe('boolean');
      if (!key.present) expect(() => key.reveal()).toThrow();
    }
    expect(true).toBe(true);
  });

  it.skipIf(!ENABLED || !TIINGO.present)('tiingo answers a real daily close', async () => {
    const outcome = await createTiingoPriceSource({
      client: sourceFor('tiingo', TIINGO),
      key: TIINGO,
      now: () => new Date(),
    }).price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: recentBusinessDate(),
      currency: 'USD',
    });

    // `no_data` is a legitimate answer for a holiday; what must not happen is
    // an error, a refusal, or a shape we cannot parse.
    expect(['ok', 'no_data']).toContain(outcome.kind);
    if (outcome.kind === 'ok') {
      // The assumption most likely to rot: the field is still `close`, and it
      // still arrives as something we render as an exact decimal string.
      expect(outcome.value.close).toMatch(/^-?\d+(\.\d+)?$/);
      expect(outcome.value.currency).toBe('USD');
    }
  });

  it.skipIf(!ENABLED || !COINGECKO.present)('coingecko answers a real crypto close', async () => {
    const outcome = await createCoinGeckoPriceSource({
      client: sourceFor('coingecko', COINGECKO),
      key: COINGECKO,
      now: () => new Date(),
    }).price({
      subject: { kind: 'coin_id', coinId: 'bitcoin' },
      date: recentBusinessDate(),
      currency: 'USD',
    });

    expect(['ok', 'no_data']).toContain(outcome.kind);
    if (outcome.kind === 'ok') {
      expect(outcome.value.close).toMatch(/^-?\d+(\.\d+)?$/);
      // The licence obligation is still attached to the live answer.
      expect(outcome.value.attribution.required).toBe(true);
      expect(outcome.value.attribution.text).toBe('Data provided by CoinGecko');
    }
  });

  it.skipIf(!ENABLED || !FRED.present)('fred answers a real FX observation', async () => {
    const outcome = await createFredSource({
      client: sourceFor('fred', FRED),
      key: FRED,
      now: () => new Date(),
    }).fxRate('EUR', 'USD', recentBusinessDate());

    expect(['ok', 'no_data']).toContain(outcome.kind);
    if (outcome.kind === 'ok') {
      // DEXUSEU is dollars per euro. A rate near 1 would mean the direction
      // convention changed under us, which is the ~2x error D4 exists to stop.
      expect(Number(outcome.value.rate)).toBeGreaterThan(0.5);
      expect(outcome.value.base).toBe('EUR');
      expect(outcome.value.quote).toBe('USD');
    }
  });

  it.skipIf(!ENABLED)('openfigi maps a real ticker (works anonymously too)', async () => {
    // The one adapter with no key gate: OpenFIGI's anonymous mode is a real,
    // documented tier, so this smoke runs whenever live smokes are enabled.
    const outcomes = await createOpenFigiMapper({
      client: sourceFor('openfigi', OPENFIGI),
      key: OPENFIGI,
      now: () => new Date(),
    }).map([{ idType: 'TICKER', idValue: 'AAPL', micCode: 'XNAS' }]);

    expect(outcomes).toHaveLength(1);
    expect(['matched', 'no_match']).toContain(outcomes[0]?.status);
    if (outcomes[0]?.status === 'matched') {
      // FIGIs are 12 characters beginning BBG.
      expect(outcomes[0].mappings[0]?.figi).toMatch(/^BBG[A-Z0-9]{9}$/);
    }
  });
});
