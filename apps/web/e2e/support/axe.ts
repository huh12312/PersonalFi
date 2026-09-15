// SPDX-License-Identifier: MIT
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

/**
 * `@axe-core/playwright` is not an installed dependency (this work package
 * may not add one) — `axe-core` itself already is (a devDependency, used via
 * `jest-axe` in the Vitest suite). Injecting its browser bundle directly via
 * `page.addScriptTag` and calling `window.axe.run()` is the same technique
 * `@axe-core/playwright` uses internally, just without the wrapper package.
 */
const axeScriptPath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

declare global {
  interface Window {
    axe: {
      run: (context?: unknown, options?: unknown) => Promise<{ violations: AxeViolation[] }>;
    };
  }
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: Array<{ target: string[]; html: string; failureSummary?: string }>;
}

/** Injects axe-core into the current page (idempotent per navigation — call again after each `page.goto`/route change). */
export async function injectAxe(page: Page): Promise<void> {
  await page.addScriptTag({ path: axeScriptPath });
}

/**
 * Runs axe against the current page and asserts zero violations, with a
 * failure message that names the screen and lists every violation's rule id
 * and the CSS selector(s) it fired on — enough to act on without re-running
 * the suite locally.
 */
export async function expectNoAxeViolations(page: Page, screenName: string): Promise<void> {
  // Scoped to `#app-content` (`src/app/App.tsx`) — this app's own tree,
  // excluding the dev-only TanStack Query/Router devtool panels that render
  // as real siblings inside `#root` (present only because this suite runs
  // against the Vite dev server, not a production build) and would
  // otherwise fail this check on issues that have nothing to do with this
  // app's own accessibility.
  const { violations } = await page.evaluate(async () => window.axe.run('#app-content'));
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `- [${v.impact}] ${v.id}: ${v.description}\n  ${v.nodes
            .map((n) => `${n.target.join(' ')} :: ${n.html}\n  ${n.failureSummary ?? ''}`)
            .join('\n  ')}`,
      )
      .join('\n');
    throw new Error(`axe found ${violations.length} violation(s) on ${screenName}:\n${details}`);
  }
}
