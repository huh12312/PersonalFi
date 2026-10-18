// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { GetNetWorthSeriesResponse } from '../../../api/generated/types.gen.ts';
import { PLACEHOLDER_REASON_WORDS, pickSealedStart } from './sealedStart.ts';

type Point = GetNetWorthSeriesResponse['points'][number];

function point(asOfDate: string, investableMinor: string | null, sealed: boolean): Point {
  const money = (minor: string) => ({ minor, currency: 'USD' });
  const some = investableMinor !== null;
  return {
    asOfDate,
    netWorth: some ? money('90000000') : null,
    assets: some ? money('95000000') : null,
    liabilities: some ? money('5000000') : null,
    liquid: some ? money('1000000') : null,
    investable: some ? money(investableMinor) : null,
    onBudget: some ? money('1000000') : null,
    sealed,
    sealedAt: sealed ? `${asOfDate}T07:00:00.000Z` : null,
    revision: 1,
    source: some ? 'snapshot' : null,
    stalePrice: false,
    dirty: false,
    accountsCounted: some ? 3 : null,
    accountsUnvalued: some ? 0 : null,
    correctionReason: null,
  };
}

const series = (points: Point[], baseCurrency = 'USD'): GetNetWorthSeriesResponse => ({
  from: '2026-08-01',
  to: '2026-10-04',
  baseCurrency,
  points,
  lastSnapshotFailure: null,
  bucketing: null,
  buckets: null,
});

describe('pickSealedStart', () => {
  it('takes the newest sealed day, in whole dollars, however the points are ordered', () => {
    const start = pickSealedStart(
      series([point('2026-10-02', '61234500', true), point('2026-10-01', '60000000', true)]),
    );
    expect(start).toEqual({ kind: 'sealed', amount: 612345, asOfDate: '2026-10-02' });
  });

  it('never starts from an open day, however recent or large', () => {
    const start = pickSealedStart(
      series([point('2026-10-02', '61234500', true), point('2026-10-03', '99999900', false)]),
    );
    expect(start).toMatchObject({ kind: 'sealed', asOfDate: '2026-10-02' });
  });

  it('skips a sealed day that has no investable total', () => {
    expect(
      pickSealedStart(
        series([point('2026-10-02', null, true), point('2026-10-01', '100000', true)]),
      ),
    ).toMatchObject({ asOfDate: '2026-10-01', amount: 1000 });
  });

  it('is a placeholder with no sealed day at all, and for a non-dollar base currency', () => {
    expect(pickSealedStart(series([point('2026-10-03', '100', false)]))).toEqual({
      kind: 'placeholder',
      reason: 'none_sealed',
    });
    expect(pickSealedStart(series([]))).toMatchObject({ kind: 'placeholder' });
    expect(pickSealedStart(series([point('2026-10-02', '100', true)], 'EUR'))).toEqual({
      kind: 'placeholder',
      reason: 'currency',
    });
  });

  it('words every placeholder reason', () => {
    expect(Object.values(PLACEHOLDER_REASON_WORDS).every((words) => words.length > 10)).toBe(true);
  });
});
