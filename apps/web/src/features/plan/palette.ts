// SPDX-License-Identifier: MIT
/**
 * The Monte Carlo fan chart's band ramp (`docs/plan/04-phase-4-dispatch.md`
 * §3 "WP 4.10"; `docs/research/05-frontend-architecture.md` §3.4: "5 bands
 * … from the sequential blue ramp, lightest outside → darkest inside …
 * this is a sequential encoding of *confidence*, so one hue, light→dark —
 * not a rainbow").
 *
 * There is no pre-existing sequential-ramp token in `src/styles/theme.css`
 * (the file WP 4.10 does not own — see the route's ownership list) and no
 * `--fan-*`/`--band-*` custom property exists to read. Rather than invent
 * five new hex constants that would drift from `--accent` the day someone
 * retunes it, every band is **`--accent` itself at a fixed opacity** —
 * still "one hue, light→dark" (opacity *is* the lightening/darkening
 * mechanism here, exactly like `NetWorthAreaChart`'s own gradient fading to
 * 4%), automatically theme-correct in both modes with zero new tokens, and
 * impossible to accidentally turn into a second hue later.
 *
 * Two different roles get two different opacity ladders:
 *   - **Fills** (`BAND_FILL_OPACITY`) are soft decorative context — the
 *     actual values are carried by the axis, the tooltip and the direct
 *     crossing/median labels, never by the fill colour alone (05 §3.4's own
 *     "no meaning by colour alone" rule) — so they are allowed under WCAG
 *     1.4.11's 3:1 non-text floor, the same trade `NetWorthAreaChart`
 *     already makes.
 *   - **Strokes** (`BAND_STROKE_OPACITY`, `MEDIAN_OPACITY`) are the actual
 *     graphical marks a reader locates a percentile boundary or the median
 *     by, so each opacity here is chosen to clear the 3:1 floor against
 *     both themes' page surface (verified below and in
 *     `docs/evidence/phase-4/wp4.10-plan-ui.md`).
 */

/** Outer → inner: p5–p95 (widest, least certain) to p25–p75 (narrowest, most certain). */
export const BAND_FILL_OPACITY: readonly [number, number, number] = [0.1, 0.17, 0.26];

/** The six percentile boundary lines (p5/p10/p25/p75/p90/p95) — thin marks, not fills. */
export const BAND_STROKE_OPACITY = 0.75;

/** The 2px accent median line — 05 §3.4's "2px `--accent` median line". */
export const MEDIAN_OPACITY = 1;

/**
 * `--accent`'s two theme values, duplicated here only so
 * `scripts/validate_palette.js`'s evidence run and this module's own unit
 * test can compute the *effective* flattened colour (surface + opacity ×
 * accent) without a DOM — `getComputedStyle` is not available to a Vitest
 * (jsdom) unit test the way it is in a browser, and the effective colour,
 * not the CSS variable, is what a contrast check needs. The chart itself
 * never reads these constants — it reads `var(--accent)` directly, per
 * `05-frontend-architecture.md` §3.3 item 2 ("total control, reads CSS
 * custom properties directly").
 */
export const ACCENT_HEX = { light: '#2563eb', dark: '#3987e5' } as const;
export const SURFACE_HEX = { light: '#ffffff', dark: '#16181a' } as const;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

/** Flatten `accent` at `opacity` over `surface` into one opaque hex — for evidence/tests only. */
export function flatten(surface: string, accent: string, opacity: number): string {
  const s = parseHex(surface);
  const a = parseHex(accent);
  const r = a.r * opacity + s.r * (1 - opacity);
  const g = a.g * opacity + s.g * (1 - opacity);
  const b = a.b * opacity + s.b * (1 - opacity);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** The three fill bands' effective colours for one theme, outer → inner. */
export function effectiveBandFills(theme: 'light' | 'dark'): readonly [string, string, string] {
  const surface = SURFACE_HEX[theme];
  const accent = ACCENT_HEX[theme];
  return BAND_FILL_OPACITY.map((opacity) => flatten(surface, accent, opacity)) as [
    string,
    string,
    string,
  ];
}

export function effectiveBandStroke(theme: 'light' | 'dark'): string {
  return flatten(SURFACE_HEX[theme], ACCENT_HEX[theme], BAND_STROKE_OPACITY);
}
