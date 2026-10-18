// SPDX-License-Identifier: MIT
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CategoryHistoryChart, CategoryHistoryInner } from './CategoryHistoryChart.tsx';
import { historyWire, withOneCompleteMonth } from './fixtures.ts';
import { historyOf } from './history.ts';

const WIDTH = 600;
const HEIGHT = 220;
// The plot's own margins (CategoryHistoryChart.tsx): 18 px above, 26 px for the month ticks below.
const INNER_HEIGHT = HEIGHT - 18 - 26;

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

function stubAnimate() {
  const animate = vi.fn(() => ({}) as Animation);
  Object.defineProperty(Element.prototype, 'animate', {
    value: animate,
    configurable: true,
    writable: true,
  });
  return animate;
}

function renderPlot(wire = historyWire(), selected = 12) {
  return render(
    <CategoryHistoryInner
      width={WIDTH}
      height={HEIGHT}
      view={historyOf(wire)}
      hue="teal"
      selected={selected}
      onSelect={() => {}}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CategoryHistoryInner (WP 10.14)', () => {
  it('draws thirteen months, the current one hatched, every zero month as a zero stub', () => {
    stubReducedMotion(true);
    const { container } = renderPlot();
    const months = container.querySelectorAll('[data-month]');
    expect(months).toHaveLength(13);
    const zeros = [...container.querySelectorAll('[data-zero="true"]')].map((g) =>
      g.getAttribute('data-month'),
    );
    expect(zeros).toEqual(['2025-12', '2026-06']);
    for (const month of zeros) {
      expect(container.querySelector(`[data-month="${month!}"] [data-zero-stub]`)).not.toBeNull();
      expect(container.querySelector(`[data-month="${month!}"] [data-column-bar]`)).toBeNull();
    }
    const current = container.querySelector('[data-current="true"] [data-column-bar]');
    expect(current?.getAttribute('fill')).toMatch(/^url\(#category-hatch-/u);
    const past = container.querySelector('[data-month="2026-09"] [data-column-bar]');
    expect(past?.getAttribute('fill')).toBe('var(--chart-fill-teal)');
  });

  it('draws the dashed average line at the average, in --chart-label, labelled with its amount', () => {
    stubReducedMotion(true);
    const { container } = renderPlot();
    const group = screen.getByTestId('category-average-line');
    expect(group.getAttribute('data-average-minor')).toBe('35667');
    const line = group.querySelector('line')!;
    expect(line.getAttribute('stroke-dasharray')).toBe('5 4');
    expect(line.getAttribute('stroke')).toBe('var(--chart-label)');
    // The domain [0, 52 000] niced to four ticks is [0, 60 000]: the line sits at 35 667 of it.
    const expectedY = INNER_HEIGHT - (INNER_HEIGHT * 35667) / 60000;
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(expectedY, 3);
    expect(Number(line.getAttribute('y2'))).toBeCloseTo(expectedY, 3);
    expect(group.textContent).toBe('Avg $356.67');
    // …and every bar's top is on the same scale: October so far (21 000) ends below the line, August (43 000) above.
    const top = (month: string) =>
      Math.min(
        ...[
          ...container
            .querySelector(`[data-month="${month}"] [data-column-bar]`)!
            .getAttribute('d')!
            .matchAll(/[\d.]+,(-?[\d.]+)/gu),
        ].map((match) => Number(match[1])),
      );
    expect(top('2026-10')).toBeGreaterThan(expectedY);
    expect(top('2026-08')).toBeLessThan(expectedY);
  });

  it('draws no average line, and no column before the ledger began, with one complete month', () => {
    stubReducedMotion(true);
    const { container } = renderPlot(withOneCompleteMonth());
    expect(screen.queryByTestId('category-average-line')).toBeNull();
    expect(container.querySelectorAll('[data-in-history="false"] [data-column-bar]')).toHaveLength(
      0,
    );
    expect(container.querySelectorAll('[data-in-history="false"] [data-zero-stub]')).toHaveLength(
      0,
    );
  });

  it('marks the selected month and dims the others', () => {
    stubReducedMotion(true);
    const { container } = renderPlot(historyWire(), 5);
    expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-month')).toBe(
      '2026-03',
    );
    expect(container.querySelector('[data-month="2026-04"]')?.getAttribute('opacity')).toBe('0.45');
    expect(container.querySelector('[data-month="2026-03"]')?.getAttribute('opacity')).toBe('1');
    expect(screen.getByTestId('category-selected-marker')).toBeInTheDocument();
  });

  it('grows the columns once on first draw, and never under reduced motion', () => {
    stubReducedMotion(false);
    let animate = stubAnimate();
    const first = renderPlot();
    expect(animate).toHaveBeenCalledTimes(11);
    first.rerender(
      <CategoryHistoryInner
        width={WIDTH}
        height={HEIGHT}
        view={historyOf(historyWire())}
        hue="teal"
        selected={3}
        onSelect={() => {}}
      />,
    );
    expect(animate).toHaveBeenCalledTimes(11);
    first.unmount();

    stubReducedMotion(true);
    animate = stubAnimate();
    renderPlot();
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('CategoryHistoryChart: keyboard selection', () => {
  it('moves the month with the arrow keys and announces it', () => {
    stubReducedMotion(true);
    const onSelect = vi.fn();
    render(
      <CategoryHistoryChart
        view={historyOf(historyWire())}
        hue="teal"
        title="Groceries by month"
        selected={12}
        onSelect={onSelect}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Groceries by month: choose a month' });
    expect(slider).toHaveAttribute('aria-valuenow', '13');
    expect(slider.getAttribute('aria-valuetext')).toMatch(
      /^October 2026 \(so far\): \$210\.00 spent/u,
    );
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith(11);
    expect(screen.getByTestId('category-history-announcement')).toHaveTextContent(
      'September 2026: $390.00 spent; $33.33 more than your average month of $356.67.',
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: 'Tab' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('lists every month in the table, zero months as "No spend"', () => {
    stubReducedMotion(true);
    render(
      <CategoryHistoryChart
        view={historyOf(historyWire())}
        hue="teal"
        title="Groceries by month"
        selected={12}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View as table/u }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(13);
    expect(rows[2]).toHaveTextContent('December 2025No spend0');
    expect(rows[12]).toHaveTextContent('October 2026 (so far)$210.00');
  });
});
