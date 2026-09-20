// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';

import {
  applyDirection,
  isBalanced,
  parseSplitMagnitude,
  remainder,
  splitEvenly,
  sumSplits,
} from './split-math.ts';

const usd = (minor: string | bigint) => Money.of(BigInt(minor), 'USD');

describe('split-math', () => {
  it('sums split lines in the transaction currency', () => {
    expect(sumSplits([usd(1000n), usd(500n)], 'USD')).toEqual(usd(1500n));
  });

  it('remainder is zero once the lines equal the total', () => {
    const total = usd(-1240n);
    const lines = [usd(-800n), usd(-440n)];
    expect(remainder(total, lines)).toEqual(usd(0n));
    expect(isBalanced(total, lines)).toBe(true);
  });

  it('a set that does not sum to the parent is not balanced', () => {
    const total = usd(-1240n);
    const lines = [usd(-800n), usd(-400n)];
    expect(isBalanced(total, lines)).toBe(false);
    expect(remainder(total, lines)).toEqual(usd(-40n));
  });

  it('split evenly uses largest-remainder so three shares of $10.00 are 3.34/3.33/3.33', () => {
    const shares = splitEvenly(usd(1000n), 3);
    expect(shares).toEqual([usd(334n), usd(333n), usd(333n)]);
    expect(sumSplits(shares, 'USD')).toEqual(usd(1000n));
  });

  it('split evenly on a negative (outflow) total preserves the sign on every share', () => {
    const shares = splitEvenly(usd(-1000n), 3);
    expect(shares).toEqual([usd(-334n), usd(-333n), usd(-333n)]);
    expect(sumSplits(shares, 'USD')).toEqual(usd(-1000n));
  });

  it('parses a typed magnitude, stripping any leading sign the user added', () => {
    expect(parseSplitMagnitude('12.40', 'USD')).toEqual(usd(1240n));
    expect(parseSplitMagnitude('-12.40', 'USD')).toEqual(usd(1240n));
    expect(parseSplitMagnitude('+12.40', 'USD')).toEqual(usd(1240n));
    expect(parseSplitMagnitude('', 'USD')).toEqual(usd(0n));
  });

  it('applies the parent transaction direction to a typed magnitude', () => {
    const outflow = usd(-1000n);
    const inflow = usd(1000n);
    expect(applyDirection(usd(500n), outflow)).toEqual(usd(-500n));
    expect(applyDirection(usd(500n), inflow)).toEqual(usd(500n));
  });

  it('a fast-check-shaped sweep: N even shares always sum back to the total', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 11, 13]) {
      for (const minor of [1n, 7n, 100n, 1001n, 999_999n]) {
        const total = usd(minor);
        const shares = splitEvenly(total, count);
        expect(shares).toHaveLength(count);
        expect(sumSplits(shares, 'USD')).toEqual(total);
      }
    }
  });
});
