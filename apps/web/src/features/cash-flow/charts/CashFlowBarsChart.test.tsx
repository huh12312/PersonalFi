// SPDX-License-Identifier: MIT
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CashFlow } from '../../../api/generated/types.gen.ts';
import { CashFlowBarsInner, columnPath } from './CashFlowBarsChart.tsx';

function bars(): CashFlow['bars'] {
  return ['2025-12', '2026-01', '2026-02', '2026-03'].map((period, index) => ({
    period,
    from: `${period}-01`,
    to: `${period}-28`,
    hasData: index > 0,
    complete: index < 3,
    incomeMinor: index === 2 ? '0' : '500000',
    expensesMinor: '300000',
    netMinor: index === 2 ? '-300000' : '200000',
    transactionCount: 10,
  }));
}

describe('CashFlowBarsInner (WP 10.10)', () => {
  it('pairs income and expenses per period with data, never a column where there is none, and one net line', () => {
    const { container } = render(
      <CashFlowBarsInner
        width={480}
        height={220}
        bars={bars()}
        timeframe="month"
        currency="USD"
        series="both"
        selected="2026-03"
        ariaLabel="test"
      />,
    );
    // Three periods have data; the first has none and draws nothing (not a zero column).
    expect(container.querySelectorAll('[data-period="2025-12"] [data-series]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-series="income"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-series="expenses"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-series="net"]')).toHaveLength(1);
    // A period of zero income draws no income column at all (a 0-height path is empty).
    expect(
      container.querySelector('[data-period="2026-02"] [data-series="income"]')?.getAttribute('d'),
    ).toBe('');
    // The selected period sits on its band.
    expect(container.querySelector('[data-testid="cash-flow-selected-band"]')).not.toBeNull();
  });

  it('every period is a button that selects it, the selected one pressed, its label carrying the figures', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <CashFlowBarsInner
        width={480}
        height={220}
        bars={bars()}
        timeframe="month"
        currency="USD"
        series="both"
        selected="2026-03"
        onSelect={onSelect}
        ariaLabel="test"
      />,
    );
    const march = getByRole('button', { name: /^March 2026/ });
    expect(march.getAttribute('aria-pressed')).toBe('true');
    expect(march.getAttribute('aria-label')).toBe(
      'March 2026: income $5,000.00, expenses $3,000.00, net $2,000.00 so far. Show this month.',
    );
    expect(getByRole('button', { name: /^December 2025: no data\./ })).toBeTruthy();
    fireEvent.keyDown(getByRole('button', { name: /^January 2026/ }), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('2026-01');
  });

  it('one side only: no net line, no other side', () => {
    const { container } = render(
      <CashFlowBarsInner
        width={480}
        height={220}
        bars={bars()}
        timeframe="month"
        currency="USD"
        series="expenses"
        selected="2026-03"
        ariaLabel="test"
      />,
    );
    expect(container.querySelectorAll('[data-series="income"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-series="net"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-series="expenses"]')).toHaveLength(3);
  });

  it('a column is rounded at its data end and square at the baseline, either side of zero', () => {
    expect(columnPath(0, 20, 100, 40)).toBe('M0,100V44Q0,40 4,40H16Q20,40 20,44V100Z');
    expect(columnPath(0, 20, 100, 160)).toBe('M0,100V156Q0,160 4,160H16Q20,160 20,156V100Z');
    expect(columnPath(0, 20, 100, 100)).toBe('');
  });
});
