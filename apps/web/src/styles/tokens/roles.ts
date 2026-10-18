// SPDX-License-Identifier: MIT
/**
 * The semantic colour roles — the one source `scripts/gen-tokens.ts` turns into `src/styles/tokens.css` and
 * `src/styles/tokens.ts` (WP 10.8). Read `docs/design/tokens.md` before adding one.
 *
 * A role's value per theme is either
 *   - a **scale step** (`'sand-2'`, `'teal-9'`): a Radix Colors step from `radix-colors.ts`, the normal case; or
 *   - an **off-scale house value** (`'#0b0b0b'`, an `rgba()`, a shadow): kept because moving it to the nearest
 *     step would repaint a screen (this package is a re-plumbing, not a repaint) or because it is the brand. Every
 *     off-scale value carries `why`, and `tokens.test.ts` refuses one without it.
 *
 * Steps were chosen by measurement, not by eye: neutrals snap to the nearest `sand` step when that step is within
 * ΔE 2 (OKLab ×100, imperceptible) of the value it replaces; anything further stays a house value. Every
 * foreground/background pair is held to WCAG by `contrast.test.ts`, and the thirteen chart fills to the dataviz
 * skill's checks by `tokens.test.ts`. A failing pair is fixed by moving the step, never by a hex off the scales.
 */
import type { ChartHue } from '@core/kernel';

import { CHART_FILL_ORDER, FILL_STEPS, EVENT_STEPS } from './fills.ts';

export interface RoleDef {
  readonly light: string;
  readonly dark: string;
  /** Required when either value is off-scale. */
  readonly why?: string;
}

export interface RoleGroup {
  readonly title: string;
  readonly roles: Readonly<Record<`--${string}`, RoleDef>>;
}

const same = (step: string): RoleDef => ({ light: step, dark: step });
const seq = (hex: string): RoleDef => ({
  light: hex,
  dark: hex,
  why: 'the sequential blue ramp (Monte Carlo bands, heatmaps), built on the brand accent',
});

const SURFACES: RoleGroup = {
  title: 'Surfaces',
  roles: {
    '--bg-page': { light: 'sand-2', dark: 'sand-1' },
    '--bg-primary': { light: 'sand-1', dark: 'sand-2' },
    '--bg-secondary': same('sand-3'),
    '--bg-tertiary': same('sand-4'),
    '--bg-inset': {
      light: 'sand-4',
      dark: '#0a0c0d',
      why: 'dark inset (switch and progress tracks) sits below the page; the darkest sand step is ΔE 2.5 away',
    },
    '--bg-overlay': { light: 'sand-1', dark: 'sand-3' },
  },
};

const TEXT: RoleGroup = {
  title: 'Text',
  roles: {
    '--text-primary': {
      light: '#0b0b0b',
      dark: '#ffffff',
      why: 'body ink; sand-12 is ΔE 9.4 (light) / 5.2 (dark) lighter, a visible repaint of every screen',
    },
    '--text-secondary': {
      light: '#52514e',
      dark: '#c3c2b7',
      why: 'labels; sand-11 is ΔE 6.3 / 4.6 away',
    },
    '--text-tertiary': { light: 'sand-11', dark: 'sand-11' },
    '--text-muted': {
      light: '#6b6a64',
      dark: '#9a9a92',
      why: 'captions; sand-11 is ΔE 2.5 (light) and no sand step is within 6 (dark)',
    },
    '--text-disabled': same('sand-9'),
    '--text-on-brand': {
      light: '#ffffff',
      dark: '#0b0b0b',
      why: 'text on the brand accent fill (was --accent-contrast); the accent is not a Radix value',
    },
  },
};

const BORDERS: RoleGroup = {
  title: 'Borders',
  roles: {
    '--border-primary': {
      light: 'sand-10',
      dark: '#70767c',
      why: 'dark control boundary; sand-10 is ΔE 2.9 away',
    },
    '--border-secondary': same('sand-6'),
    '--border-divider': {
      light: 'rgba(11, 11, 11, 0.1)',
      dark: 'rgba(255, 255, 255, 0.1)',
      why: 'a translucent hairline (was --border-hairline): it must read the same on every surface',
    },
  },
};

interface QuartetSteps {
  readonly bg: number;
  readonly border: number;
  readonly text: number;
  readonly bold: number;
}

/** A status quartet: a wash, its border, its text, and a bold fill/mark — light and dark steps of one hue. */
function quartet(
  name: string,
  hue: string,
  light: QuartetSteps,
  dark: QuartetSteps,
): Record<`--${string}`, RoleDef> {
  const parts = ['bg', 'border', 'text', 'bold'] as const;
  return Object.fromEntries(
    parts.map((part) => [
      `--status-${name}-${part}`,
      { light: `${hue}-${String(light[part])}`, dark: `${hue}-${String(dark[part])}` },
    ]),
  ) as Record<`--${string}`, RoleDef>;
}

const STATUS: RoleGroup = {
  title: 'Status quartets',
  roles: {
    // Light text is step 12 where step 11 is under 4.5:1 on its wash or a surface (green, yellow, cyan); light
    // bold is the first step that is a 3:1 mark on the page (yellow has none below 11).
    ...quartet(
      'success',
      'green',
      { bg: 3, border: 7, text: 12, bold: 10 },
      { bg: 3, border: 7, text: 11, bold: 9 },
    ),
    ...quartet(
      'danger',
      'red',
      { bg: 3, border: 7, text: 11, bold: 10 },
      { bg: 3, border: 7, text: 11, bold: 9 },
    ),
    ...quartet(
      'warning',
      'yellow',
      { bg: 3, border: 7, text: 12, bold: 11 },
      { bg: 3, border: 7, text: 11, bold: 9 },
    ),
    ...quartet(
      'info',
      'cyan',
      { bg: 3, border: 7, text: 12, bold: 10 },
      { bg: 3, border: 7, text: 11, bold: 9 },
    ),
  },
};

const CHART: RoleGroup = {
  title: 'Chart roles',
  roles: {
    '--chart-income': {
      light: '#0f8a68',
      dark: '#1ba277',
      why: 'the house CVD-safe money-in teal (= --money-pos); never green/red (05 §2.2)',
    },
    '--chart-expenses': {
      light: '#d2452f',
      dark: '#e8604a',
      why: 'the house CVD-safe money-out vermilion (= --money-neg)',
    },
    '--chart-negative-area': { light: 'red-3', dark: 'red-3' },
    '--chart-line': {
      light: '#2563eb',
      dark: '#3987e5',
      why: 'a single series is the brand accent (categorical slot 1); the accent is not a Radix value',
    },
    '--chart-axis': {
      light: '#6b6a64',
      dark: '#9a9a92',
      why: 'the axis line and the labelled $0 baseline: the old --chart-axis-ink, unchanged',
    },
    '--chart-label': {
      light: '#6b6a64',
      dark: '#9a9a92',
      why: 'tick and axis labels (was --chart-axis-ink); text, so it keeps the muted-ink value',
    },
    '--chart-gridline': { light: 'sand-5', dark: 'sand-4' },
    // Uncategorised / "Other" / the `other` account type: a neutral mark that is still 3:1 on every chart surface.
    '--chart-fill-neutral': same('sand-10'),
  },
};

function hueRoles(): RoleGroup {
  const roles: Record<`--${string}`, RoleDef> = {};
  for (const hue of CHART_FILL_ORDER) {
    const fill = FILL_STEPS[hue];
    roles[`--chart-fill-${hue}`] = {
      light: `${hue}-${String(fill.light)}`,
      dark: `${hue}-${String(fill.dark)}`,
    };
  }
  return { title: 'Chart fills (13 hues, in the validated order)', roles };
}

function eventRoles(): RoleGroup {
  const roles: Record<`--${string}`, RoleDef> = {};
  for (const hue of CHART_FILL_ORDER) {
    const steps = EVENT_STEPS[hue];
    const fill = FILL_STEPS[hue];
    roles[`--chart-event-bg-${hue}`] = {
      light: `${hue}-${String(steps.bg)}`,
      dark: `${hue}-${String(steps.bg)}`,
    };
    roles[`--chart-event-border-${hue}`] = { light: `${hue}-7`, dark: `${hue}-7` };
    roles[`--chart-event-dot-${hue}`] = {
      light: `${hue}-${String(fill.light)}`,
      dark: `${hue}-${String(fill.dark)}`,
    };
    roles[`--chart-event-fg-${hue}`] = {
      light: `${hue}-${String(steps.fgLight)}`,
      dark: `${hue}-${String(steps.fgDark)}`,
    };
  }
  return { title: 'Chart events (four roles per hue)', roles };
}

/**
 * House values that predate the roles and have no role of their own yet: the brand accent, money, destructive
 * actions, the legacy status tokens, the sequential ramp and elevation. Unchanged by this package, and
 * documented here so the generator is the one place a colour is declared.
 */
const HOUSE: RoleGroup = {
  title: 'House values (brand, money, destructive, legacy status, ramp, elevation)',
  roles: {
    '--focus-ring': {
      light: '#1f5fb0',
      dark: '#6da7ec',
      why: 'the focus indicator, tuned with the accent',
    },
    '--accent': { light: '#2563eb', dark: '#3987e5', why: 'the brand accent; not a Radix value' },
    '--accent-text': { light: '#1f5fb0', dark: '#6da7ec', why: 'brand accent as text (CF-8)' },
    '--accent-wash': { light: '#eaf2fd', dark: '#132537', why: 'brand accent wash' },
    '--accent-hover': {
      light: '#1d4ed8',
      dark: '#5a9cea',
      why: 'brand accent hover, a step, never an opacity blend',
    },
    '--money-pos': { light: '#0f8a68', dark: '#1ba277', why: 'CVD-safe money teal (05 §2.2)' },
    '--money-pos-text': { light: '#0a6f54', dark: '#3ec49a', why: 'money teal as text' },
    '--money-neg': { light: '#d2452f', dark: '#e8604a', why: 'CVD-safe money vermilion (05 §2.2)' },
    '--money-neg-text': { light: '#b8391f', dark: '#ff8a6e', why: 'money vermilion as text' },
    '--money-neutral': { light: '#6b6a64', dark: '#9a9a92', why: 'zero; the muted ink' },
    '--danger': { light: '#c23a25', dark: '#e8604a', why: 'destructive fill (CF-9)' },
    '--on-danger': { light: '#ffffff', dark: '#0b0b0b', why: 'text on the destructive fill' },
    '--danger-hover': { light: '#a8321d', dark: '#ef7a66', why: 'destructive hover, a step' },
    '--on-status-warning': {
      light: '#ffffff',
      dark: '#0b0b0b',
      why: 'text on the legacy warning fill',
    },
    '--status-good': {
      light: '#0c7a0c',
      dark: '#0ca30c',
      why: 'legacy Badge status; nearest step ΔE 7.5 — moving Badge to --status-success-* is V4 (a repaint)',
    },
    '--status-warning': {
      light: '#8e650e',
      dark: '#fab219',
      why: 'legacy Badge status (see --status-good)',
    },
    '--status-serious': {
      light: '#a35a3e',
      dark: '#ec835a',
      why: 'legacy Badge status (see --status-good)',
    },
    '--status-critical': {
      light: 'red-11',
      dark: '#e06c6c',
      why: 'legacy Badge status. Light moved onto red-11 (ΔE 1.7 from #c83939): on the new sand-3 secondary surface #c83939 measured 4.497:1',
    },
    '--seq-1': seq('#cde2fb'),
    '--seq-2': seq('#b7d3f6'),
    '--seq-3': seq('#9ec5f4'),
    '--seq-4': seq('#86b6ef'),
    '--seq-5': seq('#6da7ec'),
    '--seq-6': seq('#5598e7'),
    '--seq-7': seq('#3987e5'),
    '--seq-8': seq('#2a78d6'),
    '--seq-9': seq('#256abf'),
    '--seq-10': seq('#1c5cab'),
    '--seq-11': seq('#184f95'),
    '--seq-12': seq('#104281'),
    '--seq-13': seq('#0d366b'),
    '--diverging-mid': { light: 'sand-3', dark: 'sand-6' },
    '--shadow-elev-1': {
      light: '0 1px 2px rgba(11, 11, 11, 0.04)',
      dark: 'none',
      why: 'elevation, not a colour',
    },
    '--shadow-elev-2': {
      light: '0 4px 12px rgba(11, 11, 11, 0.06)',
      dark: 'none',
      why: 'elevation, not a colour',
    },
    '--shadow-elev-3': {
      light: '0 16px 40px rgba(11, 11, 11, 0.12)',
      dark: '0 16px 40px rgba(0, 0, 0, 0.5)',
      why: 'elevation, not a colour',
    },
  },
};

export const ROLE_GROUPS: readonly RoleGroup[] = [
  SURFACES,
  TEXT,
  BORDERS,
  STATUS,
  CHART,
  hueRoles(),
  eventRoles(),
  HOUSE,
];

/**
 * Legacy token → the role it now reads. Every name a component or a Tailwind utility (`bg-bg-surface`,
 * `text-text-muted`, `bg-series-3`) used before WP 10.8 is still declared, with its role's value, so no class
 * changes meaning by being renamed.
 */
export const ALIASES: Readonly<Record<`--${string}`, `--${string}`>> = {
  '--bg-surface': '--bg-primary',
  '--bg-surface-raised': '--bg-overlay',
  '--bg-subtle': '--bg-secondary',
  '--border-hairline': '--border-divider',
  '--border-strong': '--border-primary',
  '--accent-contrast': '--text-on-brand',
  '--chart-axis-ink': '--chart-label',
  ...(Object.fromEntries(
    CHART_FILL_ORDER.slice(0, 8).map((hue: ChartHue, i) => [
      `--series-${String(i + 1)}`,
      `--chart-fill-${hue}`,
    ]),
  ) as Record<`--${string}`, `--${string}`>),
};
