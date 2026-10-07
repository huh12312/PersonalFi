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
  /** A few incomplete nodes per rule with axe's own reason, so "could not decide" is read, not assumed benign. */
  incompleteSamples: Array<{ id: string; target: string; reason: string }>;
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
      return {
        violations: result.violations,
        rulesThatRan: [...ran].sort(),
        incomplete: result.incomplete.map((rule) => ({ id: rule.id, nodes: rule.nodes.length })),
        incompleteSamples: result.incomplete.flatMap((rule) =>
          rule.nodes.slice(0, 4).map((node) => ({
            id: rule.id,
            target: node.target.join(' '),
            reason: node.any?.[0]?.data?.messageKey ?? node.any?.[0]?.message ?? '',
          })),
        ),
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
