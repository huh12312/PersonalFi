// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { CHART_HUES, hueForId } from '@core/kernel';

import {
  accountKindOf,
  accountTypeHue,
  categoryFillVar,
  categoryHue,
  chartEventVar,
  seriesHue,
} from './chart-hue.ts';

describe('categoryHue', () => {
  it('reads the persisted hue when there is one', () => {
    expect(categoryHue('cat_1', 'mint')).toBe('mint');
  });

  it('falls back to the server seed, so an unpersisted category paints what the server will store', () => {
    expect(categoryHue('0192f3a1-7b2c-7d4e-8f00-123456789abc', null)).toBe(
      hueForId('0192f3a1-7b2c-7d4e-8f00-123456789abc'),
    );
    expect(categoryHue('0192f3a1-7b2c-7d4e-8f00-123456789abc')).toBe('green');
  });

  it('ignores a persisted value outside the vocabulary', () => {
    expect(categoryHue('x', 'blue')).toBe(hueForId('x'));
  });

  it('is stable across calls (a hue is assigned once)', () => {
    const id = '01930000-0000-7000-8000-00000000abcd';
    const first = categoryHue(id);
    for (let i = 0; i < 5; i += 1) expect(categoryHue(id)).toBe(first);
  });

  it('draws uncategorised in the neutral fill, never a hue', () => {
    expect(categoryHue(null)).toBe('neutral');
    expect(categoryHue('')).toBe('neutral');
    expect(categoryFillVar(null)).toBe('var(--chart-fill-neutral)');
    expect(categoryFillVar('c', 'teal')).toBe('var(--chart-fill-teal)');
  });
});

describe('account types', () => {
  it('have the fixed mapping', () => {
    expect(accountTypeHue('cash')).toBe('teal');
    expect(accountTypeHue('investments')).toBe('indigo');
    expect(accountTypeHue('crypto')).toBe('orange');
    expect(accountTypeHue('property')).toBe('brown');
    expect(accountTypeHue('liabilities')).toBe('red');
    expect(accountTypeHue('other')).toBe('neutral');
  });

  it('come from the wire type', () => {
    expect(accountKindOf('depository')).toBe('cash');
    expect(accountKindOf('credit')).toBe('liabilities');
    expect(accountKindOf('loan')).toBe('liabilities');
    expect(accountKindOf('investment')).toBe('investments');
    expect(accountKindOf('crypto')).toBe('crypto');
    expect(accountKindOf('manual', 'real_estate')).toBe('property');
    expect(accountKindOf('manual', null)).toBe('other');
  });
});

describe('positional series', () => {
  it('take the validated order and fold to neutral past thirteen — never cycle', () => {
    const hues = Array.from({ length: 13 }, (_, i) => seriesHue(i));
    expect(new Set(hues).size).toBe(13);
    expect([...hues].sort()).toEqual([...CHART_HUES].sort());
    expect(seriesHue(13)).toBe('neutral');
  });

  it('event roles name the four tokens', () => {
    expect(chartEventVar('fg', 'teal')).toBe('var(--chart-event-fg-teal)');
  });
});
