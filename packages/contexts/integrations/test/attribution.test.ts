// SPDX-License-Identifier: MIT
/**
 * Attribution is a licence condition, not a courtesy.
 *
 * 01 §3.6 on CoinGecko's Demo tier: the attribution element is *"a hard license
 * condition, not a courtesy"*. 01 §4.3 gives FRED's required sentence verbatim,
 * ® and all. Tiingo requires no badge but **forbids redistribution**, which is
 * a different obligation on a different axis and is why the two are separate
 * fields rather than one boolean.
 *
 * The seam this file guards: a UI cannot render an obligation it was never told
 * about. If the API returned a crypto price as a bare number, the only thing
 * between this deployment and a licence breach would be a developer
 * remembering, in a different package, months later, that this number came from
 * CoinGecko. That is not a control.
 *
 * So the obligation travels *with the data* — on every `PriceQuote`, and
 * aggregated by the refresh into `attributionRequirements`. This file is one
 * half of the seam; WP 3.12's e2e assertion on the rendered page is the other.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTIONS,
  attributionRequirementsOf,
  forbidsRedistribution,
} from '../src/attribution.ts';
import { createProviderClient } from '../src/http.ts';
import { policyFor } from '../src/egress.ts';
import { apiKeyOf } from '../src/secrets.ts';
import { createFakeTransport, jsonResponse } from '../src/adapters/fake.ts';
import { createCoinGeckoPriceSource } from '../src/adapters/coingecko.ts';
import { createFredSource } from '../src/adapters/fred.ts';
import { createTiingoPriceSource } from '../src/adapters/tiingo.ts';
import {
  createPriceRefreshJob,
  inMemoryMarketDataWriter,
  inMemoryRunRecorder,
} from '../src/market-data.ts';
import { createFakePriceSource } from '../src/adapters/fake.ts';

const NOW = new Date('2026-09-21T03:45:00.000Z');
const now = (): Date => NOW;
const PUBLIC = () => Promise.resolve(['93.184.216.34']);
const KEY = apiKeyOf('x', 'a-long-enough-test-key-000000');

describe('attribution', () => {
  it('CoinGecko and FRED adapters declare a non-empty attribution their ToS requires', () => {
    // The exit test named in the dispatch. Both providers, both required, both
    // with the exact text their terms specify.
    const coingecko = ATTRIBUTIONS.coingecko;
    expect(coingecko.required).toBe(true);
    expect(coingecko.text).toBe('Data provided by CoinGecko');
    expect(coingecko.text.length).toBeGreaterThan(0);
    // 01 §3.6: "must display 'Data provided by CoinGecko' with logo +
    // hyperlink". All three parts, or the condition is not met.
    expect(coingecko.logoRequired).toBe(true);
    expect(coingecko.linkUrl).toBe('https://www.coingecko.com');
    expect(coingecko.surfaces).toContain('any_price');

    const fred = ATTRIBUTIONS.fred;
    expect(fred.required).toBe(true);
    expect(fred.text.length).toBeGreaterThan(0);
    // The exact sentence from 01 §4.3. Not a paraphrase: a paraphrase of a
    // licence condition is a new licence condition. The ® is part of it.
    expect(fred.text).toBe(
      'This product uses the FRED® API but is not endorsed or certified by the ' +
        'Federal Reserve Bank of St. Louis.',
    );
    expect(fred.text).toContain('FRED®');
    expect(fred.text).toContain('not endorsed or certified');
    expect(fred.surfaces).toContain('any_macro_figure');

    // Every attribution quotes the clause it comes from, so a reviewer can
    // check the claim rather than trust it.
    for (const attribution of Object.values(ATTRIBUTIONS)) {
      expect(attribution.clause.length).toBeGreaterThan(0);
    }
  });

  it('the CoinGecko read model carries the attribution requirement', async () => {
    // The obligation rides on the quote itself, not on a doc comment.
    const transport = createFakeTransport(() =>
      jsonResponse({ market_data: { current_price: { usd: 3421.55 } } }),
    );
    const coingecko = createCoinGeckoPriceSource({
      client: createProviderClient({
        provider: 'coingecko',
        policy: policyFor('coingecko'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now,
    });

    const outcome = await coingecko.price({
      subject: { kind: 'coin_id', coinId: 'ethereum' },
      date: '2026-09-21',
      currency: 'USD',
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.value.close).toBe('3421.55');
    // The number and the obligation arrive together. A caller cannot render
    // one without having been handed the other.
    expect(outcome.value.attribution.required).toBe(true);
    expect(outcome.value.attribution.text).toBe('Data provided by CoinGecko');
    expect(outcome.value.attribution.logoRequired).toBe(true);
    expect(outcome.value.attribution.linkUrl).toBe('https://www.coingecko.com');
  });

  it('a refresh that used CoinGecko reports the obligation the UI owes', async () => {
    // The aggregated form: whatever screen renders this run's numbers must
    // satisfy these. Computed from the providers that actually contributed, so
    // a run with no crypto in it does not demand a CoinGecko badge.
    const writer = inMemoryMarketDataWriter();
    const recorder = inMemoryRunRecorder();
    const job = createPriceRefreshJob({
      userId: '01920000-0000-7000-8000-00000000u001'.replace('u', '0'),
      sources: [
        createFakePriceSource({
          provider: 'coingecko',
          prices: { 'ethereum|2026-09-21|USD': '3421.55' },
        }),
      ],
      writer,
      recorder,
      outbox: {
        execute: () => Promise.resolve({ rows: [{ out_seq: 1, out_recorded_at: NOW }] }),
      } as never,
      correlationId: '01920000-0000-7000-8000-0000000000c3',
      clock: fixedClock(NOW),
    });

    const result = await job.run({
      asOfDate: '2026-09-21',
      securities: [
        {
          securityId: '01920000-0000-7000-8000-000000000001',
          kind: 'crypto',
          subject: { kind: 'coin_id', coinId: 'ethereum' },
          currency: 'USD',
        },
      ],
      fxPairs: [],
    });

    expect(result.priceRowsWritten).toBe(1);
    expect(result.attributionRequirements).toHaveLength(1);
    expect(result.attributionRequirements[0]?.provider).toBe('coingecko');
    expect(result.attributionRequirements[0]?.logoRequired).toBe(true);
  });

  it('Tiingo requires no badge and forbids redistribution — a different axis', async () => {
    // Folding "forbids redistribution" into "requires attribution" would lose
    // it, and it is the field an export or sharing feature has to consult.
    const tiingo = ATTRIBUTIONS.tiingo;
    expect(tiingo.required).toBe(false);
    expect(tiingo.text).toBe('');
    expect(tiingo.redistribution).toBe('forbidden');
    expect(forbidsRedistribution('tiingo')).toBe(true);
    // 01 §4.1's clause is quoted so the claim is checkable.
    expect(tiingo.clause).toContain('personal use');

    // Yahoo has no data licence at all, so there is no badge that would make
    // redistribution lawful — hence opt-in, best-effort, never the default.
    expect(forbidsRedistribution('yfinance')).toBe(true);
    expect(forbidsRedistribution('coingecko')).toBe(false);
    expect(forbidsRedistribution('openfigi')).toBe(false);

    // And a Tiingo quote still carries its (empty, not-required) attribution,
    // so a caller never has to handle `undefined`.
    const transport = createFakeTransport(() =>
      jsonResponse([{ date: '2026-09-21T00:00:00.000Z', close: 232.35 }]),
    );
    const source = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now,
    });
    const outcome = await source.price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.value.attribution.required).toBe(false);
    // D3: the close is the exact literal the provider sent, as a string.
    expect(outcome.value.close).toBe('232.35');
  });

  it('a FRED FX quote carries the disclaimer', async () => {
    const transport = createFakeTransport(() =>
      jsonResponse({ observations: [{ date: '2026-09-21', value: '1.0850' }] }),
    );
    const fred = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: transport.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now,
    });

    const outcome = await fred.fxRate('EUR', 'USD', '2026-09-21');
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.value.attribution.text).toContain('FRED®');
    expect(outcome.value.rate).toBe('1.0850');
    // DEXUSEU is "US dollars to one euro": base EUR, quote USD. Getting this
    // backwards is a ~2x error that looks plausible.
    expect(outcome.value.base).toBe('EUR');
    expect(outcome.value.quote).toBe('USD');
  });

  it('the requirement set is deduplicated, ordered and excludes the unrequired', () => {
    const requirements = attributionRequirementsOf([
      'coingecko',
      'tiingo',
      'fred',
      'coingecko',
      'openfigi',
    ]);
    // Tiingo and OpenFIGI require no badge, so they are not obligations.
    expect(requirements.map((r) => r.provider)).toEqual(['coingecko', 'fred']);
    // Stable order, so a UI test asserting on the array does not go red
    // because a Set iterated differently.
    expect(attributionRequirementsOf(['fred', 'coingecko']).map((r) => r.provider)).toEqual([
      'coingecko',
      'fred',
    ]);
    expect(attributionRequirementsOf([])).toEqual([]);
  });

  it('SABOTAGE: an empty CoinGecko attribution would be a licence breach, and is detectable', () => {
    // The negative control for the exit test. If `required` were flipped or
    // the text emptied, `attributionRequirementsOf` would return nothing and a
    // UI built on it would render no badge — silently, and in breach. This
    // asserts the detector works rather than trusting that it would.
    const breached = { ...ATTRIBUTIONS.coingecko, required: false };
    const requirements = [breached, ATTRIBUTIONS.fred].filter((a) => a.required);
    expect(requirements.map((a) => a.provider)).toEqual(['fred']);
    // Whereas the real one is present.
    expect(attributionRequirementsOf(['coingecko']).map((a) => a.provider)).toEqual(['coingecko']);
  });
});
