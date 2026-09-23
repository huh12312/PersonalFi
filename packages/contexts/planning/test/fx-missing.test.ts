// SPDX-License-Identifier: MIT
/**
 * The §5 exit criterion: a missing rate is an error, never a par conversion.
 *
 * D4 and 08 §6.6. The failure this guards is the most expensive kind — a CAD
 * account quietly counting as USD is arithmetically plausible, materially wrong
 * by the whole spread, and completely invisible on screen. Nothing about a chart
 * drawn that way looks broken.
 *
 * It is sabotage-tested twice, because there are two ways to produce a 1.0 and
 * only one of them is "no rate":
 *
 *   1. **Delete the rate.** The reader throws `FxRateUnavailable` and the
 *      aggregate propagates it; no row is written for the day at all.
 *   2. **Answer 1.0 anyway.** A reader that returns `source: 'identity'` for a
 *      genuine cross pair — a fake, a fallback somebody adds in a hurry, a
 *      future adapter that "defaults sensibly" — is refused by
 *      `assertRateIsAnObservation`, by name, before the number reaches a total.
 *
 * The second sabotage is the one that matters in a year's time. Guard 1 lives in
 * `@ctx/investments` and could be softened over there without anything in this
 * package changing; guard 2 is this context refusing to accept a par conversion
 * whatever the reader says.
 */
import { describe, expect, it } from 'vitest';
import { FxRateUnavailable, isFxRateUnavailable } from '@ctx/investments';
import { computeNetWorth } from '../src/net-worth.ts';
import { assertRateIsAnObservation, convertToBase } from '../src/fx.ts';
import { portsOf, type FakeWorld } from './fakes.ts';
import type { FxQuote, FxReader } from '../src/ports.ts';

const USER = 'a1920000-0000-7000-8000-00000000a001';
const DATE = '2026-06-15';

/** One CAD account and nothing else, so the failure has exactly one cause. */
const world: FakeWorld = {
  accounts: [
    {
      accountId: 'a1000000-0000-4000-8000-000000000002',
      name: 'Savings (CAD)',
      kind: 'cash',
      side: 'asset',
      currency: 'CAD',
      flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
    },
  ],
  balances: [
    {
      accountId: 'a1000000-0000-4000-8000-000000000002',
      date: DATE,
      currentMinor: '1000000',
      currency: 'CAD',
    },
  ],
  // No `fxRates` at all. This is the sabotage: the rate row is gone.
  fxRates: [],
};

describe('a missing FX rate', () => {
  it('a missing rate raises FxRateUnavailable and never returns 1.0', async () => {
    const run = computeNetWorth(portsOf(world), {
      userId: USER,
      asOfDate: DATE,
      baseCurrency: 'USD',
    });

    await expect(run).rejects.toThrow(FxRateUnavailable);

    // Not merely "it threw". The error has to name the pair and the date,
    // because 08 §6.6's affordance is a manual-entry prompt and a prompt that
    // cannot say *which* rate it is asking for is not an affordance.
    const error = await run.catch((caught: unknown) => caught);
    expect(isFxRateUnavailable(error)).toBe(true);
    const fx = error as FxRateUnavailable;
    expect(fx.base).toBe('CAD');
    expect(fx.quote).toBe('USD');
    expect(fx.date).toBe(DATE);
    expect(fx.consulted).toContain('CAD/USD');
    // The direction actually queried, so the evidence trail shows the inverted
    // lookup was tried rather than assumed away.
    expect(fx.consulted).toContain('USD/CAD (inverted)');

    // And the message says out loud what did *not* happen, so an operator
    // reading it in `job_runs.failed_error` is told the refusal was deliberate
    // rather than left to wonder whether a fallback failed too.
    expect(fx.message).toContain('rather than a 1.0');
  });

  it('refuses a reader that answers the identity for a genuine cross pair', async () => {
    // Sabotage 2. A reader that "defaults sensibly" to par. Observed red before
    // `assertRateIsAnObservation` existed: this produced a CAD balance counted
    // as USD, a plausible net worth, and no error anywhere.
    const parReader: FxReader = {
      async rate(_from: string, _to: string, date: string): Promise<FxQuote> {
        return { rate: '1', rateDate: date, source: 'identity' };
      },
    };

    const run = computeNetWorth(
      { ...portsOf(world), fx: parReader },
      { userId: USER, asOfDate: DATE, baseCurrency: 'USD' },
    );

    await expect(run).rejects.toThrow(FxRateUnavailable);
  });

  it('allows the identity only when the two codes are literally equal', () => {
    // The one legitimate 1.0 in the system. It is reachable, it is not an
    // error, and it is not reachable for anything else.
    expect(() =>
      assertRateIsAnObservation({ rate: '1', rateDate: DATE, source: 'identity' }, 'USD', 'USD'),
    ).not.toThrow();

    expect(() =>
      assertRateIsAnObservation({ rate: '1', rateDate: DATE, source: 'identity' }, 'EUR', 'USD'),
    ).toThrow(FxRateUnavailable);
  });

  it('accepts a genuine observation that happens to be exactly 1.0', async () => {
    // The check is on provenance, not on the value. A real EUR/CHF print of
    // 1.0000 is a fact; refusing it would be the mirror-image bug, and a test
    // that only asserted "1 is rejected" would have shipped it.
    const genuine: FxReader = {
      async rate(): Promise<FxQuote> {
        return { rate: '1', rateDate: '2026-06-14', source: 'fred' };
      },
    };

    const converted = await convertToBase(genuine, {
      nativeMinor: 250000n,
      currency: 'CHF',
      baseCurrency: 'EUR',
      date: DATE,
    });
    expect(converted.baseMinor).toBe(250000n);
    expect(converted.fxRateDate).toBe('2026-06-14');
  });

  it('converts through exact decimal, not through a float', async () => {
    // 0.1 + 0.2 is the folk example; this is the one that costs money. A rate
    // with four decimals applied to a large balance is where `Number` first
    // loses a cent, and a net worth is a sum of many such conversions.
    const reader: FxReader = {
      async rate(): Promise<FxQuote> {
        return { rate: '0.7351', rateDate: DATE, source: 'fred' };
      },
    };

    const converted = await convertToBase(reader, {
      nativeMinor: 123456789n,
      currency: 'CAD',
      baseCurrency: 'USD',
      date: DATE,
    });

    // 123456789 x 7351 = 907530855939, so 123456789 x 0.7351 = 90753085.5939,
    // which rounds to 90753086. Worked out longhand rather than in a REPL: the
    // first attempt at this line said 90753084 and the engine was right.
    expect(converted.baseMinor).toBe(90753086n);
    expect(converted.nativeMinor).toBe(123456789n);
    expect(converted.fxRate).toBe('0.7351');
  });
});
