// SPDX-License-Identifier: MIT
/**
 * The colour roles of the Cash Flow hub's bars chart (WP 10.10), by job — named once so `CashFlowBarsChart.tsx`
 * draws with exactly these and `src/styles/contrast.test.ts` measures exactly these, in both themes.
 *
 *  - `income` / `expenses`: the house money-in / money-out pair (the CVD-safe teal/vermilion of V1), columns.
 *  - `net`: the single-series line role (the accent), a 2 px line with ringed dots — a different mark from the
 *    columns, so net never rests on hue alone.
 *  - `negativeArea`: the below-zero wash; `selectedBand`: the quiet band behind the selected period (decorative:
 *    the selected period is also bold on the axis and `aria-pressed`).
 *  - `axis` / `gridline`: the zero line and the recessive grid; `axisInk` / `axisInkStrong`: tick text (4.5:1) and
 *    the selected period's tick; `ring`: the 2 px surface ring round each net dot.
 */
export const CASH_FLOW_CHART_TOKENS = {
  income: '--chart-income',
  expenses: '--chart-expenses',
  net: '--chart-line',
  negativeArea: '--chart-negative-area',
  selectedBand: '--bg-secondary',
  axis: '--chart-axis',
  gridline: '--chart-gridline',
  axisInk: '--chart-label',
  axisInkStrong: '--text-primary',
  ring: '--bg-primary',
} as const;

/** Marks a reader must see: ≥ 3:1 against the chart surface (WCAG 1.4.11). */
export const CASH_FLOW_MARK_ROLES = ['income', 'expenses', 'net', 'axis'] as const;

/** Text: ≥ 4.5:1 (WCAG 1.4.3), on the surface and on the selected band. */
export const CASH_FLOW_TEXT_ROLES = ['axisInk', 'axisInkStrong'] as const;

export function cashFlowVar(role: keyof typeof CASH_FLOW_CHART_TOKENS): string {
  return `var(${CASH_FLOW_CHART_TOKENS[role]})`;
}
