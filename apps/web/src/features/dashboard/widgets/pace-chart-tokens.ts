// SPDX-License-Identifier: MIT
/**
 * The colour roles of the spending pace chart (WP 10.9), by job — named once so `SpendingPaceChart.tsx` draws with
 * exactly these and `src/styles/contrast.test.ts` measures exactly these, in both themes, on every chart surface.
 *
 *  - `thisMonth`: the month being read, the one loud mark — money out, so the house expenses role (the CVD-safe
 *    vermilion of the teal/vermilion pair), a solid 2 px line.
 *  - `lastMonth`: the comparison — the single-series line role (the accent) **dotted** and at reduced opacity
 *    (`PACE_LAST_MONTH_OPACITY`), so it reads as a reference behind the month, not a second headline. Its
 *    *blended* colour is what the contrast test measures, at 3:1.
 *  - `average`: the trailing three-month average, a 1 px hairline in the label ink (4.5:1 as text, so ≥ 3:1 as a
 *    mark), recessive by width rather than by colour.
 *  - `today`: the vertical hairline at today, the axis role; `ring`: the 2 px surface ring round today's dot.
 *  - `axisInk` / `gridline`: tick text (4.5:1) and the recessive solid hairlines (decorative, exempt).
 *
 * The three series also differ by stroke (solid / dotted / hairline) and are named in a legend and the table, so
 * identity never rests on hue alone.
 */
export const PACE_CHART_TOKENS = {
  thisMonth: '--chart-expenses',
  lastMonth: '--chart-line',
  average: '--chart-label',
  today: '--chart-axis',
  axisInk: '--chart-label',
  gridline: '--chart-gridline',
  ring: '--bg-primary',
} as const;

/** The last-month line's opacity. The contrast test measures the colour blended at this opacity. */
export const PACE_LAST_MONTH_OPACITY = 0.75;

/** Marks a reader must see: ≥ 3:1 against the chart surface (WCAG 1.4.11). `lastMonth` is measured blended. */
export const PACE_MARK_ROLES = ['thisMonth', 'lastMonth', 'average', 'today'] as const;

/** Text: ≥ 4.5:1 (WCAG 1.4.3). */
export const PACE_TEXT_ROLES = ['axisInk'] as const;

export function paceVar(role: keyof typeof PACE_CHART_TOKENS): string {
  return `var(${PACE_CHART_TOKENS[role]})`;
}
