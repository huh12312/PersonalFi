// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import { ChartInner, FanChart, rowsHaveBands } from './FanChart.tsx';
import { percentilesFixture } from './fixtures.ts';

/**
 * `ChartInner` rather than the public `FanChart` — `ParentSize`'s
 * `ResizeObserver` never fires in the happy-dom test environment
 * (`vitest.setup.ts`), so a fixed width/height is supplied directly, the
 * same way `FanChart.tsx`'s own doc comment on the export explains.
 */
function rows() {
  return percentilesFixture().map((p) => ({
    year: p.calendarYear,
    p5: Number(p.p5?.minor ?? null),
    p10: Number(p.p10?.minor ?? null),
    p25: Number(p.p25?.minor ?? null),
    p50: Number(p.p50.minor),
    p75: Number(p.p75?.minor ?? null),
    p90: Number(p.p90?.minor ?? null),
    p95: Number(p.p95?.minor ?? null),
  }));
}

describe('FanChart', () => {
  it('labels the median line "median" in words, not only by position', () => {
    render(<ChartInner width={640} height={320} rows={rows()} currency="USD" />);
    expect(screen.getByText('median')).toBeInTheDocument();
  });

  it('draws the dashed goal line with a direct-labelled crossing point', () => {
    // Between year 2036 (p50 $900,000) and 2046 (p50 $1,800,000) — a goal of
    // $1,000,000 crosses inside that span, so the crossing label must render.
    const { container } = render(
      <ChartInner
        width={640}
        height={320}
        rows={rows()}
        currency="USD"
        goal={{ targetMinor: '100000000', currency: 'USD', calendarYear: 2040 }}
      />,
    );
    // Linear interpolation between 2036 ($900k) and 2046 ($1.8M) for a
    // $1,000,000 target lands at 2037 (`crossingYear` in `FanChart.tsx`).
    const crossingLabel = [...container.querySelectorAll('text')].find((el) =>
      /Goal reached ~2037/.test(el.textContent ?? ''),
    );
    expect(crossingLabel).toBeDefined();
  });

  it('renders the dotted gap connector as a real, keyboard-focusable button that fires onGapActivate on click and on Enter', async () => {
    const user = userEvent.setup();
    const onGapActivate = vi.fn();
    render(
      <ChartInner
        width={640}
        height={320}
        rows={rows()}
        currency="USD"
        goal={{ targetMinor: '100000000', currency: 'USD', calendarYear: 2040 }}
        onGapActivate={onGapActivate}
      />,
    );

    const gap = screen.getByTestId('fan-chart-gap-line');
    expect(gap.tagName).toBe('BUTTON');

    gap.focus();
    expect(gap).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onGapActivate).toHaveBeenCalledTimes(1);

    await user.click(gap);
    expect(onGapActivate).toHaveBeenCalledTimes(2);
  });

  it('renders no dotted gap connector when no goal is set', () => {
    render(<ChartInner width={640} height={320} rows={rows()} currency="USD" />);
    expect(screen.queryByTestId('fan-chart-gap-line')).not.toBeInTheDocument();
  });

  it('the tooltip states "there\'s a X% chance you have at least $Y" once a pointer moves over the plot', async () => {
    const user = userEvent.setup();
    render(<ChartInner width={640} height={320} rows={rows()} currency="USD" />);

    // The transparent hit rectangle is the last element in the SVG group —
    // `pointerMove` on it drives `showTooltip`.
    const hitRect = document.querySelector('rect[fill="transparent"]');
    expect(hitRect).not.toBeNull();
    await user.pointer({ target: hitRect as Element, coords: { x: 300, y: 100 } });

    expect(await screen.findByText(/chance you have at least/)).toBeInTheDocument();
  });

  it('the "View as table" disclosure renders every percentile as a plain accessible table — the legend, toggle and table live outside `ParentSize`, so this needs no chart width at all', async () => {
    const user = userEvent.setup();
    render(<FanChart percentiles={percentilesFixture()} currency="USD" height={320} />);

    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByRole('columnheader', { name: 'p50 (median)' })).toBeInTheDocument();
    // 2046's p50 minor is `180000000` — the table's own `moneyLabel` helper
    // formats compact, so this reproduces that call rather than guessing at
    // `Intl.NumberFormat`'s exact compact output.
    const expected = formatMoney(parseWireMoney({ minor: '180000000', currency: 'USD' }), {
      compact: true,
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('draws one path, with no band swatches and no "median" it is not, for a deterministic run', () => {
    const single = rows().map((r) => ({
      ...r,
      p5: null,
      p10: null,
      p25: null,
      p75: null,
      p90: null,
      p95: null,
    }));
    expect(rowsHaveBands(single)).toBe(false);
    expect(rowsHaveBands(rows())).toBe(true);
    const { container } = render(
      <ChartInner width={640} height={320} rows={single} currency="USD" />,
    );
    expect(screen.getByText('projected path')).toBeInTheDocument();
    expect(screen.queryByText('median')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('single path'),
    );
  });
});
