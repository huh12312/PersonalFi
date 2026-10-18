// SPDX-License-Identifier: MIT
/**
 * The thirteen chart fills: which step of each hue, and in which order (WP 10.8).
 *
 * **Order.** The categorical order is a separable choice (the dataviz skill's "theme"). The brief's listing order
 * (`CHART_HUES`, alphabet-like) puts red↔orange at normal-vision ΔE 7.8 and orange↔yellow at CVD ΔE 3.5, so it
 * cannot be the order neighbours are drawn in. This one was found by exhaustive search (a subset DP over every
 * order and every in-band step, the same order in both themes) maximising the worst adjacent pair: it clears CVD
 * ΔE ≥ 10.2 and normal-vision ΔE ≥ 20.5 on every adjacent pair, light and dark. Charts whose marks touch in a fixed
 * sequence (donut slices, stacked segments) draw in this order; `tokens.test.ts` holds the floors.
 *
 * **Steps.** Per theme, the step whose OKLCH lightness sits in the skill's band (0.43–0.77 light, 0.48–0.67
 * dark) and which clears 3:1 on every chart surface (`--bg-page`, `--bg-primary`, `--bg-overlay`; the worst is
 * the page in light and the overlay in dark). `brown` (both themes) and `mint` (both), and
 * `lime` and `yellow` (dark), have **no** in-band step at chroma ≥ 0.10 — Radix's brown and mint are muted by
 * design — so they fall under the chroma floor; `CHROMA_EXEMPT` names them and the test fails on any other.
 *
 * **Events.** Four roles per hue for a marker on a timeline: a wash (step 3), its border (step 7), the dot (the
 * fill step) and the label ink (step 11, or 12 where 11 is under 4.5:1 on its own wash or a chart surface: light cyan, green,
 * lime, orange, teal and yellow).
 */
import type { ChartHue } from '@core/kernel';

export const CHART_FILL_ORDER = [
  'green',
  'purple',
  'lime',
  'pink',
  'yellow',
  'cyan',
  'red',
  'teal',
  'orange',
  'sky',
  'brown',
  'indigo',
  'mint',
] as const satisfies readonly ChartHue[];

export const FILL_STEPS: Readonly<
  Record<ChartHue, { readonly light: number; readonly dark: number }>
> = {
  green: { light: 10, dark: 9 },
  purple: { light: 9, dark: 9 },
  lime: { light: 11, dark: 8 },
  pink: { light: 9, dark: 9 },
  yellow: { light: 11, dark: 8 },
  cyan: { light: 10, dark: 9 },
  red: { light: 9, dark: 9 },
  teal: { light: 10, dark: 9 },
  orange: { light: 10, dark: 8 },
  sky: { light: 11, dark: 8 },
  brown: { light: 9, dark: 9 },
  indigo: { light: 9, dark: 9 },
  mint: { light: 11, dark: 8 },
};

export const EVENT_STEPS: Readonly<
  Record<ChartHue, { readonly bg: number; readonly fgLight: number; readonly fgDark: number }>
> = {
  green: { bg: 3, fgLight: 12, fgDark: 11 },
  purple: { bg: 3, fgLight: 11, fgDark: 11 },
  lime: { bg: 3, fgLight: 12, fgDark: 11 },
  pink: { bg: 3, fgLight: 11, fgDark: 11 },
  yellow: { bg: 3, fgLight: 12, fgDark: 11 },
  cyan: { bg: 3, fgLight: 12, fgDark: 11 },
  red: { bg: 3, fgLight: 11, fgDark: 11 },
  teal: { bg: 3, fgLight: 12, fgDark: 11 },
  orange: { bg: 3, fgLight: 12, fgDark: 11 },
  sky: { bg: 3, fgLight: 11, fgDark: 11 },
  brown: { bg: 3, fgLight: 11, fgDark: 11 },
  indigo: { bg: 3, fgLight: 11, fgDark: 11 },
  mint: { bg: 3, fgLight: 11, fgDark: 11 },
};

/** Fills below the 0.10 chroma floor at every in-band step (see above). */
export const CHROMA_EXEMPT: Readonly<Record<'light' | 'dark', readonly ChartHue[]>> = {
  light: ['brown', 'mint'],
  dark: ['brown', 'mint', 'lime', 'yellow'],
};
