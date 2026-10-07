// SPDX-License-Identifier: MIT
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

/**
 * The one place axe runs in this suite (WP 9.8). Every spec reaches axe
 * through `expectNoAxeViolations` / `scanBothThemes` below; a structural test
 * in `a11y-sweep.spec.ts` fails if any other file calls `axe.run` or names an
 * exclusion, so this file's three decisions cannot be quietly reversed from a
 * spec:
 *
 *   1. **The rule set is the WCAG 2.2 AA tag set** — `wcag2a`, `wcag2aa`,
 *      `wcag21a`, `wcag21aa`, `wcag22aa` — with `target-size` (2.5.8)
 *      switched on explicitly. axe-core 4.13 ships `target-size` with
 *      `enabled: false`, and before Phase 9 every spec called
 *      `axe.run('#app-content')` with no options, so WCAG 2.2's one new
 *      layout criterion was never measured (CF-6).
 *   2. **The scan root is `document`**, so Base UI's portals (dialogs,
 *      popovers, comboboxes, tooltips — all rendered to `document.body`) are
 *      seen (CF-7). The previous `#app-content` scope could not see a single
 *      dialog.
 *   3. **The only exclusion is the dev-only TanStack Query/Router devtools
 *      panels** — third-party chrome that exists only under `vite dev`, never
 *      in a production build. No element of this app is excluded, ever: a
 *      failing colour is fixed in `theme.css`, not hidden here (CF-8 was a
 *      real dark-theme contrast failure masked by four per-spec exclusions
 *      for a whole phase).
 *
 * `@axe-core/playwright` is not an installed dependency (no package may be
 * added) — `axe-core` itself already is. Injecting its browser bundle with
 * `page.addScriptTag` and calling `window.axe.run()` is the same technique
 * `@axe-core/playwright` uses internally, minus the wrapper package.
 */
const axeScriptPath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** The WCAG 2.2 A + AA tag set (every tag axe-core 4.13 defines for those levels). */
export const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/**
 * The devtools panels, and nothing else. `vite dev` mounts
 * `ReactQueryDevtools` (`.tsqd-*`) and `TanStackRouterDevtoolsPanel` as
 * siblings of the app; neither exists in a production build
 * (`src/app/App.tsx`'s `import.meta.env.DEV` gate), and their own upstream
 * issues say nothing about this app.
 */
export const DEVTOOLS_SELECTORS: readonly string[] = [
  '.tsqd-parent-container',
  '.TanStackRouterDevtoolsPanel',
];

declare global {
  interface Window {
    axe: {
      run: (context?: unknown, options?: unknown) => Promise<AxeResults>;
    };
  }
}

export interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: AxeNode[];
}

interface AxeCheckData {
  message?: string;
  data?: { messageKey?: string } | null;
}

interface AxeRuleResult {
  id: string;
  nodes: Array<AxeNode & { any?: AxeCheckData[] }>;
}

interface AxeResults {
  violations: AxeViolation[];
  passes: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  inapplicable: Array<{ id: string }>;
}

/** What one scan saw, so a caller can prove axe was able to look (`target-size` ran, contrast was measured). */
export interface AxeScan {
  violations: AxeViolation[];
  /** Rule ids that produced at least one pass, violation or incomplete result. */
  rulesThatRan: string[];
  /** Rule ids axe could not decide for at least one node (`color-contrast` over an image, say). */
  incomplete: Array<{ id: string; nodes: number }>;
  /** The first incomplete nodes per rule with axe's own reason, so "could not decide" is read, not assumed benign. */
  incompleteSamples: Array<{ id: string; target: string; reason: string; html: string }>;
  /** The second opinion on the colour-contrast nodes axe could not decide (`ContrastResolution`). */
  contrast: ContrastResolution;
}

/** Injects axe-core into the current page (call again after each full navigation; a client-side route change keeps it). */
export async function injectAxe(page: Page): Promise<void> {
  const present = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!present) await page.addScriptTag({ path: axeScriptPath });
}

/**
 * Waits until every *finite* CSS transition and animation on the page has
 * finished, so axe measures settled colours, not a fade's midpoint (a
 * dialog's 160 ms fade-in reads as a 2:1 contrast mid-flight). Infinite
 * animations (a spinner, the skeleton shimmer) are loading chrome that never
 * drains and are deliberately not waited for.
 */
export async function waitForAnimationsToDrain(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((animation) => animation.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * What `runAxe` does with axe's "incomplete" colour-contrast results (a node axe could not decide: text over an
 * SVG or image, an overlapping positioned element, a glyph outside the basic plane). Left alone they are a silent
 * pass — the way a green axe stays green over text it never measured — so each one is measured here from the
 * element's own computed colours, composited over its ancestors' backgrounds, and a pair under the threshold is
 * reported as a violation. A node whose background is a gradient, an image or a translucent layer cannot be
 * resolved that way and is counted as `unresolved`, which the sweep writes to the evidence (it is not a pass).
 */
export interface ContrastResolution {
  resolved: number;
  unresolved: Array<{ target: string; why: string }>;
  failures: Array<{ target: string; ratio: number; needed: number; html: string }>;
}

/** Runs axe over `document` with the WCAG 2.2 AA tag set and returns what it found and what it ran. */
export async function runAxe(page: Page): Promise<AxeScan> {
  await injectAxe(page);
  await waitForAnimationsToDrain(page);
  return page.evaluate(
    async ({ tags, devtools }) => {
      const result = await window.axe.run(
        { include: [['html']], exclude: devtools.map((selector) => [selector]) },
        {
          runOnly: { type: 'tag', values: [...tags] },
          // `target-size` ships disabled in axe-core 4.13; WCAG 2.2's 2.5.8.
          rules: { 'target-size': { enabled: true } },
          resultTypes: ['violations', 'incomplete', 'passes'],
        },
      );
      const ran = new Set<string>();
      for (const group of [result.violations, result.passes, result.incomplete]) {
        for (const rule of group) ran.add(rule.id);
      }

      // --- second opinion on every colour-contrast node axe could not decide ---
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      type Rgba = [number, number, number, number];
      const parse = (css: string): Rgba | null => {
        if (context === null) return null;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = '#000';
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        // Canvas stores premultiplied-then-rounded 8-bit; recover straight alpha for a translucent colour.
        return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
      };
      const over = (top: Rgba, below: [number, number, number]): [number, number, number] => [
        top[0] * top[3] + below[0] * (1 - top[3]),
        top[1] * top[3] + below[1] * (1 - top[3]),
        top[2] * top[3] + below[2] * (1 - top[3]),
      ];
      const luminance = (c: [number, number, number]): number => {
        const lin = c.map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
      };
      const resolution: ContrastResolution = { resolved: 0, unresolved: [], failures: [] };
      const contrastRule = result.incomplete.find((rule) => rule.id === 'color-contrast');
      for (const node of contrastRule?.nodes ?? []) {
        const selector = node.target[node.target.length - 1] ?? '';
        const label = node.target.join(' ');
        let element: Element | null;
        try {
          element = document.querySelector(selector);
        } catch {
          element = null;
        }
        if (element === null) {
          resolution.unresolved.push({ target: label, why: 'element not found by selector' });
          continue;
        }
        const style = getComputedStyle(element);
        const isSvgText = element instanceof SVGElement;
        const fg = parse(isSvgText ? style.fill : style.color);
        if (fg === null || (isSvgText && style.fill === 'none')) {
          resolution.unresolved.push({ target: label, why: 'foreground not a flat colour' });
          continue;
        }
        // Background: the nearest stack of ancestors' backgrounds down to the first opaque one. An SVG's own
        // `<rect>` fills are not in this stack, so a chart with a filled plot area is "unresolved", not guessed.
        const stack: Rgba[] = [];
        let why = '';
        let opacity = 1;
        for (let node2: Element | null = element; node2 !== null; node2 = node2.parentElement) {
          const s = getComputedStyle(node2);
          opacity *= Number(s.opacity);
          if (s.backgroundImage !== 'none') {
            why = 'a gradient or image sits behind the text';
            break;
          }
          const bg = parse(s.backgroundColor);
          if (bg !== null && bg[3] > 0) stack.push(bg);
          if (bg !== null && bg[3] >= 0.999) break;
        }
        if (why !== '' || opacity < 0.999) {
          resolution.unresolved.push({
            target: label,
            why: why === '' ? 'the text is translucent (opacity)' : why,
          });
          continue;
        }
        let colour: [number, number, number] = [255, 255, 255];
        for (let i = stack.length - 1; i >= 0; i -= 1) colour = over(stack[i] as Rgba, colour);
        const text = over(fg, colour);
        const l1 = luminance(text);
        const l2 = luminance(colour);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const px = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const needed = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
        resolution.resolved += 1;
        if (ratio < needed) {
          resolution.failures.push({
            target: label,
            ratio: Math.round(ratio * 100) / 100,
            needed,
            html: node.html.slice(0, 140),
          });
        }
      }
      const failing: AxeViolation[] =
        resolution.failures.length === 0
          ? []
          : [
              {
                id: 'color-contrast (measured here: axe could not decide these nodes)',
                impact: 'serious',
                description: 'text colour against the composited background, below the WCAG ratio',
                nodes: resolution.failures.map((f) => ({
                  target: [f.target],
                  html: f.html,
                  failureSummary: `${String(f.ratio)}:1, needs ${String(f.needed)}:1`,
                })),
              },
            ];
      return {
        violations: [...result.violations, ...failing],
        rulesThatRan: [...ran].sort(),
        incomplete: result.incomplete.map((rule) => ({ id: rule.id, nodes: rule.nodes.length })),
        incompleteSamples: result.incomplete.flatMap((rule) =>
          rule.nodes.slice(0, 40).map((node) => ({
            id: rule.id,
            target: node.target.join(' '),
            reason: node.any?.[0]?.data?.messageKey ?? node.any?.[0]?.message ?? '',
            html: node.html.slice(0, 140),
          })),
        ),
        contrast: resolution,
      };
    },
    { tags: WCAG_22_AA_TAGS, devtools: DEVTOOLS_SELECTORS },
  );
}

/** One readable block per violation: rule id, impact, and the selector and summary of every node. */
export function describeViolations(violations: readonly AxeViolation[]): string {
  return violations
    .map(
      (v) =>
        `- [${v.impact ?? 'n/a'}] ${v.id}: ${v.description}\n  ${v.nodes
          .map((n) => `${n.target.join(' ')} :: ${n.html}\n  ${n.failureSummary ?? ''}`)
          .join('\n  ')}`,
    )
    .join('\n');
}

/**
 * Runs axe against the whole document in the page's *current* theme and
 * throws with the screen's name and every violation's rule, selector and
 * summary — enough to act on without re-running locally. Returns the scan so
 * the sweep can assert axe was able to see.
 */
export async function expectNoAxeViolations(page: Page, screenName: string): Promise<AxeScan> {
  const scan = await runAxe(page);
  if (scan.violations.length > 0) {
    throw new Error(
      `axe found ${String(scan.violations.length)} violation(s) on ${screenName}:\n${describeViolations(scan.violations)}`,
    );
  }
  return scan;
}

type Theme = 'light' | 'dark';

/** `src/lib/theme.ts`'s own two effects — the stored preference and `data-theme` on `<html>` — without a reload. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await page.waitForFunction((value) => document.documentElement.dataset['theme'] === value, theme);
  // Colours transition on a theme change (`--dur-fast`); measure and photograph them settled.
  await waitForAnimationsToDrain(page);
}

/**
 * Scans the current screen — whatever dialog, popover or combobox is open on
 * it — in light and then in dark, and throws once with both themes'
 * violations. Replaces every per-spec copy of the helper (`setTheme` +
 * `expectNoAxe…`). The page's theme is restored afterwards.
 */
export async function scanBothThemes(
  page: Page,
  screenName: string,
  themes: readonly Theme[] = ['light', 'dark'],
): Promise<AxeScan[]> {
  const original = await page.evaluate(() => document.documentElement.dataset['theme'] ?? null);
  const scans: AxeScan[] = [];
  const failures: string[] = [];
  for (const theme of themes) {
    await setTheme(page, theme);
    const scan = await runAxe(page);
    scans.push(scan);
    if (scan.violations.length > 0) {
      failures.push(
        `${theme}: ${String(scan.violations.length)} violation(s)\n${describeViolations(scan.violations)}`,
      );
    }
  }
  if (original === 'light' || original === 'dark') {
    await setTheme(page, original);
  } else {
    await page.evaluate(() => {
      window.localStorage.removeItem('personalfi:theme');
      document.documentElement.removeAttribute('data-theme');
    });
  }
  if (failures.length > 0) {
    throw new Error(`axe found violations on ${screenName}:\n${failures.join('\n')}`);
  }
  return scans;
}
