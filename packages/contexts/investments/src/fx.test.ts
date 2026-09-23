// SPDX-License-Identifier: MIT
/**
 * *'a missing FX rate is an explicit error, never 1.0'*.
 *
 * D4 and 08 §6.6. The failure being prevented is a CAD account quietly
 * counting as USD: arithmetically clean, entirely plausible on screen, wrong by
 * the whole spread, and invisible forever. A thrown `FxRateUnavailable` is the
 * opposite in every respect.
 *
 * The sabotage at the end is the negative control. Every test in this file
 * would still pass against an implementation that threw unconditionally, so one
 * test proves a rate *is* returned when one exists — and one proves that the
 * only 1.0 the module can produce is the identity, which is reachable solely
 * when the two codes are literally equal.
 */
import { describe, expect, it } from 'vitest';
import {
  FxRateUnavailable,
  createFxReader,
  inMemoryFxStore,
  invert,
  isFxRateUnavailable,
  type FxRateRecord,
} from './fx.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const OBSERVED = new Date('2026-09-21T03:45:00.000Z');

function record(partial: Partial<FxRateRecord> = {}): FxRateRecord {
  return {
    base: 'EUR',
    quote: 'USD',
    rate: '1.0850000000',
    rateDate: '2026-09-21',
    source: 'fred',
    observedAt: OBSERVED,
    ...partial,
  };
}

function readerOver(records: readonly FxRateRecord[]) {
  return createFxReader({ store: inMemoryFxStore(records), userId: USER });
}

describe('FxReader', () => {
  it('a missing FX rate is an explicit error, never 1.0', async () => {
    // Nothing stored at all.
    const reader = readerOver([]);

    await expect(reader.rate('EUR', 'USD', '2026-09-21')).rejects.toThrow(FxRateUnavailable);

    // And the error is *useful*: 08 §6.6 requires "a UI affordance to enter one
    // manually", which needs to know which rate it is asking for.
    const error = await reader.rate('CAD', 'USD', '2026-09-21').catch((e: unknown) => e);
    expect(isFxRateUnavailable(error)).toBe(true);
    if (!isFxRateUnavailable(error)) throw new Error('unreachable');
    expect(error.base).toBe('CAD');
    expect(error.quote).toBe('USD');
    expect(error.date).toBe('2026-09-21');
    expect(error.consulted).toEqual(['CAD/USD', 'USD/CAD (inverted)']);
    expect(error.message).toContain('rather than a 1.0');
  });

  it('never returns 1 for a pair it has no observation for', async () => {
    // The property the whole design exists for, stated directly. A rate of
    // exactly 1 may only ever come back for the identity.
    const reader = readerOver([]);
    const pairs: readonly [string, string][] = [
      ['CAD', 'USD'],
      ['USD', 'CAD'],
      ['EUR', 'GBP'],
      ['JPY', 'CHF'],
      ['AUD', 'NZD'],
    ];

    for (const [from, to] of pairs) {
      const result = await reader.rate(from, to, '2026-09-21').catch(() => 'threw' as const);
      expect(result, `${from}/${to} must not silently convert at par`).toBe('threw');
    }
  });

  it('the identity is answered structurally, without reading a row', async () => {
    // The one legitimate 1.0. It is labelled `identity`, so a read model can
    // always tell a tautology from something a provider said.
    const store = inMemoryFxStore([]);
    let reads = 0;
    const counting = {
      latestOnOrBefore: (...args: Parameters<typeof store.latestOnOrBefore>) => {
        reads += 1;
        return store.latestOnOrBefore(...args);
      },
    };
    const reader = createFxReader({ store: counting, userId: USER });

    const rate = await reader.rate('USD', 'USD', '2026-09-21');
    expect(rate.rate).toBe('1');
    expect(rate.source).toBe('identity');
    expect(rate.inverted).toBe(false);
    // No query at all — which is why no stored 1.0 can ever be mistaken for a
    // fetched one, and why a fixture cannot accidentally create one.
    expect(reads).toBe(0);

    // Case and whitespace do not make two currencies different.
    expect((await reader.rate('usd', ' USD ', '2026-09-21')).source).toBe('identity');
  });

  it('the identity rate can never be stored', () => {
    // `fx_rates_is_a_real_pair` in the migration; the fake enforces it too, so
    // a unit test cannot pass because of a row Postgres would have refused.
    expect(() => inMemoryFxStore([record({ base: 'USD', quote: 'USD', rate: '1' })])).toThrow(
      /fx_rates_is_a_real_pair/,
    );
  });

  it('returns the stored rate with the provenance D4 requires', async () => {
    const reader = readerOver([record()]);
    const rate = await reader.rate('EUR', 'USD', '2026-09-21');

    expect(rate.rate).toBe('1.0850000000');
    expect(rate.source).toBe('fred');
    expect(rate.inverted).toBe(false);
    expect(rate.carriedForward).toBe(false);
    // D4 stores `fx_rate` *and* `fx_rate_date`; this is where the date comes
    // from, and it is the observation's date rather than the date asked for.
    expect(rate.rateDate).toBe('2026-09-21');
    expect(rate.observedAt).toEqual(OBSERVED);
  });

  it('inverts a stored pair rather than storing both directions', async () => {
    // FRED's `DEXCAUS` is Canadian dollars per US dollar — the direction is
    // part of the series' identity. Storing both ways would mean two rows that
    // must agree to fifteen places forever, and `1/1.35` does not round-trip.
    const reader = readerOver([record({ base: 'USD', quote: 'CAD', rate: '1.3500000000' })]);

    const forward = await reader.rate('USD', 'CAD', '2026-09-21');
    expect(forward.rate).toBe('1.3500000000');
    expect(forward.inverted).toBe(false);

    const backward = await reader.rate('CAD', 'USD', '2026-09-21');
    expect(backward.inverted).toBe(true);
    // Exact decimal, no float. 1/1.35 = 0.740740...
    expect(backward.rate).toBe('0.740740740740740741');
    expect(backward.base).toBe('CAD');
    expect(backward.quote).toBe('USD');
    // The provenance still points at the observation that was actually made.
    expect(backward.source).toBe('fred');
    expect(backward.rateDate).toBe('2026-09-21');
  });

  it('carries a rate forward over a weekend and says that it did', async () => {
    // FX has no Sunday print. Friday's rate is the right answer; pretending it
    // was observed on Sunday is not, because D4's `fx_rate_date` would then be
    // a date on which nothing happened.
    const reader = readerOver([record({ rateDate: '2026-09-18' })]);
    const rate = await reader.rate('EUR', 'USD', '2026-09-20');

    expect(rate.rate).toBe('1.0850000000');
    expect(rate.rateDate).toBe('2026-09-18');
    expect(rate.carriedForward).toBe(true);
  });

  it('a user override outranks a provider on the same day', async () => {
    // A user who typed a rate in meant it, and a later refresh must not
    // overwrite their judgement. The ranking is in the query, so the fake and
    // Postgres have to agree about it.
    const reader = readerOver([
      record({ source: 'fred', rate: '1.0850000000' }),
      record({ source: 'user_override', rate: '1.1000000000' }),
    ]);
    const rate = await reader.rate('EUR', 'USD', '2026-09-21');
    expect(rate.source).toBe('user_override');
    expect(rate.rate).toBe('1.1000000000');
  });

  it('a later observation wins over an earlier one', async () => {
    const reader = readerOver([
      record({ rateDate: '2026-09-18', rate: '1.0800000000' }),
      record({ rateDate: '2026-09-21', rate: '1.0850000000' }),
    ]);
    expect((await reader.rate('EUR', 'USD', '2026-09-21')).rate).toBe('1.0850000000');
    // And a date before the later row still sees the earlier one — history is
    // not rewritten by a newer print.
    expect((await reader.rate('EUR', 'USD', '2026-09-19')).rateDate).toBe('2026-09-18');
  });

  it('does not cross via USD to manufacture a rate', async () => {
    // EUR→USD and USD→CAD are both present; EUR→CAD is not. Chaining them
    // would produce a plausible number with no observation behind it, and D4
    // requires a historical rate rather than a plausible one.
    const reader = readerOver([
      record({ base: 'EUR', quote: 'USD', rate: '1.0850000000' }),
      record({ base: 'USD', quote: 'CAD', rate: '1.3500000000' }),
    ]);

    await expect(reader.rate('EUR', 'CAD', '2026-09-21')).rejects.toThrow(FxRateUnavailable);
  });

  it('refuses a code that is not ISO-4217', async () => {
    const reader = readerOver([record()]);
    await expect(reader.rate('EURO', 'USD', '2026-09-21')).rejects.toThrow(TypeError);
    await expect(reader.rate('', 'USD', '2026-09-21')).rejects.toThrow(TypeError);
  });

  it('inversion is exact and refuses zero', () => {
    expect(invert('2')).toBe('0.5');
    expect(invert('1.25')).toBe('0.8');
    // A zero rate would divide a conversion into an Infinity somewhere
    // downstream — the silent nonsense this module exists to prevent.
    expect(() => invert('0')).toThrow(RangeError);
  });

  it('SABOTAGE: a reader that fell back to 1.0 would pass nothing here', async () => {
    // The negative control. This is the bug: `?? 1`, or a default parameter,
    // or a `catch { return 1 }` at a call site. It demonstrates that such an
    // implementation produces a plausible, wrong number where the real one
    // refuses — and that the tests above would catch it.
    const silent = {
      async rate(from: string, to: string, date: string): Promise<string> {
        const reader = readerOver([]);
        try {
          return (await reader.rate(from, to, date)).rate;
        } catch {
          return '1'; // the sabotage
        }
      },
    };

    // The sabotaged reader converts a Canadian dollar at par, and nothing about
    // the result says so.
    expect(await silent.rate('CAD', 'USD', '2026-09-21')).toBe('1');
    // The real one refuses.
    await expect(readerOver([]).rate('CAD', 'USD', '2026-09-21')).rejects.toThrow(
      FxRateUnavailable,
    );
  });
});
