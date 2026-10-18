// SPDX-License-Identifier: MIT
/**
 * The colour roles of the forward cash-flow chart (WP 10.7), by job (the dataviz method: colour comes last and
 * each colour does one job). Named here, once, so `ForecastBandChart.tsx` draws with exactly these and
 * `src/styles/contrast.test.ts` measures exactly these, in both themes, on every chart surface. A role swapped
 * for a token that fails its contrast fails the unit suite.
 *
 *  - `line` / `band`: the running total and its uncertainty — one series, the accent (categorical slot 1), the
 *    band a ~12 % wash of it.
 *  - `outflow` / `inflow`: a charge's *sign*, the house CVD-safe money pair (vermilion / teal), never red/green.
 *    Validated with the dataviz skill's `validate_palette.js --pairs all` together with `line`: light
 *    `#2563eb,#d2452f,#0f8a68` on `#ffffff` and dark `#3987e5,#e8604a,#1ba277` on `#16181a`, all checks PASS
 *    (worst CVD ΔE 9.9 light / 8.8 dark, normal-vision 25.2 / 20.5, every mark ≥ 3:1). The marks also differ by
 *    shape (▼ out, ▲ in), so the sign never rests on hue alone.
 *  - `baseline`: the labelled $0 line; `axisInk`: tick labels (text, so 4.5:1); `gridline`: recessive hairlines
 *    (decorative, exempt from 1.4.11); `ring`: the 2 px surface ring around a mark.
 *
 * WP 10.8 moved every role onto the semantic chart roles of `src/styles/tokens.css` (was `--accent`,
 * `--money-neg`, `--money-pos`, `--chart-axis-ink`, `--bg-surface`). Same values: `--chart-line` is the accent,
 * `--chart-expenses`/`--chart-income` the money pair, `--chart-axis`/`--chart-label` the old axis ink; the ring
 * moved from #ffffff to sand-1 #fdfdfc (ΔE 0.6).
 */
export const FORECAST_CHART_TOKENS = {
  line: '--chart-line',
  band: '--chart-line',
  outflow: '--chart-expenses',
  inflow: '--chart-income',
  baseline: '--chart-axis',
  axisInk: '--chart-label',
  gridline: '--chart-gridline',
  ring: '--bg-primary',
} as const;

/** Roles that are marks a reader must see: ≥ 3:1 against the chart surface (WCAG 1.4.11). */
export const FORECAST_MARK_ROLES = ['line', 'outflow', 'inflow', 'baseline'] as const;

/** Roles that are text: ≥ 4.5:1 (WCAG 1.4.3). */
export const FORECAST_TEXT_ROLES = ['axisInk'] as const;

export function chartVar(role: keyof typeof FORECAST_CHART_TOKENS): string {
  return `var(${FORECAST_CHART_TOKENS[role]})`;
}
