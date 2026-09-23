// SPDX-License-Identifier: MIT
/**
 * *'the Tiingo adapter refuses its own 1,001st call of a day rather than being
 * refused'*.
 *
 * ## The posture, and why it is not the same as handling a 429
 *
 * A provider that refuses us answers 429 — *sometimes*. Tiingo's free tier is
 * documented at 1,000 requests/day; what happens at 1,001 is Tiingo's business
 * and might be a 429, might be a 403, might be a silent throttle, and on a bad
 * day might be an account suspension for a personal-tier key whose ToS we are
 * one automation bug away from abusing. Discovering the limit by hitting it is
 * a strategy that works until the one time it does not.
 *
 * So the budget is ours. The 1,001st call never leaves the process, and the
 * test asserts exactly that by counting what reached the fake transport.
 *
 * The published numbers are in the code (dispatch §3): Tiingo 50/hr **and**
 * 1,000/day, FRED 120/60 s, CoinGecko ~100/min and 10,000 credits/month,
 * OpenFIGI 25,000 jobs/min. Each is asserted below against its documented
 * value, so a typo in a limit is a failing test rather than a ToS violation.
 */
import { describe, expect, it } from 'vitest';
import {
  COINGECKO_WINDOWS,
  FRED_WINDOWS,
  OPENFIGI_WINDOWS,
  TIINGO_WINDOWS,
  YFINANCE_WINDOWS,
  createRateBudget,
} from '../src/rate-limit.ts';
import { createProviderClient } from '../src/http.ts';
import { policyFor } from '../src/egress.ts';
import { apiKeyOf } from '../src/secrets.ts';
import { createFakeTransport, jsonResponse } from '../src/adapters/fake.ts';
import { createTiingoPriceSource } from '../src/adapters/tiingo.ts';
import { createCoinGeckoPriceSource } from '../src/adapters/coingecko.ts';
import { createFredSource } from '../src/adapters/fred.ts';
import { createOpenFigiMapper } from '../src/adapters/openfigi.ts';

const PUBLIC = () => Promise.resolve(['93.184.216.34']);
const KEY = apiKeyOf('tiingo', 'a-long-enough-test-key-000000');

describe('client-side rate budgets', () => {
  it('the Tiingo adapter refuses its own 1,001st call of a day rather than being refused', async () => {
    // A clock we advance by hand, so a thousand calls do not take a thousand
    // seconds and the hourly window does not bind before the daily one.
    let clock = new Date('2026-09-21T00:00:00.000Z');
    const now = (): Date => clock;

    const budget = createRateBudget(TIINGO_WINDOWS);
    const transport = createFakeTransport(() =>
      jsonResponse([{ date: '2026-09-21T00:00:00.000Z', close: 232.35 }]),
    );
    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now,
      budget,
    });

    const call = () =>
      tiingo.price({
        subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
        date: '2026-09-21',
        currency: 'USD',
      });

    // Spend the day's 1,000, stepping 80 seconds each time so the 50/hour
    // window (45 calls per hour at this pace) never binds first. 1,000 calls
    // × 80 s is a little over 22 hours — inside one day, which is the point.
    for (let i = 0; i < 1_000; i += 1) {
      const outcome = await call();
      expect(outcome.kind, `call ${String(i + 1)} should have gone through`).toBe('ok');
      clock = new Date(clock.getTime() + 80_000);
    }
    expect(transport.requests).toHaveLength(1_000);

    // The 1,001st.
    const refused = await call();
    expect(refused.kind).toBe('rate_limited');
    if (refused.kind !== 'rate_limited') throw new Error('unreachable');
    expect(refused.detail).toContain('1,000/day');
    // Ours, not theirs — said so in the message, and provable by the fact that
    // the transport was never asked.
    expect(refused.detail).toContain('refused here, not by the provider');
    expect(transport.requests).toHaveLength(1_000);

    // `retryAfterMs` is the whole point: a scheduler that knows *when* can
    // wait, and one that only knows *no* will drop the work or spin.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('the hourly window binds before the daily one when calls are bunched', async () => {
    // The reason both windows exist. A refresh that respected only the daily
    // number would burn the hourly one in ninety seconds.
    const clock = new Date('2026-09-21T00:00:00.000Z');
    const budget = createRateBudget(TIINGO_WINDOWS);
    const transport = createFakeTransport(() => jsonResponse([]));
    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now: () => clock,
      budget,
    });

    const call = () =>
      tiingo.price({
        subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
        date: '2026-09-21',
        currency: 'USD',
      });

    for (let i = 0; i < 50; i += 1) {
      // `no_data` — the fake returns an empty bar array — but the request was
      // made and therefore spent.
      expect((await call()).kind).toBe('no_data');
    }
    const refused = await call();
    expect(refused.kind).toBe('rate_limited');
    if (refused.kind !== 'rate_limited') throw new Error('unreachable');
    expect(refused.detail).toContain('50/hour');
    expect(transport.requests).toHaveLength(50);
  });

  it('the documented numbers are the ones in the code', () => {
    // Dispatch §3 requires the published number *in the code*. A typo here is
    // a ToS violation, so it is asserted rather than trusted.
    expect(TIINGO_WINDOWS.map((w) => [w.limit, w.windowMs])).toEqual([
      [50, 60 * 60 * 1000],
      [1_000, 24 * 60 * 60 * 1000],
    ]);
    expect(FRED_WINDOWS.map((w) => [w.limit, w.windowMs])).toEqual([[120, 60_000]]);
    expect(COINGECKO_WINDOWS.map((w) => [w.limit, w.windowMs, w.unit])).toEqual([
      [100, 60_000, 'request'],
      // A sliding 30 days, not a calendar month: a calendar bucket would permit
      // 10,000 on the 31st and 10,000 more on the 1st.
      [10_000, 30 * 24 * 60 * 60 * 1000, 'credit'],
    ]);
    // Jobs, not requests — 100 symbols in one POST costs 100.
    expect(OPENFIGI_WINDOWS.map((w) => [w.limit, w.unit])).toEqual([[25_000, 'job']]);
    // Yahoo publishes no quota; a self-imposed conservative one is the honest
    // answer for an opt-in, best-effort adapter (01 §4.2).
    expect(YFINANCE_WINDOWS[0]?.limit).toBe(60);
  });

  it('the window slides rather than resetting on the hour', () => {
    // A fixed hourly bucket lets 100 calls through at 10:59 and 11:01 while
    // claiming to permit 50/hour.
    const budget = createRateBudget([
      { windowMs: 3_600_000, limit: 2, unit: 'request', label: '2/hour' },
    ]);
    const t0 = new Date('2026-09-21T10:30:00.000Z');
    budget.record(1, t0);
    budget.record(1, new Date('2026-09-21T10:59:00.000Z'));

    expect(budget.check(1, new Date('2026-09-21T11:01:00.000Z')).ok).toBe(false);
    // Only once the first spend falls out of the trailing hour.
    expect(budget.check(1, new Date('2026-09-21T11:31:00.000Z')).ok).toBe(true);
  });

  it('a restart does not reset the day: the budget hydrates from durable history', () => {
    // The 03:45 failure this prevents: a worker that restarts at 03:44 would
    // otherwise start the refresh with an empty counter and no memory of the
    // 900 requests it made at 03:15 — which is exactly how a personal-tier key
    // gets used the way its ToS forbids.
    const budget = createRateBudget(TIINGO_WINDOWS);
    const now = new Date('2026-09-21T03:45:00.000Z');
    // 999 spends spread over the preceding ~22 hours, so the *daily* window is
    // the one that is nearly full. Bunching them into a few minutes would make
    // the 50/hour window bind instead and the test would prove the wrong thing.
    const oldest = now.getTime() - 22 * 60 * 60 * 1000;
    const step = (21 * 60 * 60 * 1000) / 999;
    budget.hydrate(
      Array.from({ length: 999 }, (_, i) => ({ at: new Date(oldest + i * step), cost: 1 })),
    );

    expect(budget.check(1, now).ok).toBe(true);
    budget.record(1, now);
    // The 1,001st is refused across the restart boundary.
    expect(budget.check(1, now).ok).toBe(false);
  });

  it('a spend is only recorded for a request that actually left', async () => {
    // Ordering claim from `adapters/common.ts`. A call the egress guard refused
    // costs the provider nothing and must cost us nothing — otherwise an
    // attacker could exhaust a day's quota with calls that never reached it.
    const budget = createRateBudget(TIINGO_WINDOWS);
    const now = new Date('2026-09-21T03:45:00.000Z');
    const transport = createFakeTransport(() => jsonResponse([]));

    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        // Allows nothing: every call is refused before the socket.
        policy: policyFor('coingecko'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now: () => now,
      budget,
    });

    await tiingo.price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });

    expect(transport.requests).toHaveLength(0);
    expect(budget.spent(now).every((e) => e.used === 0)).toBe(true);
  });

  it('a missing key spends nothing and dials nothing', async () => {
    // §6: "Phase 3 completes with zero keys." An install without a provider
    // key is configured that way, not broken — it must not burn budget
    // discovering that, and above all it must not *throw*.
    //
    // It very nearly did. `reveal()` on an absent key throws by design (so a
    // missing key can never be sent as `Token ` and come back as a 401 that
    // looks like a bad key), and every adapter used to build its request —
    // including the credential — before `callJson` got to check `key.present`.
    // The request is now built lazily, so the check happens first. This test
    // covers all four adapters because the bug was in the shared path.
    const now = new Date('2026-09-21T03:45:00.000Z');
    const absent = apiKeyOf('x', '');
    const transport = createFakeTransport(() => jsonResponse([]));
    const clientFor = (provider: 'tiingo' | 'coingecko' | 'fred' | 'openfigi') =>
      createProviderClient({
        provider,
        policy: policyFor(provider),
        transport: transport.transport,
        resolve: PUBLIC,
      });

    const budget = createRateBudget(TIINGO_WINDOWS);
    const tiingo = createTiingoPriceSource({
      client: clientFor('tiingo'),
      key: absent,
      now: () => now,
      budget,
    });
    expect(
      (
        await tiingo.price({
          subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
          date: '2026-09-21',
          currency: 'USD',
        })
      ).kind,
    ).toBe('skipped_no_key');
    expect((await tiingo.search('AAPL')).kind).toBe('skipped_no_key');
    expect(tiingo.hasKey).toBe(false);

    const coingecko = createCoinGeckoPriceSource({
      client: clientFor('coingecko'),
      key: absent,
      now: () => now,
    });
    expect(
      (
        await coingecko.price({
          subject: { kind: 'coin_id', coinId: 'ethereum' },
          date: '2026-09-21',
          currency: 'USD',
        })
      ).kind,
    ).toBe('skipped_no_key');

    const fred = createFredSource({ client: clientFor('fred'), key: absent, now: () => now });
    expect((await fred.fxRate('EUR', 'USD', '2026-09-21')).kind).toBe('skipped_no_key');
    expect((await fred.macro('DGS10', '2026-09-21')).kind).toBe('skipped_no_key');

    // OpenFIGI is the exception and it is deliberate: it genuinely works
    // anonymously at a tenth of the batch size, so a missing key is a degraded
    // mode rather than a skip. It must still not throw, and must still not
    // send an empty key header.
    const openfigi = createOpenFigiMapper({
      client: clientFor('openfigi'),
      key: absent,
      now: () => now,
    });
    const mapped = await openfigi.map([{ idType: 'TICKER', idValue: 'AAPL', micCode: null }]);
    expect(mapped).toHaveLength(1);

    // Nothing was dialled by the three that skipped; OpenFIGI's one anonymous
    // request is the only thing that could have reached the transport.
    expect(transport.requests.length).toBeLessThanOrEqual(1);
    for (const request of transport.requests) {
      expect(request.headers['x-openfigi-apikey']).toBeUndefined();
    }
    expect(budget.spent(now).every((e) => e.used === 0)).toBe(true);
  });

  it('a budget refuses a nonsensical limit at construction', () => {
    expect(() =>
      createRateBudget([{ windowMs: 1_000, limit: 0, unit: 'request', label: 'x' }]),
    ).toThrow(RangeError);
    expect(() =>
      createRateBudget([{ windowMs: 0, limit: 1, unit: 'request', label: 'x' }]),
    ).toThrow(RangeError);
  });

  it('SABOTAGE: raising the documented limit lets the 1,001st call through', async () => {
    // The negative control. This is the realistic bug — somebody "fixes" a
    // rate-limited refresh by editing the number — and it proves the refusal
    // above came from the budget rather than from the fixture running out of
    // responses.
    const clock = new Date('2026-09-21T00:00:00.000Z');
    const generous = createRateBudget([
      { windowMs: 24 * 60 * 60 * 1000, limit: 100_000, unit: 'request', label: 'sabotaged' },
    ]);
    const transport = createFakeTransport(() => jsonResponse([]));
    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now: () => clock,
      budget: generous,
    });

    generous.hydrate(Array.from({ length: 1_000 }, () => ({ at: clock, cost: 1 })));
    const outcome = await tiingo.price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });

    // With the sabotaged budget the call reaches the network. With
    // TIINGO_WINDOWS it would have been `rate_limited` and dialled nothing.
    expect(outcome.kind).not.toBe('rate_limited');
    expect(transport.requests).toHaveLength(1);
  });
});
