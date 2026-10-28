// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { CHART_HUES } from '@core/kernel';

import tokensCss from './tokens.css?raw';
import tokensTs from './tokens.ts?raw';
import { TOKENS } from './tokens.ts';
import {
  CHROMA_FLOOR,
  CVD_TARGET,
  LIGHTNESS_BAND,
  NORMAL_FLOOR,
  contrast,
  cvdDeltaE,
  deltaE,
  oklch,
} from './tokens/colour-math.ts';
import { CHART_FILL_ORDER, CHROMA_EXEMPT } from './tokens/fills.ts';
import { renderCss, renderTs, resolveAll, THEME_NAMES } from './tokens/generate.ts';
import { RADIX_SCALES } from './tokens/radix-colors.ts';
import { ROLE_GROUPS } from './tokens/roles.ts';

/**
 * WP 10.8: the token layer is generated from one source (`tokens/roles.ts`, `tokens/fills.ts`, the vendored
 * `tokens/radix-colors.ts`) into `tokens.css` (what the browser reads) and `tokens.ts` (what canvas/SVG code and
 * tests read). These tests are what make "they cannot drift" true, and what hold the thirteen chart fills to the
 * dataviz skill's checks. `contrast.test.ts` holds every foreground/background role pair.
 */

function cssBlocks(css: string): Record<string, Record<string, string>> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, Record<string, string>> = {};
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '')
      .replace(/@media[^{]*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const decls: Record<string, string> = {};
    for (const d of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      decls[d[1] as string] = (d[2] as string).trim();
    }
    out[selector] = decls;
  }
  return out;
}

describe('CSS and TS are one source', () => {
  it('tokens.css is exactly what the generator produces (run `node scripts/gen-tokens.ts`)', () => {
    expect(tokensCss === renderCss()).toBe(true);
  });

  it('tokens.ts is exactly what the generator produces', () => {
    expect(tokensTs === renderTs()).toBe(true);
  });

  it('every CSS custom property has the same value in the TS object, per theme, and nothing is missing', () => {
    const blocks = cssBlocks(tokensCss);
    const light = blocks[":root, [data-theme='light']"];
    const dark = blocks["[data-theme='dark']"];
    const system = blocks[':root:not([data-theme])'];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(system).toEqual(dark);
    expect(light).toEqual(TOKENS.light);
    expect(dark).toEqual(TOKENS.dark);
  });
});

describe('the role source', () => {
  it('every off-scale value says why; every scale step resolves', () => {
    const missing: string[] = [];
    for (const token of resolveAll()) {
      if (token.aliasOf !== null) continue;
      for (const theme of THEME_NAMES) {
        const ref = token.ref[theme];
        const onScale = /^[a-z]+-\d{1,2}$/.test(ref);
        if (!onScale && token.why === null) missing.push(`${token.name} (${theme}: ${ref})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('declares every WP 10.8 role the brief names', () => {
    const names = new Set(ROLE_GROUPS.flatMap((g) => Object.keys(g.roles)));
    const required = [
      ...['page', 'primary', 'secondary', 'tertiary', 'inset', 'overlay'].map((s) => `--bg-${s}`),
      ...['primary', 'secondary', 'tertiary', 'muted', 'disabled', 'on-brand'].map(
        (s) => `--text-${s}`,
      ),
      ...['primary', 'secondary', 'divider'].map((s) => `--border-${s}`),
      ...['success', 'danger', 'warning', 'info'].flatMap((s) =>
        ['bg', 'border', 'text', 'bold'].map((p) => `--status-${s}-${p}`),
      ),
      ...['income', 'expenses', 'negative-area', 'line', 'axis', 'label', 'gridline'].map(
        (s) => `--chart-${s}`,
      ),
      ...CHART_HUES.map((h) => `--chart-fill-${h}`),
      ...CHART_HUES.flatMap((h) =>
        ['bg', 'border', 'dot', 'fg'].map((r) => `--chart-event-${r}-${h}`),
      ),
    ];
    expect(required.filter((n) => !names.has(n))).toEqual([]);
    expect(required).toHaveLength(6 + 6 + 3 + 16 + 7 + 13 + 52);
  });

  it('vendors fourteen complete Radix scales (sand + the thirteen hues), light and dark', () => {
    expect(Object.keys(RADIX_SCALES).sort()).toEqual(['sand', ...CHART_HUES].sort());
    for (const scale of Object.values(RADIX_SCALES)) {
      for (const theme of THEME_NAMES) {
        expect(scale[theme]).toHaveLength(12);
        for (const hex of scale[theme]) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // Spot values from the 3.0.0 tarball (docs/research/10 §1.2 names the same steps).
    expect(RADIX_SCALES.teal.light[8]).toBe('#12a594');
    expect(RADIX_SCALES.sand.dark[0]).toBe('#111110');
    expect(RADIX_SCALES.cyan.light[8]).toBe('#00a2c7');
  });
});

/** The thirteen fills, in the validated order, on every chart surface. */
function fills(theme: 'light' | 'dark'): string[] {
  return CHART_FILL_ORDER.map((hue) => TOKENS[theme][`--chart-fill-${hue}`]);
}
const CHART_SURFACES = ['--bg-page', '--bg-primary', '--bg-overlay'] as const;

describe('the thirteen chart fills pass the dataviz checks', () => {
  it('the order is a permutation of the thirteen hues', () => {
    expect([...CHART_FILL_ORDER].sort()).toEqual([...CHART_HUES].sort());
  });

  for (const theme of THEME_NAMES) {
    it(`${theme}: every fill is inside the lightness band`, () => {
      const [lo, hi] = LIGHTNESS_BAND[theme];
      const off = fills(theme).filter((hex) => oklch(hex).l < lo || oklch(hex).l > hi);
      expect(off).toEqual([]);
    });

    it(`${theme}: every fill clears the chroma floor, except the named muted hues`, () => {
      const low = CHART_FILL_ORDER.filter(
        (hue) => oklch(TOKENS[theme][`--chart-fill-${hue}`]).c < CHROMA_FLOOR,
      );
      expect(low.sort()).toEqual([...CHROMA_EXEMPT[theme]].sort());
    });

    it(`${theme}: every adjacent pair clears CVD ΔE ${String(CVD_TARGET)} and normal-vision ΔE ${String(NORMAL_FLOOR)}`, () => {
      const palette = fills(theme);
      const weak: string[] = [];
      for (let i = 1; i < palette.length; i += 1) {
        const [a, b] = [palette[i - 1] as string, palette[i] as string];
        const cvd = cvdDeltaE(a, b);
        const normal = deltaE(a, b);
        if (cvd < CVD_TARGET || normal < NORMAL_FLOOR) {
          weak.push(
            `${String(CHART_FILL_ORDER[i - 1])}↔${String(CHART_FILL_ORDER[i])}: CVD ${cvd.toFixed(1)}, normal ${normal.toFixed(1)}`,
          );
        }
      }
      expect(weak).toEqual([]);
    });

    it(`${theme}: every fill is a 3:1 mark on every chart surface`, () => {
      const low = fills(theme).flatMap((hex) =>
        CHART_SURFACES.map((bg) => [hex, bg, contrast(hex, TOKENS[theme][bg])] as const).filter(
          ([, , r]) => r < 3,
        ),
      );
      expect(low).toEqual([]);
    });
  }
});
