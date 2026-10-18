// SPDX-License-Identifier: MIT
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { renderWidget } from '../dashboard/test-utils.tsx';
import { NetWorthWidget } from '../dashboard/widgets/NetWorthWidget.tsx';
import { MilestoneNotice } from './MilestoneNotice.tsx';
import { NetWorthStackedChart, NetWorthStackedInner } from './NetWorthStackedChart.tsx';
import type { StackedBucket } from './stacked.ts';

function bucket(start: string, cash: bigint, owed: bigint, sealed = true): StackedBucket {
  return {
    start,
    end: start,
    asOfDate: start,
    currency: 'USD',
    netMinor: cash + owed,
    segments: [
      { kind: 'cash', minor: cash },
      { kind: 'liabilities', minor: owed },
    ],
    sealed,
    source: 'observed',
  };
}

const BUCKETS: StackedBucket[] = [
  bucket('2026-10-01', 500_000n, -100_000n),
  bucket('2026-10-02', 520_000n, -100_000n),
  bucket('2026-10-03', 530_000n, -90_000n),
  bucket('2026-10-04', 560_000n, -90_000n, false),
];

/** Every y in a path's `d`. */
function ys(d: string): number[] {
  return [...d.matchAll(/[MLHVQZ]?\s*(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
}

beforeEach(() => ensureApiClient());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NetWorthStackedInner (the plot)', () => {
  it('liabilities are drawn below the zero line, assets above it', () => {
    const { container } = render(
      <NetWorthStackedInner
        width={600}
        height={240}
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        selected={null}
        onSelect={() => {}}
      />,
    );
    const zero = container.querySelector('line[stroke="var(--chart-axis)"]');
    const zeroY = Number(zero?.getAttribute('y1'));
    const liabilities = container.querySelectorAll('path[data-kind="liabilities"]');
    const cash = container.querySelectorAll('path[data-kind="cash"]');
    expect(liabilities).toHaveLength(4);
    for (const path of liabilities) {
      expect(path.getAttribute('data-side')).toBe('down');
      expect(Math.min(...ys(path.getAttribute('d') ?? ''))).toBeGreaterThan(zeroY);
    }
    for (const path of cash) {
      expect(Math.max(...ys(path.getAttribute('d') ?? ''))).toBeLessThan(zeroY);
    }
  });

  it('the net line is drawn over the bars, with a ringed dot per bucket', () => {
    const { container } = render(
      <NetWorthStackedInner
        width={600}
        height={240}
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('[data-series="net"]')).not.toBeNull();
    const dots = container.querySelectorAll('circle[data-net-dot]');
    expect(dots).toHaveLength(4);
    expect(dots[0]?.getAttribute('stroke')).toBe('var(--bg-primary)');
  });

  it('buckets older than the selected one are dimmed; the rest are not', () => {
    const { container } = render(
      <NetWorthStackedInner
        width={600}
        height={240}
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        selected={2}
        onSelect={() => {}}
      />,
    );
    const groups = [...container.querySelectorAll('g[data-bucket]')];
    expect(groups.map((g) => g.getAttribute('data-dimmed'))).toEqual(['true', 'true', null, null]);
    expect(container.querySelector('[data-testid="net-worth-crosshair"]')).not.toBeNull();
  });
});

describe('NetWorthStackedChart (readout, legend, keyboard)', () => {
  it('with no selection the readout is the latest bucket; the legend totals are the latest’s', () => {
    render(
      <NetWorthStackedChart
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        title="Net worth by account type"
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('net-worth-readout-net')).toHaveTextContent('$4,700.00');
    expect(screen.getByTestId('net-worth-readout')).toHaveTextContent('live, may still change');
    expect(screen.getByTestId('net-worth-readout-previous')).toHaveTextContent(
      '+$300.00 (+6.8%) vs the previous day',
    );
    expect(screen.getByTestId('net-worth-readout-first')).toHaveTextContent(
      '+$700.00 (+18%) since Oct 1, 2026',
    );
    const legend = within(screen.getByTestId('net-worth-legend'));
    expect(legend.getByText('Cash').parentElement).toHaveTextContent('Cash$5,600.00');
    expect(legend.getByText('Liabilities').parentElement).toHaveTextContent('Liabilities−$900.00');
  });

  it('← selects the previous bucket and announces it; Escape releases', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <NetWorthStackedChart
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        title="Net worth by account type"
        selected={3}
        onSelect={onSelect}
      />,
    );
    const slider = screen.getByRole('slider', { name: /Net worth by account type/ });
    expect(slider).toHaveAttribute('aria-valuenow', '4');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId('net-worth-announcement')).toHaveTextContent(
      /Oct 3, 2026: net worth \$4,400\.00/,
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    rerender(
      <NetWorthStackedChart
        buckets={BUCKETS}
        bucketing="day"
        currency="USD"
        title="Net worth by account type"
        selected={0}
        onSelect={onSelect}
      />,
    );
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringMatching(/^Oct 1, 2026: net worth \$4,000\.00/),
    );
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('the table carries every bucket’s segments and net, and states the bucketing rule', () => {
    render(
      <NetWorthStackedChart
        buckets={BUCKETS}
        bucketing="week"
        currency="USD"
        title="Net worth by account type"
        selected={null}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View as table/ }));
    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName(/One bar per week \(Monday to Sunday\)/);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('PeriodCashLiabilitiesNet worth');
    expect(rows[1]).toHaveTextContent('$5,000.00−$1,000.00$4,000.00');
  });
});

function point(asOfDate: string, minor: string, sealed = true) {
  return {
    asOfDate,
    netWorth: { minor, currency: 'USD' },
    assets: null,
    liabilities: null,
    liquid: null,
    investable: null,
    onBudget: null,
    sealed,
    sealedAt: null,
    revision: 1,
    source: 'observed',
    stalePrice: false,
    dirty: false,
    accountsCounted: 1,
    accountsUnvalued: 0,
    correctionReason: null,
  };
}

function wireBucket(start: string, cash: string, owed: string, net: string, sealed = true) {
  return {
    start,
    end: start,
    asOfDate: start,
    netWorth: { minor: net, currency: 'USD' },
    segments: [
      { kind: 'cash', amount: { minor: cash, currency: 'USD' }, accounts: 1 },
      { kind: 'liabilities', amount: { minor: owed, currency: 'USD' }, accounts: 1 },
    ],
    sealed,
    source: 'observed',
  };
}

describe('the hero follows the selection (NetWorthWidget)', () => {
  it('← moves the hero to the selected bucket; Escape returns it to the latest', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: ({ url }) =>
          jsonResponse({
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            baseCurrency: 'USD',
            lastSnapshotFailure: null,
            points: [point('2026-09-07', '400000'), point('2026-09-14', '470000', false)],
            bucketing: url.searchParams.get('bucket'),
            buckets: [
              wireBucket('2026-09-07', '500000', '-100000', '400000'),
              wireBucket('2026-09-14', '560000', '-90000', '470000', false),
            ],
          }),
      },
    ]);
    renderWidget(<NetWorthWidget />);
    const hero = await screen.findByText('Net worth', { selector: 'p, span, dt, div' });
    const tile = hero.closest('[class*="@container"]') ?? document.body;
    await waitFor(() => expect(tile).toHaveTextContent('$4,700.00'));

    const slider = screen.getByRole('slider', { name: /Net worth by account type/ });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('net-worth-hero-selection')).toBeInTheDocument());
    expect(tile).toHaveTextContent('$4,000.00');
    expect(screen.getByTestId('net-worth-hero-selection')).toHaveTextContent('as of 2026-09-07');

    fireEvent.keyDown(slider, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('net-worth-hero-selection')).toBeNull());
    expect(tile).toHaveTextContent('$4,700.00');
    expect(tile).toHaveTextContent('live, may still change');
  });
});

describe('MilestoneNotice', () => {
  it('shows the newest crossing in one line; Dismiss is sent to the server and the notice stays gone', async () => {
    let dismissed: string[] = [];
    stubFetchRoutes([
      {
        match: '/api/net-worth/milestones/dismiss',
        method: 'POST',
        handle: async ({ request }) => {
          dismissed = ((await request.json()) as { ids: string[] }).ids;
          return jsonResponse({ dismissed: dismissed.length });
        },
      },
      {
        match: '/api/net-worth/milestones',
        method: 'GET',
        handle: () =>
          jsonResponse({
            milestones:
              dismissed.length > 0
                ? []
                : [
                    {
                      id: '01920000-0000-7000-8000-000000000001',
                      milestone: { minor: '5000000', currency: 'USD' },
                      direction: 'up',
                      crossedOn: '2026-10-03',
                      previous: { minor: '4800000', currency: 'USD' },
                      latest: { minor: '5100000', currency: 'USD' },
                    },
                  ],
          }),
      },
    ]);
    renderWidget(<MilestoneNotice />);
    const notice = await screen.findByTestId('net-worth-milestone');
    expect(notice).toHaveTextContent('You crossed $50,000 in net worth on Oct 3');
    expect(notice).toHaveAttribute('role', 'status');
    fireEvent.click(within(notice).getByRole('button', { name: /^Dismiss/ }));
    await waitFor(() => expect(screen.queryByTestId('net-worth-milestone')).toBeNull());
    expect(dismissed).toEqual(['01920000-0000-7000-8000-000000000001']);
  });
});
