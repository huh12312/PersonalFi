// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { ACCENT_HEX, SURFACE_HEX } from '../features/plan/palette.ts';
import {
  PACE_CHART_TOKENS,
  PACE_LAST_MONTH_OPACITY,
  PACE_MARK_ROLES,
  PACE_TEXT_ROLES,
} from '../features/dashboard/widgets/pace-chart-tokens.ts';
import {
  FORECAST_CHART_TOKENS,
  FORECAST_MARK_ROLES,
  FORECAST_TEXT_ROLES,
} from '../features/recurring/forecast-chart-tokens.ts';
import {
  CASH_FLOW_CHART_TOKENS,
  CASH_FLOW_MARK_ROLES,
  CASH_FLOW_TEXT_ROLES,
} from '../features/cash-flow/charts/cash-flow-chart-tokens.ts';
import { HEALTH_CHART_TOKENS } from '../features/health/health-chart-tokens.ts';
import { CHART_HUES } from '@core/kernel';

import themeCss from './theme.css?raw';
import tokensCss from './tokens.css?raw';

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

// The runtime values live in the generated tokens.css (WP 10.8); theme.css keeps the Tailwind `@theme` map.
const css = stripComments(`${tokensCss}\n${themeCss}`);
const rules = parseRules(css).map((rule) => ({
  ...rule,
  selector: rule.selector.replace(/\s+/g, ' '),
}));

function merged(predicate: (rule: Rule) => boolean): Palette {
  return Object.assign({}, ...rules.filter(predicate).map((rule) => declarations(rule.body)));
}

const lightDeclared = merged(
  (r) => r.selector === ":root, [data-theme='light']" && r.media === null,
);
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
      // WP 10.11: the status quartets' inks on the legacy surfaces the old `--status-*` were tested on.
      '--status-success-text',
      '--status-danger-text',
      '--status-warning-text',
      '--status-info-text',
    ] as const
  ).flatMap((fg) => [...SURFACES, '--accent-wash'].map((bg) => [fg, bg] as const)),
  // Chart tick labels are SVG text on a chart surface.
  ...CHART_SURFACES.map((bg) => ['--chart-axis-ink', bg] as const),
  // Filled controls and their text, at rest and hovered.
  ['--accent-contrast', '--accent'],
  ['--accent-contrast', '--accent-hover'],
  ['--on-danger', '--danger'],
  ['--on-danger', '--danger-hover'],
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
  // WP 10.11: a status mark (a meter fill) on its own ramp's wash, which is the track it sits in.
  ...(['success', 'danger', 'warning', 'info'] as const).map(
    (s) => [`--status-${s}-bold`, `--status-${s}-bg`] as const,
  ),
  // Categorical chart series (fixed order, drawn on a chart surface).
  ...Array.from({ length: 8 }, (_, i) => `--series-${String(i + 1)}`).flatMap((fg) =>
    CHART_SURFACES.map((bg) => [fg, bg] as const),
  ),
];

// ---------------------------------------------------------------------------
// 2b. Every WP 10.8 role pair (tokens.css)
// ---------------------------------------------------------------------------

/** Surfaces text and controls sit on, by role name. */
const ROLE_SURFACES = ['--bg-page', '--bg-primary', '--bg-secondary', '--bg-overlay'] as const;
/** Surfaces a chart is drawn on, by role name. */
const ROLE_CHART_SURFACES = ['--bg-page', '--bg-primary', '--bg-overlay'] as const;
const STATUSES = ['success', 'danger', 'warning', 'info'] as const;

/**
 * [foreground, background, floor]. Text 4.5:1, marks and control boundaries 3:1. Exempt, by design and
 * named here so the exemption is a decision: `--text-disabled` (an inactive control, 1.4.3's own exception),
 * `--border-secondary`, `--border-divider`, `--status-*-border`, `--chart-event-border-*` (decorative edges
 * beside a surface change or a label), `--chart-gridline` and `--chart-negative-area` (recessive chart chrome
 * whose values are carried by the axis, the readout and the table). Washes (`--status-*-bg`,
 * `--chart-event-bg-*`) are backgrounds: their inks are measured on them. `--bg-tertiary` and `--bg-inset` are
 * fills (tracks, pressed states, skeleton bases), not text surfaces — `docs/design/tokens.md` says so, and the
 * component scan above would catch a `text-*` on them.
 */
const ROLE_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ...(['--text-primary', '--text-secondary', '--text-tertiary', '--text-muted'] as const).flatMap(
    (fg) => ROLE_SURFACES.map((bg) => [fg, bg, 4.5] as const),
  ),
  ['--text-on-brand', '--accent', 4.5],
  ['--text-on-brand', '--accent-hover', 4.5],
  ...ROLE_SURFACES.map((bg) => ['--border-primary', bg, 3] as const),
  ...STATUSES.flatMap((s) => [
    [`--status-${s}-text`, `--status-${s}-bg`, 4.5] as const,
    ...ROLE_SURFACES.map((bg) => [`--status-${s}-text`, bg, 4.5] as const),
    ...ROLE_CHART_SURFACES.map((bg) => [`--status-${s}-bold`, bg, 3] as const),
  ]),
  ...ROLE_CHART_SURFACES.flatMap((bg) => [
    ['--chart-label', bg, 4.5] as const,
    ['--chart-axis', bg, 3] as const,
    ['--chart-line', bg, 3] as const,
    ['--chart-income', bg, 3] as const,
    ['--chart-expenses', bg, 3] as const,
    ['--chart-fill-neutral', bg, 3] as const,
  ]),
  ...CHART_HUES.flatMap((hue) => [
    ...ROLE_CHART_SURFACES.map((bg) => [`--chart-fill-${hue}`, bg, 3] as const),
    ...ROLE_CHART_SURFACES.map((bg) => [`--chart-event-dot-${hue}`, bg, 3] as const),
    [`--chart-event-fg-${hue}`, `--chart-event-bg-${hue}`, 4.5] as const,
    ...ROLE_CHART_SURFACES.map((bg) => [`--chart-event-fg-${hue}`, bg, 4.5] as const),
  ]),
];

describe('WP 10.8 role pairs', () => {
  it('covers every role a foreground can be (the list is not stale)', () => {
    const foregrounds = new Set(ROLE_PAIRS.map(([fg]) => fg));
    const exempt =
      /^--(text-disabled|border-(secondary|divider)|status-\w+-(border|bg)|chart-event-(border|bg)-\w+|chart-gridline|chart-negative-area)$/;
    // Legacy names are measured through the pairs above that name them, and through their role.
    const legacy = new Set(['--border-hairline', '--border-strong', '--chart-axis-ink']);
    const roleNames = Object.keys(palettes.light).filter(
      (name) =>
        /^--(text|border|status-(success|danger|warning|info)|chart)-/.test(name) &&
        !legacy.has(name),
    );
    const uncovered = roleNames.filter((name) => !foregrounds.has(name) && !exempt.test(name));
    expect(uncovered).toEqual([]);
  });

  for (const theme of THEMES) {
    it(`every role pair clears its floor in the ${theme} theme`, () => {
      const failing = ROLE_PAIRS.flatMap(([fg, bg, floor]) => {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        return r >= floor ? [] : [`${fg} on ${bg}: ${r.toFixed(2)}:1 (< ${String(floor)})`];
      });
      expect(failing).toEqual([]);
    });
  }
});

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
      // The token sources and the generated TS object ARE the tokens (WP 10.8); tokens.test.ts holds them.
      if (file === './tokens.ts' || file.startsWith('./tokens/')) continue;
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
    const readout = ['--bg-overlay', '--text-primary', '--shadow-elev-2', '--border-divider'];
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

/**
 * `SpendingPaceChart.tsx` (WP 10.9) draws only with `pace-chart-tokens.ts`'s roles (`paceVar(role)`), so measuring
 * the roles measures the chart: its four marks (this month, last month — measured **blended** at the opacity it is
 * drawn at — the average hairline and today's rule) at 3:1 on every chart surface, its tick labels at 4.5:1.
 */
describe('the spending pace chart (WP 10.9)', () => {
  it('draws only with roles this file can measure', () => {
    const chart = Object.entries(sources).find(([path]) =>
      path.endsWith('features/dashboard/widgets/SpendingPaceChart.tsx'),
    )?.[1];
    expect(chart).toBeDefined();
    const raw = [...(chart ?? '').matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const readout = ['--bg-overlay', '--text-primary', '--shadow-elev-2', '--border-divider'];
    expect(raw.filter((token) => !readout.includes(token as string))).toEqual([]);
    expect((chart ?? '').match(/paceVar\('/g)?.length ?? 0).toBeGreaterThan(8);
  });

  for (const theme of THEMES) {
    it(`every mark role clears 3:1 and every text role 4.5:1 on each chart surface in the ${theme} theme`, () => {
      const failing: string[] = [];
      for (const bg of CHART_SURFACES) {
        const surface = colorOf(theme, bg);
        for (const role of PACE_MARK_ROLES) {
          const token = PACE_CHART_TOKENS[role];
          const drawn =
            role === 'lastMonth'
              ? composite({ ...colorOf(theme, token), a: PACE_LAST_MONTH_OPACITY }, surface)
              : colorOf(theme, token);
          const r = ratio(drawn, surface);
          if (r < 3) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
        for (const role of PACE_TEXT_ROLES) {
          const token = PACE_CHART_TOKENS[role];
          const r = ratio(colorOf(theme, token), surface);
          if (r < 4.5) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
      }
      expect(failing).toEqual([]);
    });
  }
});

/**
 * `CashFlowBarsChart.tsx` (WP 10.10) draws only with `cash-flow-chart-tokens.ts`'s roles (`cashFlowVar(role)`):
 * income and expense columns, the net line and the zero line at 3:1 on every chart surface **and on the selected
 * period's band** (a column of the selected period sits on it), the tick text at 4.5:1 on both.
 */
describe('the cash flow bars chart (WP 10.10)', () => {
  it('draws only with roles this file can measure', () => {
    const chart = Object.entries(sources).find(([path]) =>
      path.endsWith('features/cash-flow/charts/CashFlowBarsChart.tsx'),
    )?.[1];
    expect(chart).toBeDefined();
    const raw = [...(chart ?? '').matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const readout = [
      '--bg-overlay',
      '--text-primary',
      '--shadow-elev-2',
      '--border-divider',
      '--focus-ring',
    ];
    expect(raw.filter((token) => !readout.includes(token as string))).toEqual([]);
    expect((chart ?? '').match(/cashFlowVar\(/g)?.length ?? 0).toBeGreaterThan(10);
  });

  for (const theme of THEMES) {
    it(`every mark role clears 3:1 and every text role 4.5:1 on each chart surface and the selected band in the ${theme} theme`, () => {
      const failing: string[] = [];
      for (const bg of [...CHART_SURFACES, CASH_FLOW_CHART_TOKENS.selectedBand]) {
        const surface = colorOf(theme, bg);
        for (const role of CASH_FLOW_MARK_ROLES) {
          const token = CASH_FLOW_CHART_TOKENS[role];
          const r = ratio(colorOf(theme, token), surface);
          if (r < 3) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
        for (const role of CASH_FLOW_TEXT_ROLES) {
          const token = CASH_FLOW_CHART_TOKENS[role];
          const r = ratio(colorOf(theme, token), surface);
          if (r < 4.5) failing.push(`${role} (${token}) on ${bg}: ${r.toFixed(2)}:1`);
        }
      }
      expect(failing).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5d. The Health screen's gauge, sparkline and zone chart (WP 10.12)
// ---------------------------------------------------------------------------

/**
 * `ScoreGauge.tsx`, `Sparkline.tsx` and `HealthZoneChart.tsx` draw only with `health-chart-tokens.ts`'s roles
 * (`healthVar(role)`) and the status quartets (`statusVar(status, member)`), so measuring those measures the three:
 * the series line at 3:1 and the tick text at 4.5:1 on every chart surface, the "Now" label's ink at 4.5:1 on its
 * surface plate, each zone's band word (the quartet's `-text`) at 4.5:1 on its own wash, and the gauge's fill (the
 * quartet's `-bold`) at 3:1 on the card it sits on.
 */
describe('the Health charts (WP 10.12)', () => {
  const readout = ['--bg-overlay', '--text-primary', '--shadow-elev-2', '--border-divider'];
  for (const file of ['ScoreGauge.tsx', 'Sparkline.tsx', 'HealthZoneChart.tsx']) {
    it(`${file} draws only with roles this file can measure`, () => {
      const chart = Object.entries(sources).find(([path]) =>
        path.endsWith(`features/health/${file}`),
      )?.[1];
      expect(chart).toBeDefined();
      const raw = [...(chart ?? '').matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
      expect(raw.filter((token) => !readout.includes(token as string))).toEqual([]);
      expect((chart ?? '').match(/(healthVar|statusVar)\(/g)?.length ?? 0).toBeGreaterThan(2);
    });
  }

  for (const theme of THEMES) {
    it(`every Health mark clears 3:1 and every text 4.5:1 in the ${theme} theme`, () => {
      const failing: string[] = [];
      const check = (fg: string, bg: string, floor: number) => {
        const r = ratio(colorOf(theme, fg), colorOf(theme, bg));
        if (r < floor) failing.push(`${fg} on ${bg}: ${r.toFixed(2)}:1 (< ${String(floor)})`);
      };
      for (const bg of [...CHART_SURFACES, '--bg-primary']) {
        check(HEALTH_CHART_TOKENS.line, bg, 3);
        check(HEALTH_CHART_TOKENS.axisInk, bg, 4.5);
      }
      check(HEALTH_CHART_TOKENS.nowInk, HEALTH_CHART_TOKENS.ring, 4.5);
      for (const status of STATUSES) {
        check(`--status-${status}-text`, `--status-${status}-bg`, 4.5);
        check(`--status-${status}-bold`, '--bg-primary', 3);
      }
      expect(failing).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. The status roles (WP 10.11)
// ---------------------------------------------------------------------------

/**
 * WP 10.11 moved `Badge` and every legacy status consumer onto the `--status-{success,danger,warning,info}-*`
 * quartets. The legacy `--status-good|warning|serious|critical` and `--on-status-warning` stay defined in the
 * token sources (history, and `tokens.test.ts` names them) but nothing else may read them: this scan fails,
 * naming file:line, on any consumer. A bare `status-warning` is the legacy token; `status-warning-bg|border|text|bold`
 * is a quartet role and is not matched.
 */
describe('WP 10.11 status roles', () => {
  const allSources = import.meta.glob(
    [
      '../**/*.ts',
      '../**/*.tsx',
      '../**/*.css',
      '!../**/*.test.ts',
      '!../**/*.test.tsx',
      '!../routeTree.gen.ts',
      '!../styles/tokens.css',
      '!../styles/theme.css',
      '!../styles/tokens.ts',
      '!../styles/tokens/**',
    ],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>;

  const LEGACY =
    /status-(?:good|serious|critical)|on-status-warning|status-warning(?![\w-])|var\(--status-(?:good|warning|serious|critical)\)/g;

  it('scans the source tree (the guard is not blind)', () => {
    const files = Object.keys(allSources);
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('components/ui/badge.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    expect(files.some((f) => f.includes('styles/theme.css'))).toBe(false);
  });

  it('nothing outside the token sources reads a legacy status token', () => {
    const offences: string[] = [];
    for (const [file, source] of Object.entries(allSources)) {
      source.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(LEGACY)) {
          offences.push(`${file.replace('../', 'src/')}:${String(index + 1)} ${match[0]}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it('the guard pattern matches the legacy names and not the quartet roles', () => {
    const hits = (text: string): number => [...text.matchAll(LEGACY)].length;
    for (const legacy of [
      'text-status-good',
      'bg-status-serious',
      'border-status-critical/40',
      'text-on-status-warning',
      'bg-status-warning/10',
      'stroke-status-warning',
      'var(--status-warning)',
    ]) {
      expect(hits(legacy), legacy).toBeGreaterThan(0);
    }
    for (const role of [
      'text-status-warning-text',
      'bg-status-warning-bg',
      'border-status-warning-border',
      'stroke-status-warning-bold',
      'text-status-success-text',
      'var(--status-danger-bold)',
    ]) {
      expect(hits(role), role).toBe(0);
    }
  });

  it('Badge reads the quartets for every status variant', () => {
    const badge = Object.entries(sources).find(([f]) => f.endsWith('components/ui/badge.tsx'))?.[1];
    for (const s of ['success', 'danger', 'warning', 'info']) {
      expect(badge).toContain(`bg-status-${s}-bg`);
      expect(badge).toContain(`text-status-${s}-text`);
      expect(badge).toContain(`border-status-${s}-border`);
    }
  });
});
