// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ChartInner, ForecastBandChart, chargesCellText, xTickPlan } from './ForecastBandChart.tsx';
import {
  buildChargeMarks,
  buildForecastBand,
  enumerateDays,
  type ForecastMarkInput,
} from './forecast-series.ts';

/**
 * `ChartInner` with an explicit size: `ParentSize` never measures in happy-dom (`FanChart.test.tsx` says the
 * same). Layout — overlap, clipping — cannot be seen here (every box is 0 × 0); that is
 * `e2e/recurring-insights.spec.ts`'s "WP 10.7" block. This file holds what the DOM alone can prove.
 */
const money = (minor: number) => ({ minor: String(minor), currency: 'USD' });

function input(
  seriesId: string,
  date: string,
  expected: number,
  low = expected,
  high = expected,
): ForecastMarkInput {
  return {
    seriesId,
    merchantId: `merch_${seriesId}`,
    cadence: 'MONTHLY',
    date,
    sign: expected < 0 ? 'OUTFLOW' : 'INFLOW',
    expected: money(expected),
    low: money(low),
    high: money(high),
  };
}

const NAMES: Record<string, string> = {
  merch_rent: 'Maple Court Rent',
  merch_power: 'City Power',
  merch_phone: 'Fernwave Mobile',
  merch_water: 'Metro Water',
  merch_cashback: 'Card Cashback',
};
const nameOf = (id: string) => NAMES[id] ?? id;

const FROM = '2026-06-01';
const TO = '2026-07-01';
const INPUTS = [
  input('rent', '2026-06-01', -145000),
  input('power', '2026-06-08', -8500, -11000, -7000),
  input('phone', '2026-06-15', -6500),
  input('water', '2026-06-15', -4200, -5000, -3600),
  input('cashback', '2026-06-20', 2500, 2000, 3000),
];
const DATA = buildForecastBand(FROM, TO, INPUTS);
const MARKS = buildChargeMarks(FROM, TO, INPUTS, nameOf);

describe('ForecastBandChart (WP 10.7)', () => {
  it('draws one mark per expected charge, ▼ out and ▲ in', () => {
    const { container } = render(
      <ChartInner width={900} height={240} data={DATA} marks={MARKS} currency="USD" banded />,
    );
    expect(container.querySelectorAll('[data-charge-mark]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-charge-mark="in"]')).toHaveLength(1);
  });

  it('names the window, the number of charges, the net and the worst case in its accessible name', () => {
    render(<ChartInner width={900} height={240} data={DATA} marks={MARKS} currency="USD" banded />);
    expect(
      screen.getByRole('img', {
        name: 'Projected cash flow from Jun 1 to Jul 1: 5 expected charges, expected net −$1,617.00, worst case −$1,655.00.',
      }),
    ).toBeInTheDocument();
  });

  it('labels the $0 baseline and draws the band only when told it has width', () => {
    const { container, rerender } = render(
      <ChartInner width={900} height={240} data={DATA} marks={MARKS} currency="USD" banded />,
    );
    expect(
      [...container.querySelectorAll('text[data-axis="y"]')].map((t) => t.textContent),
    ).toContain('$0');
    expect(container.querySelector('[data-testid="forecast-band"]')).not.toBeNull();
    rerender(
      <ChartInner
        width={900}
        height={240}
        data={DATA}
        marks={MARKS}
        currency="USD"
        banded={false}
      />,
    );
    expect(container.querySelector('[data-testid="forecast-band"]')).toBeNull();
  });

  it('abbreviates the y-axis money where the scale needs it', () => {
    const { container } = render(
      <ChartInner width={900} height={240} data={DATA} marks={MARKS} currency="USD" banded />,
    );
    const labels = [...container.querySelectorAll('text[data-axis="y"]')].map((t) => t.textContent);
    expect(labels).toContain('−$1K');
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThanOrEqual(6);
  });

  it('anchors the first x tick at its start and the last at its end, so neither can run off the plot', () => {
    const days = enumerateDays(FROM, TO);
    for (const width of [200, 500, 900]) {
      const plan = xTickPlan(days, width);
      expect(plan[0]).toEqual({ date: FROM, anchor: 'start' });
      expect(plan.at(-1)).toEqual({ date: TO, anchor: 'end' });
    }
    const { container } = render(
      <ChartInner width={900} height={240} data={DATA} marks={MARKS} currency="USD" banded />,
    );
    const xLabels = [...container.querySelectorAll('text[data-axis="x"]')];
    expect(xLabels.at(-1)?.textContent).toBe('Jul 1');
    expect(xLabels.at(-1)?.getAttribute('text-anchor')).toBe('end');
  });

  it('carries every charge, with its name and amount, in the data table', async () => {
    const user = userEvent.setup();
    render(<ForecastBandChart data={DATA} marks={MARKS} currency="USD" banded />);
    await user.click(screen.getByRole('button', { name: /^View as table/ }));
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Date', 'Charges due', 'Running total', 'Band low', 'Band high']);
    for (const mark of MARKS) {
      expect(table.textContent).toContain(mark.name);
    }
    const jun15 = within(table).getByRole('row', { name: /^Jun 15 / });
    expect(jun15).toHaveTextContent(
      'Fernwave Mobile −$65.00; Metro Water −$42.00 (−$50.00 to −$36.00)',
    );
    // A day with nothing due says so, rather than leaving a blank a screen reader skips.
    expect(within(table).getByRole('row', { name: /^Jun 2 / })).toHaveTextContent('—');
  });

  it('a range in the table reads low to high whatever the sign', () => {
    const cashback = MARKS.find((m) => m.name === 'Card Cashback')!;
    expect(chargesCellText([cashback], 'USD')).toBe('Card Cashback +$25.00 (+$20.00 to +$30.00)');
  });

  it('draws nothing, not a flat line, when given no days', () => {
    const { container } = render(
      <ChartInner width={900} height={240} data={[]} marks={[]} currency="USD" banded={false} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});
