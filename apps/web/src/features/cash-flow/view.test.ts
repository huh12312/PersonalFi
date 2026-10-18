// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  cashFlowSearchSchema,
  comparePeriodKeys,
  periodLabel,
  periodTickLabel,
  searchOf,
  shiftPeriodKey,
  viewOf,
  withChange,
  type CashFlowView,
} from './view.ts';

describe('URL state', () => {
  it('the default view is a bare URL, and every field round-trips through the URL', () => {
    const empty = viewOf(cashFlowSearchSchema.parse({}));
    expect(empty).toEqual({
      tab: 'cash-flow',
      display: 'flow',
      timeframe: 'month',
      period: null,
      breakdown: 'category',
      compare: 'previous',
    });
    expect(searchOf(empty)).toEqual({});

    const deep: CashFlowView = {
      tab: 'income',
      display: 'categories',
      timeframe: 'quarter',
      period: '2025-Q4',
      breakdown: 'merchant',
      compare: 'year_ago',
    };
    const search = searchOf(deep);
    expect(search).toEqual({
      tab: 'income',
      display: 'categories',
      timeframe: 'quarter',
      period: '2025-Q4',
      breakdown: 'merchant',
      compare: 'year_ago',
    });
    // Through the route's own validator, as a reload would.
    expect(viewOf(cashFlowSearchSchema.parse(JSON.parse(JSON.stringify(search))))).toEqual(deep);
  });

  it('a bad value falls back to its default instead of failing the route', () => {
    const view = viewOf(
      cashFlowSearchSchema.parse({
        tab: 'nope',
        display: 'pie',
        timeframe: 'week',
        period: '2026-13',
      }),
    );
    expect(view.tab).toBe('cash-flow');
    expect(view.display).toBe('flow');
    expect(view.timeframe).toBe('month');
    expect(view.period).toBeNull();
  });

  it('a display the tab does not offer, or a period of another timeframe, is ignored', () => {
    expect(viewOf({ tab: 'spending', display: 'flow' }).display).toBe('bars');
    expect(viewOf({ tab: 'cash-flow', display: 'categories' }).display).toBe('flow');
    expect(viewOf({ timeframe: 'month', period: '2026-Q1' }).period).toBeNull();
    expect(viewOf({ timeframe: 'year', period: '2025' }).period).toBe('2025');
  });

  it('changing tab keeps a display it offers; changing timeframe starts at today', () => {
    const base = viewOf({ display: 'bars', period: '2026-02' });
    expect(withChange(base, { tab: 'spending' }).display).toBe('bars');
    expect(withChange(viewOf({}), { tab: 'income' }).display).toBe('bars');
    const quarter = withChange(base, { timeframe: 'quarter' });
    expect(quarter.period).toBeNull();
    expect(withChange(base, { compare: 'average' }).period).toBe('2026-02');
  });
});

describe('period keys', () => {
  it('steps across year boundaries in every timeframe', () => {
    expect(shiftPeriodKey('month', '2026-01', -1)).toBe('2025-12');
    expect(shiftPeriodKey('month', '2025-12', 1)).toBe('2026-01');
    expect(shiftPeriodKey('month', '2026-03', -12)).toBe('2025-03');
    expect(shiftPeriodKey('quarter', '2026-Q1', -1)).toBe('2025-Q4');
    expect(shiftPeriodKey('quarter', '2025-Q4', 1)).toBe('2026-Q1');
    expect(shiftPeriodKey('quarter', '2026-Q1', -4)).toBe('2025-Q1');
    expect(shiftPeriodKey('year', '2026', -1)).toBe('2025');
    expect(() => shiftPeriodKey('quarter', '2026-03', 1)).toThrow();
  });

  it('orders keys and names them', () => {
    expect(comparePeriodKeys('quarter', '2025-Q4', '2026-Q1')).toBeLessThan(0);
    expect(comparePeriodKeys('month', '2026-03', '2026-03')).toBe(0);
    expect(periodLabel('month', '2026-03')).toBe('March 2026');
    expect(periodLabel('quarter', '2026-Q1')).toBe('Q1 2026');
    expect(periodLabel('year', '2026')).toBe('2026');
    expect(periodTickLabel('month', '2026-01')).toBe("Jan '26");
    expect(periodTickLabel('month', '2026-02')).toBe('Feb');
    expect(periodTickLabel('quarter', '2025-Q4')).toBe("Q4 '25");
  });
});
