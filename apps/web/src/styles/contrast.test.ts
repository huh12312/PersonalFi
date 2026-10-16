// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { ACCENT_HEX, SURFACE_HEX } from '../features/plan/palette.ts';
import {
  FORECAST_CHART_TOKENS,
  FORECAST_MARK_ROLES,
  FORECAST_TEXT_ROLES,
} from '../features/recurring/forecast-chart-tokens.ts';
import themeCss from './theme.css?raw';

/**
 * WP 9.8 (09 §3 "WP 9.8" (4); CF-8, CF-9, CF-10). The contrast of every
 * declared colour pair, computed straight from `theme.css` — the file the
 * browser reads — so a token edit that breaks a pair fails here, in the unit
 * suite, before any Playwright run could see it.
 *
 * Four things are checked, and the order is the order of how a colour gets
 * past a reviewer:
 *
 *  1. **The two dark palettes are the same palette.** `theme.css` declares dark
 *     twice — `[data-theme='dark']` and `@media (prefers-color-scheme: dark)
 *     :root:not([data-theme])` — so every token fix has to be made twice, and
 *     until this test nothing checked that both copies agreed (CF-10).
 *  2. **The declared pairs** (`TEXT_PAIRS`, `UI_PAIRS`): every text token on
 *     every surface it can be drawn on at ≥ 4.5:1 (1.4.3) and every
 *     non-text token on its surfaces at ≥ 3:1 (1.4.11), in both themes.
 *  3. **The pairs the components actually use.** every non-test source file under `src/` is scanned for
 *     every string that names a `bg-<token>` and a `text-<token>` together
 *     (`cva` variants, badge maps, `className`s), per `hover:` / `data-[…]:`
 *     state, and each is computed too. A new `bg-status-warning text-text-primary`
 *     therefore fails here without anyone having to remember to declare it.
 *     (`--border-hairline` dividers are decorative and exempt from 1.4.11;
 *     `disabled:` states are exempt from 1.4.3.)
 *  4. **No colour outside the tokens.** A hex or `rgb()` literal, or a
 *     Tailwind palette/`white`/`black` colour class, in a component is a
 *     colour this test cannot see — it is refused unless it is one of the
 *     named exceptions below, each with the reason it is safe.
 *
 * The WCAG relative-luminance formula is twenty lines; no colour-contrast
 * package is installed, and none may be (09 §3 preamble).
 */

// ---------------------------------------------------------------------------
// WCAG 2.x contrast
// ---------------------------------------------------------------------------

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex?.[1] !== undefined) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgba !== null) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`contrast.test.ts cannot parse the colour "${value}"`);
}

/** `top` drawn over an opaque `under` at `top.a`. */
function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number): number => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance(c: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// theme.css, parsed
// ---------------------------------------------------------------------------

type Palette = Record<string, string>;

interface Rule {
  readonly selector: string;
  readonly body: string;
  /** The `@media` prelude this rule sits in, if any. */
  readonly media: string | null;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Top-level rules and rules one `@media` deep — all `theme.css` has. */
function parseRules(css: string, media: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let close = open + 1;
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth += 1;
      else if (css[close] === '}') depth -= 1;
      close += 1;
    }
    const body = css.slice(open + 1, close - 1);
    if (prelude.startsWith('@media')) rules.push(...parseRules(body, prelude));
    else if (!prelude.startsWith('@')) rules.push({ selector: prelude, body, media });
    index = close;
  }
  return rules;
}

function declarations(body: string): Palette {
  const out: Palette = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1] as string] = (match[2] as string).trim();
  }
  return out;
}

const css = stripComments(themeCss);
const rules = parseRules(css);

function merged(predicate: (rule: Rule) => boolean): Palette {
  return Object.assign({}, ...rules.filter(predicate).map((rule) => declarations(rule.body)));
}

const lightDeclared = merged((r) => r.selector === ':root' && r.media === null);
const darkDeclared = merged((r) => r.selector === "[data-theme='dark']" && r.media === null);
const darkMediaDeclared = merged(
  (r) =>
    r.selector === ':root:not([data-theme])' &&
    (r.media ?? '').includes('prefers-color-scheme: dark'),
);

const palettes = {
  light: lightDeclared,
  dark: { ...lightDeclared, ...darkDeclared },
} as const;

type Theme = keyof typeof palettes;
const THEMES: readonly Theme[] = ['light', 'dark'];

function colorOf(theme: Theme, token: string): Rgba {
  const value = palettes[theme][token];
  if (value === undefined) throw new Error(`${token} is not declared for the ${theme} theme`);
  return parseColor(value);
}

/** `@theme { --color-bg-page: var(--bg-page) }` — the Tailwind colour name → the runtime token. */
const colorUtilities = new Map<string, string>();
for (const match of css.matchAll(/--color-([\w-]+)\s*:\s*var\((--[\w-]+)\)/g)) {
  colorUtilities.set(match[1] as string, match[2] as string);
}

// ---------------------------------------------------------------------------
// 2. The declared pairs
// ---------------------------------------------------------------------------

/** Surfaces that body text and controls are drawn on. */
const SURFACES = ['--bg-page', '--bg-surface', '--bg-surface-raised', '--bg-subtle'] as const;
/** Surfaces a chart is drawn on. */
const CHART_SURFACES = ['--bg-page', '--bg-surface', '--bg-surface-raised'] as const;

/** [foreground token, background token] — all ≥ 4.5:1 (1.4.3). */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ...(['--text-primary', '--text-secondary', '--text-muted', '--money-neutral'] as const).flatMap(
    (fg) => [...SURFACES, '--accent-wash'].map((bg) => [fg, bg] as const),
  ),
  ...(
    [
      '--accent-text',
      '--money-pos-text',
      '--money-neg-text',
      '--status-good',
      '--status-warning',
      '--status-serious',
      '--status-critical',
    ] as const
  ).flatMap((fg) => [...SURFACES, '--accent-wash'].map((bg) => [fg, bg] as const)),
  // Chart tick labels are SVG text on a chart surface.
  ...CHART_SURFACES.map((bg) => ['--chart-axis-ink', bg] as const),
  // Filled controls and their text, at rest and hovered.
  ['--accent-contrast', '--accent'],
  ['--accent-contrast', '--accent-hover'],
  ['--on-danger', '--danger'],
  ['--on-danger', '--danger-hover'],
  ['--on-status-warning', '--status-warning'],
];

/** [non-text token, surface token] — all ≥ 3:1 (1.4.11). */
const UI_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // The focus indicator, on everything it can ring.
  ...[...SURFACES, '--bg-inset', '--accent-wash'].map((bg) => ['--focus-ring', bg] as const),
  // The boundary of a form control or a switch.
  ...SURFACES.map((bg) => ['--border-strong', bg] as const),
  // A filled control's own boundary, and the on-state of a switch / a progress bar.
  ...[...SURFACES].flatMap((bg) => [['--accent', bg] as const, ['--danger', bg] as const]),
  // Marks that carry money meaning, and status glyphs.
  ...(['--money-pos', '--money-neg'] as const).flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg] as const),
  ),
  // Categorical chart series (fixed order, drawn on a chart surface).
  ...Array.from({ length: 8 }, (_, i) => `--series-${String(i + 1)}`).flatMap((fg) =>
    CHART_SURFACES.map((bg) => [fg, bg] as const),
  ),
];

describe('theme.css palettes', () => {
  it('the two dark palettes are identical', () => {
    expect(Object.keys(darkMediaDeclared).length).toBeGreaterThan(20);
    // Same names, same values — a token fixed in one copy only is the bug (CF-10).
    expect(Object.keys(darkMediaDeclared).sort()).toEqual(Object.keys(darkDeclared).sort());
    const differing = Object.keys(darkDeclared).filter(
      (token) => darkDeclared[token] !== darkMediaDeclared[token],
    );
    expect(differing).toEqual([]);
  });

  it('every colour token is declared for the light theme and overridden for dark only where it is declared at all', () => {
    for (const token of Object.keys(darkDeclared)) {
      expect(lightDeclared[token], `${token} has a dark value but no light value`).toBeDefined();
    }
  });

  it('the plan palette duplicates the accent and the surface faithfully', () => {
    expect(ACCENT_HEX.light).toBe(palettes.light['--accent']);
    expect(ACCENT_HEX.dark).toBe(palettes.dark['--accent']);
    expect(SURFACE_HEX.light).toBe(palettes.light['--bg-surface']);
    expect(SURFACE_HEX.dark).toBe(palettes.dark['--bg-surface']);
  });
});

describe('declared pairs', () => {
  for (const theme of THEMES) {
    it(`every declared text pair clears 4.5:1 in the ${theme} theme`, () => {
      const failing = TEXT_PAIRS.flatMap(([fg, bg]) => {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        return r >= 4.5 ? [] : [`${fg} on ${bg}: ${r.toFixed(2)}:1`];
      });
      expect(failing).toEqual([]);
    });

    it(`every declared UI pair clears 3:1 in the ${theme} theme`, () => {
      const failing = UI_PAIRS.flatMap(([fg, bg]) => {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        return r >= 3 ? [] : [`${fg} on ${bg}: ${r.toFixed(2)}:1`];
      });
      expect(failing).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The pairs the components use
// ---------------------------------------------------------------------------

const sources = import.meta.glob(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../routeTree.gen.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

interface UsedPair {
  readonly file: string;
  readonly state: string;
  readonly fg: string;
  readonly bg: string;
  readonly bgAlpha: number;
  readonly fgAlpha: number;
  readonly literal: string;
}

/** Every `'…'`, `"…"` and `` `…` `` that names at least one colour utility. */
function colourLiterals(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/'([^'\n]+)'|"([^"\n]+)"|`([^`]+)`/g)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    if (/(^|[\s:])(bg|text)-[a-z]/.test(text)) out.push(text);
  }
  return out;
}

interface Utility {
  readonly state: string;
  readonly kind: 'bg' | 'text';
  readonly token: string;
  readonly alpha: number;
}

function utilitiesOf(literal: string): Utility[] {
  const out: Utility[] = [];
  for (const word of literal.split(/\s+/)) {
    const cut = word.lastIndexOf(':');
    const state = cut === -1 ? '' : word.slice(0, cut);
    const utility = cut === -1 ? word : word.slice(cut + 1);
    const match = /^(bg|text)-([a-z0-9-]+?)(?:\/(\d+))?$/.exec(utility);
    if (match === null) continue;
    const token = colorUtilities.get(match[2] as string);
    if (token === undefined) continue;
    out.push({
      state,
      kind: match[1] as 'bg' | 'text',
      token,
      alpha: match[3] === undefined ? 1 : Number(match[3]) / 100,
    });
  }
  return out;
}

/** Variants whose state is exempt from 1.4.3 (inactive components). */
const EXEMPT_STATE = /(^|:)disabled$|(^|:)group-disabled/;

function usedPairs(): UsedPair[] {
  const pairs: UsedPair[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const literal of colourLiterals(source)) {
      const utilities = utilitiesOf(literal);
      const base = {
        bg: utilities.find((u) => u.kind === 'bg' && u.state === ''),
        fg: utilities.find((u) => u.kind === 'text' && u.state === ''),
      };
      const states = new Set(utilities.map((u) => u.state));
      for (const state of states) {
        if (EXEMPT_STATE.test(state)) continue;
        const bg = utilities.find((u) => u.kind === 'bg' && u.state === state) ?? base.bg;
        const fg = utilities.find((u) => u.kind === 'text' && u.state === state) ?? base.fg;
        if (bg === undefined || fg === undefined) continue;
        pairs.push({
          file,
          state: state === '' ? 'rest' : state,
          fg: fg.token,
          bg: bg.token,
          fgAlpha: fg.alpha,
          bgAlpha: bg.alpha,
          literal,
        });
      }
    }
  }
  return pairs;
}

/** A translucent background is drawn over whatever surface the page puts it on. */
function effective(theme: Theme, pair: UsedPair): Array<{ fg: Rgba; bg: Rgba; over: string }> {
  const unders = pair.bgAlpha < 1 || pair.fgAlpha < 1 ? CHART_SURFACES : ([null] as const);
  return unders.map((under) => {
    const base = under === null ? null : colorOf(theme, under);
    const bgTop = { ...colorOf(theme, pair.bg), a: pair.bgAlpha };
    const bg = base === null ? bgTop : composite(bgTop, base);
    const fgTop = { ...colorOf(theme, pair.fg), a: pair.fgAlpha };
    return { fg: composite(fgTop, bg), bg, over: under ?? 'opaque' };
  });
}

describe('pairs the components use', () => {
  const pairs = usedPairs();

  it('finds the pairs it is meant to (the scan is not blind)', () => {
    const find = (file: string, fg: string, bg: string): boolean =>
      pairs.some((p) => p.file.endsWith(file) && p.fg === fg && p.bg === bg);
    expect(find('components/ui/button.tsx', '--accent-contrast', '--accent')).toBe(true);
    expect(find('components/ui/button.tsx', '--accent-contrast', '--accent-hover')).toBe(true);
    expect(find('components/ui/badge.tsx', '--accent-text', '--accent-wash')).toBe(true);
    expect(pairs.length).toBeGreaterThan(20);
  });

  for (const theme of THEMES) {
    it(`every text/background pair a component declares clears 4.5:1 in the ${theme} theme`, () => {
      const failing = pairs.flatMap((pair) =>
        effective(theme, pair).flatMap(({ fg, bg, over }) => {
          const r = ratio(fg, bg);
          return r >= 4.5
            ? []
            : [
                `${pair.file} [${pair.state}] ${pair.fg} on ${pair.bg}${over === 'opaque' ? '' : ` over ${over}`}: ${r.toFixed(2)}:1`,
              ];
        }),
      );
      expect([...new Set(failing)]).toEqual([]);
    });
  }
});

describe('WP 9.8 exit test', () => {
  it('every declared text pair clears 4.5:1 and every UI pair 3:1 in both themes, and the two dark palettes are identical', () => {
    const failures: string[] = [];
    const differing = Object.keys({ ...darkDeclared, ...darkMediaDeclared }).filter(
      (token) => darkDeclared[token] !== darkMediaDeclared[token],
    );
    failures.push(...differing.map((token) => `dark palettes differ on ${token}`));
    for (const theme of THEMES) {
      for (const [fg, bg] of TEXT_PAIRS) {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        if (r < 4.5) failures.push(`${theme} text ${fg} on ${bg}: ${r.toFixed(2)}:1`);
      }
      for (const [fg, bg] of UI_PAIRS) {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        if (r < 3) failures.push(`${theme} UI ${fg} on ${bg}: ${r.toFixed(2)}:1`);
      }
      for (const pair of usedPairs()) {
        for (const { fg, bg } of effective(theme, pair)) {
          const r = ratio(fg, bg);
          if (r < 4.5)
            failures.push(
              `${theme} ${pair.file} [${pair.state}] ${pair.fg} on ${pair.bg}: ${r.toFixed(2)}:1`,
            );
        }
      }
    }
    expect([...new Set(failures)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. No colour outside the tokens
// ---------------------------------------------------------------------------

/**
 * The only colours that may be written in a component rather than read from a
 * token, each with the reason it is safe. A new entry needs a reason a
 * reviewer would accept; a contrast failure is never one.
 */
const OFF_TOKEN_ALLOWED: ReadonlyArray<readonly [file: string, literal: string, reason: string]> = [
  [
    'components/ui/dialog.tsx',
    'rgba(11,11,11,0.5)',
    'the modal scrim: no text is drawn on it and the dialog panel above it carries its own surface',
  ],
  [
    'features/auth/IdleLockOverlay.tsx',
    'rgba(11,11,11,0.7)',
    'the lock scrim: it hides the app on purpose; the panel above it carries its own surface',
  ],
  [
    'components/ui/switch.tsx',
    'bg-white',
    "the switch thumb: always on the accent or inset track, which has a bordered boundary (UI pair '--border-strong')",
  ],
  ['features/plan/palette.ts', '#2563eb', 'ACCENT_HEX — asserted equal to --accent above'],
  ['features/plan/palette.ts', '#3987e5', 'ACCENT_HEX — asserted equal to --accent above'],
  ['features/plan/palette.ts', '#ffffff', 'SURFACE_HEX — asserted equal to --bg-surface above'],
  ['features/plan/palette.ts', '#16181a', 'SURFACE_HEX — asserted equal to --bg-surface above'],
];

const OFF_TOKEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a hex literal', /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g],
  ['an rgb()/hsl()/oklch() literal', /\b(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g],
  [
    'a white/black utility',
    /(?<![\w-])(?:[\w[\]=&>.-]+:)?(?:bg|text|border|fill|stroke)-(?:white|black)\b/g,
  ],
  [
    'a Tailwind palette colour',
    /(?<![\w-])(?:bg|text|border|fill|stroke|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
  ],
];

describe('no colour outside the tokens', () => {
  it('no component writes a colour that this file cannot see', () => {
    const offences: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      // Comments may quote a colour; only code may not.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s\/\/ .*$/gm, '');
      for (const [what, pattern] of OFF_TOKEN_PATTERNS) {
        for (const match of code.matchAll(pattern)) {
          const text = match[0];
          const allowed = OFF_TOKEN_ALLOWED.some(
            ([allowedFile, literal]) => file.endsWith(allowedFile) && text === literal,
          );
          if (!allowed) offences.push(`${file}: ${what} "${text}"`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('every allowed off-token colour is still where it says it is (no stale exemptions)', () => {
    for (const [file, literal] of OFF_TOKEN_ALLOWED) {
      const found = Object.entries(sources).some(
        ([path, source]) => path.endsWith(file) && source.includes(literal),
      );
      expect(found, `${file} no longer contains ${literal}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The forward cash-flow chart's colour roles (WP 10.7)
// ---------------------------------------------------------------------------

/**
 * `ForecastBandChart.tsx` draws only with `forecast-chart-tokens.ts`'s roles (`chartVar(role)`), so measuring
 * the roles measures the chart. Its marks (the running total, ▼ money out, ▲ money in, the $0 baseline) are
 * 1.4.11 non-text marks, 3:1 on every chart surface; its tick labels are text, 4.5:1. The dataviz skill's
 * `validate_palette.js` run on the same three mark colours is recorded in the tokens file and in
 * docs/evidence/phase-10/wp10.7-recurring-forecast-view.md; this is the part of it that a token edit must keep
 * passing.
 */
describe('the forward cash-flow chart (WP 10.7)', () => {
  it('draws only with roles this file can measure', () => {
    const chart = Object.entries(sources).find(([path]) =>
      path.endsWith('features/recurring/ForecastBandChart.tsx'),
    )?.[1];
    expect(chart).toBeDefined();
    // Every colour in the chart is `chartVar(...)` or one of the shared readout-surface tokens.
    const raw = [...(chart ?? '').matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const readout = [
      '--bg-surface-raised',
      '--text-primary',
      '--shadow-elev-2',
      '--border-hairline',
    ];
    expect(raw.filter((token) => !readout.includes(token as string))).toEqual([]);
    expect((chart ?? '').match(/chartVar\('/g)?.length ?? 0).toBeGreaterThan(8);
  });

  for (const theme of THEMES) {
    it(`every mark role clears 3:1 and every text role 4.5:1 on each chart surface in the ${theme} theme`, () => {
      const failing: string[] = [];
      for (const bg of CHART_SURFACES) {
        for (const role of FORECAST_MARK_ROLES) {
          const token = FORECAST_CHART_TOKENS[role];
          const r = ratio(colorOf(theme, token), colorOf(theme, bg));
          if (r < 3) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
        for (const role of FORECAST_TEXT_ROLES) {
          const token = FORECAST_CHART_TOKENS[role];
          const r = ratio(colorOf(theme, token), colorOf(theme, bg));
          if (r < 4.5) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
      }
      expect(failing).toEqual([]);
    });
  }
});
