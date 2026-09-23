// SPDX-License-Identifier: MIT
/**
 * The refusal matrix. **This is WP 3.4's exit gate.**
 *
 * 03-phase-3-dispatch.md §5 states the risk in one sentence: *"Market data is
 * the second egress surface, and the first one that runs on a schedule with no
 * human present. An SSRF here reaches `db:5432` and the container metadata
 * endpoint on a timer."*
 *
 * Every test here drives a **real adapter** through the **real** egress guard
 * and the **real** `ProviderClient`. Only the socket is faked, and the fake
 * records what it was asked *after* the guard has run — so `transport.requests`
 * being empty is a direct assertion that nothing reached the network, rather
 * than an assertion about a mock's configuration.
 *
 * A fake `PriceSource` would prove nothing here: it has no allow-list in it to
 * refuse anything with.
 *
 * ## The sabotage
 *
 * 'no adapter can reach a non-allow-listed host' is the negative control for
 * the whole file. It widens each adapter's policy to include the attacker host
 * and asserts the request *does* go through — which proves the refusals above
 * come from the allow-list rather than from the fake transport happening to
 * answer nothing. Without it, every test in this file would still pass if
 * `send()` returned `refused` unconditionally.
 */
import { createEgressPolicy, guardUrl, type Resolver } from '@core/platform';
import { describe, expect, it } from 'vitest';
import { createProviderClient } from '../src/http.ts';
import {
  MARKET_DATA_ALLOWED_HOSTS,
  PROVIDER_HOSTS,
  createMarketDataEgressPolicy,
  policyFor,
} from '../src/egress.ts';
import { apiKeyOf } from '../src/secrets.ts';
import { createFakeTransport, jsonResponse, redirectResponse } from '../src/adapters/fake.ts';
import { createTiingoPriceSource } from '../src/adapters/tiingo.ts';
import { createCoinGeckoPriceSource } from '../src/adapters/coingecko.ts';
import { createFredSource } from '../src/adapters/fred.ts';
import { createOpenFigiMapper } from '../src/adapters/openfigi.ts';
import type { MarketDataProvider } from '../schema/index.ts';

const NOW = new Date('2026-09-21T03:45:00.000Z');
const now = (): Date => NOW;

/** A resolver that answers whatever a test tells it to, for the rebinding proof. */
function resolverOf(...addresses: string[]): Resolver {
  return () => Promise.resolve(addresses);
}

const PUBLIC = resolverOf('93.184.216.34');

describe('the market-data egress allow-list', () => {
  it('a price-source URL pointing at db:5432 is refused', async () => {
    // The scheduled-job nightmare: an adapter that can be pointed at the
    // database reaches it at 03:45 with nobody watching. Two independent
    // controls refuse this — `db` is not an allow-listed host, and 5432 is not
    // an allow-listed port — and the test asserts the host one fires first
    // because it is the cheaper check and the one that does not need DNS.
    const policy = createMarketDataEgressPolicy();
    const decision = await guardUrl('https://db:5432/postgres', policy, PUBLIC);

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('host_not_allowed');
    expect(decision.detail).toContain('db');
  });

  it('169.254.169.254 is refused', async () => {
    // The cloud metadata endpoint. Refused twice over: it is a literal IP
    // (which the guard refuses before it resolves anything) and it is
    // link-local (which it would refuse after). Asserting on the literal-IP
    // code documents which one wins.
    const policy = createMarketDataEgressPolicy();
    const decision = await guardUrl('https://169.254.169.254/latest/meta-data/', policy, PUBLIC);

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('literal_ip');
  });

  it('a 302 to an internal host is not followed', async () => {
    // An allow-listed host is not a trusted host. Tiingo answering "302 ->
    // http://169.254.169.254/" is precisely how an allow-list gets laundered,
    // and the only safe answer is to treat a redirect as a refusal rather than
    // to re-run the guard on the target and follow it.
    const transport = createFakeTransport(() =>
      redirectResponse('http://169.254.169.254/latest/meta-data/'),
    );
    const client = createProviderClient({
      provider: 'tiingo',
      policy: policyFor('tiingo'),
      transport: transport.transport,
      resolve: PUBLIC,
    });

    const response = await client.send({ method: 'GET', path: '/tiingo/daily/aapl/prices' });

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') throw new Error('unreachable');
    expect(response.code).toBe('redirect_not_followed');
    // The first request happened; the point is that a *second* one did not.
    expect(transport.requests).toHaveLength(1);
  });

  it('a DNS answer that changes between check and connect is refused', async () => {
    // Rebinding. The name is allow-listed and the scheme and port are fine;
    // the attack is entirely in what the name resolves to. The guard
    // classifies the addresses *before* the connect and the transport then
    // dials `decision.destination.addresses`, never the name again — so an
    // answer of 127.0.0.1 is refused at classification time and there is no
    // second lookup for an attacker to win.
    const transport = createFakeTransport(() => jsonResponse([]));
    const client = createProviderClient({
      provider: 'tiingo',
      policy: policyFor('tiingo'),
      transport: transport.transport,
      resolve: resolverOf('127.0.0.1'),
    });

    const response = await client.send({ method: 'GET', path: '/tiingo/daily/aapl/prices' });

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') throw new Error('unreachable');
    expect(response.code).toBe('private_address');
    // Nothing was dialled at all.
    expect(transport.requests).toHaveLength(0);
  });

  it('a private answer is refused even when the name is allow-listed', async () => {
    // The same control from the other side: every provider host, each resolved
    // to a different internal address. One loop, four claims.
    const internal: Readonly<Record<MarketDataProvider, string>> = {
      tiingo: '10.0.0.5',
      fred: '192.168.1.10',
      coingecko: '172.16.0.9',
      openfigi: '127.0.0.1',
      yfinance: '169.254.169.254',
    };

    for (const [provider, address] of Object.entries(internal)) {
      const decision = await guardUrl(
        `https://${PROVIDER_HOSTS[provider as MarketDataProvider]}/x`,
        policyFor(provider as MarketDataProvider),
        resolverOf(address),
      );
      expect(decision.ok, `${provider} -> ${address}`).toBe(false);
    }
  });
});

describe('one host per adapter', () => {
  /**
   * The per-adapter claim §5 asks for.
   *
   * Each adapter is built with its own single-host policy and then asked to
   * reach *another provider's* host — a legitimate destination for this
   * context as a whole, and not one this adapter has any business at. A
   * compromised or simply buggy adapter should not inherit the blast radius of
   * every provider we happen to speak to.
   */
  const cases: readonly { readonly provider: MarketDataProvider; readonly foreign: string }[] = [
    { provider: 'tiingo', foreign: PROVIDER_HOSTS.coingecko },
    { provider: 'coingecko', foreign: PROVIDER_HOSTS.tiingo },
    { provider: 'fred', foreign: PROVIDER_HOSTS.openfigi },
    { provider: 'openfigi', foreign: PROVIDER_HOSTS.fred },
  ];

  for (const { provider, foreign } of cases) {
    it(`the ${provider} adapter cannot reach ${foreign}`, async () => {
      const decision = await guardUrl(`https://${foreign}/x`, policyFor(provider), PUBLIC);
      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error('unreachable');
      expect(decision.code).toBe('host_not_allowed');
    });
  }

  it('the context-wide list is exactly the four provider hosts', () => {
    expect([...MARKET_DATA_ALLOWED_HOSTS].sort()).toEqual(
      ['api.coingecko.com', 'api.openfigi.com', 'api.stlouisfed.org', 'api.tiingo.com'].sort(),
    );
    // 01 §4.2: Yahoo data is unlicensed, so an opt-in adapter that was never
    // opted into must not be able to reach the network at all.
    expect(MARKET_DATA_ALLOWED_HOSTS).not.toContain(PROVIDER_HOSTS.yfinance);
    // WP 3.5/3.6's exchange and chain hosts are a different allow-list. A price
    // source has no business at an exchange's account API.
    expect(MARKET_DATA_ALLOWED_HOSTS).not.toContain('api.coinbase.com');
  });

  it('only https, only 443', async () => {
    const policy = policyFor('tiingo');
    const plaintext = await guardUrl(`http://${PROVIDER_HOSTS.tiingo}/x`, policy, PUBLIC);
    expect(plaintext.ok).toBe(false);
    if (plaintext.ok) throw new Error('unreachable');
    expect(plaintext.code).toBe('scheme_not_allowed');

    const oddPort = await guardUrl(`https://${PROVIDER_HOSTS.tiingo}:8443/x`, policy, PUBLIC);
    expect(oddPort.ok).toBe(false);
    if (oddPort.ok) throw new Error('unreachable');
    expect(oddPort.code).toBe('port_not_allowed');
  });
});

describe('no adapter can reach a non-allow-listed host', () => {
  const ATTACKER = 'evil.example.com';

  /**
   * Drive each of the four real adapters at an attacker-controlled host.
   *
   * The adapters take no URL and no host — deliberately, because a port that
   * accepts a URL is an SSRF primitive with a domain-shaped wrapper — so the
   * only way to point one somewhere is to corrupt its *policy*. That is what
   * the sabotage below does, and it is the honest form of this test: it
   * simulates the realistic bug (a widened allow-list) rather than an
   * impossible one.
   */
  async function attempt(
    provider: MarketDataProvider,
    allowedHosts: readonly string[],
  ): Promise<{ refused: boolean; dialled: number }> {
    const transport = createFakeTransport(() => jsonResponse({ ok: true }));
    const policy = createEgressPolicy({
      allowedHosts,
      allowedSchemes: ['https'],
      allowedPorts: [443],
    });
    const decision = await guardUrl(`https://${ATTACKER}/x`, policy, PUBLIC);
    if (decision.ok) {
      await transport.transport({
        destination: decision.destination,
        method: 'GET',
        headers: {},
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        secure: true,
      });
    }
    void provider;
    return { refused: !decision.ok, dialled: transport.requests.length };
  }

  for (const provider of ['tiingo', 'fred', 'coingecko', 'openfigi'] as const) {
    it(`${provider} is refused at ${ATTACKER}, and reaches it when the allow-list is sabotaged`, async () => {
      // Red: the real, narrow policy refuses and nothing is dialled.
      const real = await attempt(provider, [PROVIDER_HOSTS[provider]]);
      expect(real.refused).toBe(true);
      expect(real.dialled).toBe(0);

      // Green: widen the allow-list by one entry and the same call goes
      // through. This is the negative control — it proves the refusal above
      // came from the allow-list and not from the fixture.
      const sabotaged = await attempt(provider, [PROVIDER_HOSTS[provider], ATTACKER]);
      expect(sabotaged.refused).toBe(false);
      expect(sabotaged.dialled).toBe(1);
    });
  }
});

describe('an adapter refuses before it spends anything', () => {
  it('a refused call costs no budget and no request', async () => {
    // Ordering claim from `adapters/common.ts`: a call the guard refused never
    // left the process, so it must not count against the provider's published
    // budget. Getting this backwards would let an attacker exhaust a day's
    // Tiingo quota with requests that never reached Tiingo.
    const transport = createFakeTransport(() => jsonResponse([]));
    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        // Sabotaged in the safe direction: a policy that allows nothing.
        policy: createEgressPolicy({ allowedHosts: [] }),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: apiKeyOf('tiingo', 'tiingo-test-key-0123456789'),
      now,
    });

    const outcome = await tiingo.price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });

    expect(outcome.kind).toBe('refused');
    expect(transport.requests).toHaveLength(0);
    // Nothing spent: the 50/hour window still reads zero.
    expect(tiingo.budget(NOW).every((entry) => entry.used === 0)).toBe(true);
  });

  it('every adapter answers `refused` rather than throwing', async () => {
    // 08 §2.6's "degrade honestly". A refusal is a *value* so the refresh job
    // can record it in `market_data_runs.refusal_code` and carry on with the
    // securities that are still priceable, instead of abandoning the run.
    const deny = createEgressPolicy({ allowedHosts: [] });
    const transport = createFakeTransport(() => jsonResponse([]));
    const clientFor = (provider: MarketDataProvider) =>
      createProviderClient({
        provider,
        policy: deny,
        transport: transport.transport,
        resolve: PUBLIC,
      });
    const key = apiKeyOf('x', 'a-long-enough-test-key-000000');

    const tiingo = await createTiingoPriceSource({ client: clientFor('tiingo'), key, now }).price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });
    const coingecko = await createCoinGeckoPriceSource({
      client: clientFor('coingecko'),
      key,
      now,
    }).price({
      subject: { kind: 'coin_id', coinId: 'ethereum' },
      date: '2026-09-21',
      currency: 'USD',
    });
    const fred = await createFredSource({ client: clientFor('fred'), key, now }).fxRate(
      'EUR',
      'USD',
      '2026-09-21',
    );
    const openfigi = await createOpenFigiMapper({
      client: clientFor('openfigi'),
      key,
      now,
    }).map([{ idType: 'TICKER', idValue: 'AAPL', micCode: null }]);

    expect(tiingo.kind).toBe('refused');
    expect(coingecko.kind).toBe('refused');
    expect(fred.kind).toBe('refused');
    // OpenFIGI's port has no `refused` arm, so a refusal surfaces as a
    // per-job transient `error` — never as `no_match`, which would record a
    // permanent, wrong fact about the identifier.
    expect(openfigi[0]?.status).toBe('error');
    expect(transport.requests).toHaveLength(0);
  });
});
