// SPDX-License-Identifier: MIT
/**
 * The colour roles of the stacked net-worth chart (WP 10.13, V6), by job — named once so
 * `NetWorthStackedChart.tsx` draws with exactly these and `src/styles/contrast.test.ts` measures exactly
 * these, in both themes. The segments are not here: each is its account type's fill through
 * `accountTypeHue` (`chart-hue.ts`, V1's fixed mapping), measured with the other fills.
 *
 *  - `net`: the single-series line role, a 2 px line with 8 px ringed dots over the bars — a different mark
 *    from the segments, so net never rests on hue alone; `ring`: the 2 px surface ring round each dot.
 *  - `negativeArea`: the below-zero wash; `crosshair`: the 1 px hairline through the selected bucket (not a
 *    band behind it: the orange fill falls to 2.93:1 on `--bg-secondary` in the light theme — measured in
 *    `contrast.test.ts` — and the selection is also the dimming, the readout, the hero, the slider's value and
 *    the bold tick).
 *  - `axis` / `gridline`: the zero line and the recessive grid; `axisInk` / `axisInkStrong`: tick text and
 *    the selected bucket's tick.
 */
export const NET_WORTH_CHART_TOKENS = {
  net: '--chart-line',
  ring: '--bg-primary',
  negativeArea: '--chart-negative-area',
  crosshair: '--chart-axis',
  axis: '--chart-axis',
  gridline: '--chart-gridline',
  axisInk: '--chart-label',
  axisInkStrong: '--text-primary',
} as const;

/** Marks a reader must see: ≥ 3:1 against the chart surface (WCAG 1.4.11). */
export const NET_WORTH_MARK_ROLES = ['net', 'axis', 'crosshair'] as const;

/** Text: ≥ 4.5:1 (WCAG 1.4.3), on the chart surfaces. */
export const NET_WORTH_TEXT_ROLES = ['axisInk', 'axisInkStrong'] as const;

export function netWorthVar(role: keyof typeof NET_WORTH_CHART_TOKENS): string {
  return `var(${NET_WORTH_CHART_TOKENS[role]})`;
}
