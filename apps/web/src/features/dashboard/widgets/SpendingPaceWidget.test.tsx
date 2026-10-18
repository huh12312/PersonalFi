// SPDX-License-Identifier: MIT
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { cumulative, paceFixture, renderWidget } from '../test-utils.tsx';
import { PaceChartInner } from './SpendingPaceChart.tsx';
import { SpendingPaceWidget } from './SpendingPaceWidget.tsx';
import type { SpendingPace } from '../../../api/generated/types.gen.ts';

function serve(pace: SpendingPace | (() => Promise<Response>)) {
  stubFetchRoutes([
    {
      match: '/api/reports/spending-pace',
      method: 'GET',
      handle: typeof pace === 'function' ? pace : () => jsonResponse(pace),
    },
  ]);
}

const NOW = new Date('2026-03-17T16:00:00.000Z');

describe('SpendingPaceWidget (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loading: a skeleton in the card, no figure', async () => {
    serve(() => new Promise<Response>(() => {}));
    const { container } = renderWidget(<SpendingPaceWidget now={NOW} />);
    expect(await screen.findByLabelText('Loading Spending pace')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it('populated: the sentence with both amounts, the difference in words and the success role, the chart, the notes', async () => {
    serve(paceFixture());
    renderWidget(<SpendingPaceWidget now={NOW} />);
    const sentence = await screen.findByTestId('pace-sentence');
    // `<Money>` adds a screen-reader spelling after each figure, so the visible sentence is matched around it.
    expect(sentence.textContent).toMatch(
      /^You've spent \$43\.00.* this month\. By this day last month you had spent \$90\.00.*\./u,
    );
    const difference = within(sentence)
      .getByText(/less than last month/u)
      .closest('p')!;
    expect(difference.getAttribute('data-pace')).toBe('under');
    expect(difference.className).toContain('text-status-success-text');
    expect(difference.textContent).toContain('$47.00');
    expect(difference.textContent).not.toMatch(/%/u);
    expect(screen.getByTestId('pace-notes').textContent).toContain(
      '1 pending charge is not counted',
    );
    expect(screen.getByTestId('pace-legend').textContent).toContain('3-month average');
    // Fresh sync: no as-of line.
    expect(screen.queryByTestId('widget-as-of')).toBeNull();
  });

  it('over: the danger role, "more than last month"', async () => {
    serve(paceFixture({ days: cumulative([12_000, ...new Array<number>(16).fill(0)]) }));
    renderWidget(<SpendingPaceWidget now={NOW} />);
    const sentence = await screen.findByTestId('pace-sentence');
    const difference = within(sentence)
      .getByText(/more than last month/u)
      .closest('p')!;
    expect(difference.getAttribute('data-pace')).toBe('over');
    expect(difference.className).toContain('text-status-danger-text');
    expect(difference.textContent).toContain('$30.00');
  });

  it('the table toggles open with every day of the month and the three series', async () => {
    serve(paceFixture());
    renderWidget(<SpendingPaceWidget now={NOW} />);
    const toggle = await screen.findByRole('button', { name: /View as table/u });
    fireEvent.click(toggle);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(32); // header + 31 days
    expect(within(table).getByRole('columnheader', { name: 'March' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'February' })).toBeInTheDocument();
    const day17 = rows[17]!;
    expect(day17.textContent).toContain('$43.00');
    expect(day17.textContent).toContain('$90.00');
    expect(day17.textContent).toContain('$60.00');
    expect(rows[18]!.textContent).toContain('—'); // day 18 has not happened: a dash, never $0.00
  });

  it('no data: says what is missing and links to the fix; no chart, no zero', async () => {
    serve(paceFixture({ days: [], lastMonth: [], trailingAverage: [], trailingMonths: [] }));
    const { container } = renderWidget(<SpendingPaceWidget now={NOW} />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      /No transactions in the last four months/u,
    );
    expect(screen.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/accounts/connections',
    );
    expect(screen.queryByTestId('pace-chart')).toBeNull();
    expect(container.textContent).not.toMatch(/\$0/u);
  });

  it('no last month: the first sentence, then "no spending was recorded", never a $0 comparison', async () => {
    serve(paceFixture({ lastMonth: [] }));
    renderWidget(<SpendingPaceWidget now={NOW} />);
    const sentence = await screen.findByTestId('pace-sentence');
    expect(sentence.textContent).toContain('No spending was recorded in February to compare with.');
    expect(sentence.textContent).not.toContain('$0.00');
    expect(screen.getByTestId('pace-legend').textContent).not.toContain('Last month');
  });

  it('a stale source shows when it last synced', async () => {
    serve(paceFixture({ lastSyncedAt: '2026-03-14T16:00:00.000Z' }));
    renderWidget(<SpendingPaceWidget now={NOW} />);
    expect(await screen.findByTestId('widget-as-of')).toHaveTextContent('Last synced 3 days ago');
  });

  it('an error says the source could not be read', async () => {
    serve(() => Promise.resolve(jsonResponse({ code: 'internal' }, 500)));
    renderWidget(<SpendingPaceWidget now={NOW} />);
    expect(await screen.findByTestId('widget-error')).toHaveTextContent(
      "Spending isn't available right now.",
    );
  });
});

describe('PaceChartInner (WP 10.9)', () => {
  it('draws three series, today as a dot and a rule, and names both amounts in its label', () => {
    const pace = paceFixture();
    const { container } = render(
      <PaceChartInner width={480} height={200} pace={pace} currency="USD" />,
    );
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute('aria-label')).toBe(
      'Spending pace for March: $43.00 spent through day 17. By day 17 last month, $90.00. A three-month average is drawn for reference.',
    );
    expect(container.querySelector('[data-series="this-month"]')).not.toBeNull();
    expect(
      container.querySelector('[data-series="last-month"]')?.getAttribute('stroke-dasharray'),
    ).toBe('0.5 5');
    expect(container.querySelector('[data-series="average"]')?.getAttribute('stroke-width')).toBe(
      '1',
    );
    expect(container.querySelector('[data-testid="pace-today-dot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pace-today-rule"]')).not.toBeNull();
    // Every colour is a role.
    for (const node of container.querySelectorAll('[stroke],[fill]')) {
      for (const attribute of ['stroke', 'fill']) {
        const value = node.getAttribute(attribute);
        if (value === null || value === 'none' || value === 'transparent') continue;
        expect(value).toMatch(/^var\(--/u);
      }
    }
    // The x axis runs to the month's last day; ticks are tabular.
    const xTicks = [...container.querySelectorAll('[data-axis="x"]')].map(
      (node) => node.textContent,
    );
    expect(xTicks.at(0)).toBe('1');
    expect(xTicks.at(-1)).toBe('31');
  });

  it("last month longer than this month is cut at this month's last day, never drawn past the axis", () => {
    const pace = paceFixture({
      month: '2026-04',
      lastMonthKey: '2026-03',
      daysInMonth: 30,
      lastMonth: cumulative(Array.from({ length: 31 }, () => 100)),
    });
    const { container } = render(
      <PaceChartInner width={480} height={200} pace={pace} currency="USD" />,
    );
    const d = container.querySelector('[data-series="last-month"]')?.getAttribute('d') ?? '';
    const points = d.split(/[ML]/u).filter((part) => part.length > 0);
    expect(points).toHaveLength(30);
  });
});
