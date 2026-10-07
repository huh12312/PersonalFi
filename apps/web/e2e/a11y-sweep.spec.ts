// SPDX-License-Identifier: MIT
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DEVTOOLS_SELECTORS,
  expectNoAxeViolations,
  injectAxe,
  runAxe,
  scanBothThemes,
  waitForAnimationsToDrain,
} from './support/axe.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import {
  closeOverlays,
  concretePath,
  hideDevtools,
  openEveryOverlay,
  routePatternsInTree,
  visit,
  visitEveryTab,
} from './support/sweep.ts';

/**
 * WP 9.8 (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.8" (2)): the sweep. Six exit tests, verbatim:
 *
 *   * 'every route in the route tree is axe-clean under the WCAG 2.2 AA tag set, in both themes, with every reachable dialog open'
 *   * 'no axe run in the suite excludes an element'
 *   * 'at 320 CSS px no screen scrolls horizontally'
 *   * 'with reduced motion, nothing animates'
 *
 * (the other two — the contrast test and the keyboard journeys — are `src/styles/contrast.test.ts` and
 * `a11y-keyboard.spec.ts`), plus 200 % zoom (1.4.4) and text spacing (1.4.12), and a canary that proves axe is
 * able to see (a green axe over a page it cannot see is the failure this package exists to prevent).
 *
 * Nothing here names a screen or a dialog. The routes are `src/routeTree.gen.ts`'s; a trigger is whatever
 * visible control opens an overlay when clicked, found in the DOM the real components render (C5-11). The mocks
 * are the existing per-feature mocks layered (`support/mock-sweep.ts`).
 *
 * One test per route per dimension, so a killed run resumes with `--grep` on the route that did not finish; each
 * route's findings are written to `test-results/a11y-sweep/` as it completes.
 */

// Not `test-results/`: Playwright empties that directory at the start of every run, and a sweep that is resumed
// route by route has to keep what the earlier runs found.
const RESULTS = join(tmpdir(), 'personalfi-a11y-sweep');

function record(dimension: string, pattern: string, body: Record<string, unknown>): void {
  mkdirSync(RESULTS, { recursive: true });
  const name = `${dimension}${pattern === '/' ? '-root' : pattern.replace(/[/$]/g, '-')}.json`;
  writeFileSync(join(RESULTS, name), `${JSON.stringify(body, null, 2)}\n`);
}

const PATTERNS = routePatternsInTree();

test.describe('the sweep covers the route tree', () => {
  test('the route tree on disk lists every route file under src/routes', () => {
    const files = readdirSync(new URL('../src/routes/', import.meta.url)).filter(
      (f) =>
        f.endsWith('.tsx') &&
        !f.endsWith('.test.tsx') &&
        !f.startsWith('__root') &&
        !f.startsWith('-'),
    );
    // `_app.settings_.advisors.tsx` -> `/settings/advisors`; `_app.index.tsx` -> `/`; `_app.tsx` is the layout.
    const fromFiles = files
      .map((f) => f.replace(/\.tsx$/, '').replace(/^_app\.?/, ''))
      .filter((f) => f !== '')
      .map((f) =>
        f
          .split('.')
          .map((segment) => segment.replace(/_$/, ''))
          .filter((segment) => segment !== 'index')
          .join('/'),
      )
      .map((p) => `/${p}`.replace(/\/$/, '') || '/');
    const expected = new Set(fromFiles.map((p) => (p === '' ? '/' : p)));
    expected.add('/');
    for (const path of expected) {
      expect(PATTERNS, `the route tree is missing ${path} — run the router generator`).toContain(
        path,
      );
    }
    expect(PATTERNS.length).toBeGreaterThanOrEqual(expected.size);
  });
});

// ---------------------------------------------------------------------------
// 1. Axe, both themes, every reachable overlay open
// ---------------------------------------------------------------------------

test.describe('every route in the route tree is axe-clean under the WCAG 2.2 AA tag set, in both themes, with every reachable dialog open', () => {
  for (const pattern of PATTERNS) {
    test(`route ${pattern}`, async ({ page }) => {
      test.setTimeout(300_000);
      const mocks = await installSweepMocks(page, { accountSettings: pattern.includes('$') });
      const path = concretePath(pattern);
      const { stillLoading } = await visit(page, path);
      // The dev gallery (`/dev/*`) shows skeletons and progress bars on purpose; no real screen may be mid-load.
      if (!pattern.startsWith('/dev/'))
        expect(stillLoading, `${pattern} never finished loading`).toBe(false);

      const ran = new Set<string>();
      const incomplete = new Map<string, number>();
      const samples = new Map<string, { id: string; target: string; reason: string }>();
      const note = (scans: Awaited<ReturnType<typeof scanBothThemes>>): void => {
        for (const scan of scans) {
          scan.rulesThatRan.forEach((id) => ran.add(id));
          scan.incomplete.forEach(({ id, nodes }) =>
            incomplete.set(id, (incomplete.get(id) ?? 0) + nodes),
          );
          scan.incompleteSamples.forEach((sample) =>
            samples.set(`${sample.id}|${sample.target}`, sample),
          );
        }
      };

      const h1s = (await page.locator('h1').allTextContents()).map((t) => t.trim());
      note(await scanBothThemes(page, `${pattern}`));
      const tabs = await visitEveryTab(page, async (name) => {
        note(await scanBothThemes(page, `${pattern} › tab "${name}"`));
      });
      const opened = await openEveryOverlay(page, path, async (overlay) => {
        note(
          await scanBothThemes(
            page,
            `${pattern} › ${overlay.role} opened by ${overlay.via} on "${overlay.trigger}"`,
          ),
        );
      });

      // axe has to have been able to look: the canary below proves target-size and contrast are on and reach a portal.
      // (A screen with nothing interactive on it — `/register` with no token — has no targets to measure; the canary
      // below proves the rules are on.)
      expect(ran.size, 'axe evaluated almost nothing').toBeGreaterThan(15);

      record('axe', pattern, {
        route: pattern,
        path,
        h1s,
        tabs,
        overlays: opened,
        rulesThatRan: [...ran].sort(),
        incomplete: Object.fromEntries(incomplete),
        incompleteSamples: [...samples.values()].slice(0, 40),
        unmockedApiCalls: [...new Set(mocks.unmocked)].sort(),
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Axe can see — a canary, because green over a blind axe is the failure
// ---------------------------------------------------------------------------

test.describe('axe is able to see', () => {
  test('a too-small, low-contrast control in a portal is reported (target size, contrast, document scope)', async ({
    page,
  }) => {
    await installSweepMocks(page);
    await visit(page, '/budget');
    await page.evaluate(() => {
      const portal = document.createElement('div');
      portal.setAttribute('role', 'dialog');
      portal.setAttribute('aria-label', 'canary');
      portal.style.cssText =
        'position:fixed;top:40px;left:40px;background:#ffffff;padding:8px;z-index:999';
      portal.innerHTML =
        '<button type="button" style="width:10px;height:10px;display:block"></button>' +
        '<p style="color:#bbbbbb;margin:12px 0 0">low contrast text</p>';
      document.body.appendChild(portal);
    });
    await injectAxe(page);
    const scan = await runAxe(page);
    const ids = scan.violations.map((v) => v.id);
    expect(ids, 'target-size must be on').toContain('target-size');
    expect(ids, 'contrast must be measured inside a portal').toContain('color-contrast');
    await expect(expectNoAxeViolations(page, 'canary')).rejects.toThrow(/target-size/);
  });

  test('the devtools panels are the only thing the scan leaves out', async ({ page }) => {
    await installSweepMocks(page);
    await visit(page, '/budget');
    expect(DEVTOOLS_SELECTORS).toEqual(['.tsqd-parent-container', '.TanStackRouterDevtoolsPanel']);
    // A violating control placed under an app element is seen; only the devtools classes are skipped.
    await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.className = 'tsqd-parent-container';
      panel.innerHTML = '<button type="button" style="width:4px;height:4px"></button>';
      document.body.appendChild(panel);
      const app = document.createElement('div');
      app.innerHTML =
        '<button type="button" id="canary-app" style="width:4px;height:4px"></button>';
      document.body.appendChild(app);
    });
    const scan = await runAxe(page);
    const targets = scan.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
    expect(targets.some((t) => t.includes('canary-app'))).toBe(true);
    expect(targets.some((t) => t.includes('tsqd'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. No axe run excludes an element
// ---------------------------------------------------------------------------

/** Every `.ts` file under `e2e/`, read from disk. */
function e2eSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts'))
        out.push({ file: child.pathname, text: readFileSync(child, 'utf8') });
    }
  };
  walk(new URL('./', import.meta.url));
  return out;
}

test.describe('the axe harness cannot be loosened from a spec', () => {
  // The words are assembled so that this file does not contain what it forbids.
  const EXCLUDE_KEY = new RegExp(['\\bexclu', 'de\\b\\s*[\'"]?\\s*[:(]'].join(''));
  const RULE_OFF = new RegExp(['rules\\s*:\\s*\\{[^}]*enabled\\s*:\\s*', 'false'].join(''));
  const DIRECT_RUN = new RegExp(['axe\\.', 'run\\b'].join(''));

  test('no axe run in the suite excludes an element', () => {
    const offenders: string[] = [];
    for (const { file, text } of e2eSources()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const isHarness = file.endsWith('/support/axe.ts');
      if (!isHarness && EXCLUDE_KEY.test(code)) offenders.push(`${file}: names an exclusion`);
      if (!isHarness && DIRECT_RUN.test(code))
        offenders.push(`${file}: calls axe directly instead of the harness`);
      if (RULE_OFF.test(code)) offenders.push(`${file}: switches an axe rule off`);
    }
    expect(offenders).toEqual([]);
  });

  test('the harness excludes the devtools panels and nothing else', () => {
    const harness = readFileSync(new URL('./support/axe.ts', import.meta.url), 'utf8');
    const code = harness.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Exactly one exclusion expression, built from DEVTOOLS_SELECTORS.
    const exclusions = [...code.matchAll(new RegExp(EXCLUDE_KEY.source, 'g'))];
    expect(exclusions).toHaveLength(1);
    expect(code).toContain(['exclu', 'de: devtools.map((selector) => [selector])'].join(''));
    for (const selector of DEVTOOLS_SELECTORS) {
      expect(selector).toMatch(/^\.(tsqd-|TanStackRouterDevtools)/);
    }
    expect(code).toContain("rules: { 'target-size': { enabled: true } }");
    expect(code).toContain("'wcag22aa'");
    expect(code).toContain("include: [['html']]");
  });
});

// ---------------------------------------------------------------------------
// 4. 320 CSS px: no horizontal scrolling (1.4.10)
// ---------------------------------------------------------------------------

/**
 * 1.4.10 names 320 CSS px wide for vertical-scrolling content (1280 px at 400 %). The height is a phone's, not the
 * criterion's 256: a dialog has to fit *a* viewport and scroll inside itself, and at 256 px nothing taller than a
 * toast could, which says nothing about the app.
 */
const REFLOW = { width: 320, height: 640 } as const;

/**
 * Elements that make the page scroll sideways or lose content past the right edge, and nested scrollers that
 * are not showing a table or a chart. `data tables` and charts are the 1.4.10 exception for content that needs
 * two-dimensional layout; everything else must reflow.
 */
async function horizontalProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element): string => {
      const id = el.id === '' ? '' : `#${el.id}`;
      const cls =
        typeof el.className === 'string' && el.className.trim() !== ''
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    for (const el of [
      document.documentElement,
      document.body,
      ...document.querySelectorAll('main, #app-content, #root'),
    ]) {
      if (el.scrollWidth > el.clientWidth + 1) {
        problems.push(
          `${describe(el)} scrolls horizontally (${String(el.scrollWidth)} > ${String(el.clientWidth)})`,
        );
      }
    }
    // A scroller is something the page puts a scrollbar on on purpose; `<main>` is the page itself (it scrolls in
    // both axes because it scrolls in one), so it does not excuse what is inside it.
    const inScroller = (el: Element): boolean => {
      for (let p = el.parentElement; p !== null; p = p.parentElement) {
        if (p.matches('main, body, html, #root, #app-content')) continue;
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel')) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.display === 'none' || style.visibility === 'hidden')
        continue;
      if (
        !el.matches('main, body, html, #root, #app-content') &&
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        el.scrollWidth > el.clientWidth + 1
      ) {
        const twoDimensional =
          el.matches('table') || el.querySelector('table, svg, canvas') !== null;
        if (!twoDimensional)
          problems.push(`${describe(el)} is a horizontal scroller without a table or chart inside`);
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.right > vw + 1 &&
        !inScroller(el) &&
        el.tagName !== 'HTML' &&
        el.tagName !== 'BODY'
      ) {
        const text = (el.textContent ?? '').trim().slice(0, 30);
        if (text !== '' || el.matches('input, select, textarea, button, img, svg')) {
          problems.push(
            `${describe(el)} ends at ${String(Math.round(rect.right))}px of ${String(vw)} ("${text}")`,
          );
        }
      }
    }
    return [...new Set(problems)].slice(0, 12);
  });
}

/** An open overlay has to fit the reflow viewport: its box inside it, and anything taller than the box scrollable. */
async function overlayFitProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]',
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      const label =
        el.getAttribute('aria-label') ??
        el.querySelector('h2, h3')?.textContent ??
        el.getAttribute('role') ??
        'overlay';
      if (rect.left < -1 || rect.right > vw + 1) {
        out.push(
          `"${label}" is ${String(Math.round(rect.width))}px wide in a ${String(vw)}px viewport`,
        );
      }
      const overflowY = getComputedStyle(el).overflowY;
      const scrollable = overflowY === 'auto' || overflowY === 'scroll';
      if (rect.top < -1 || rect.bottom > vh + 1) {
        out.push(
          `"${label}" spans ${String(Math.round(rect.top))}…${String(Math.round(rect.bottom))}px of a ${String(vh)}px viewport (${scrollable ? 'scrolls, but its box is off screen' : 'cannot scroll'})`,
        );
      } else if (el.scrollHeight > el.clientHeight + 1 && !scrollable) {
        out.push(
          `"${label}" clips ${String(el.scrollHeight - el.clientHeight)}px of content (overflow-y: ${overflowY})`,
        );
      }
    }
    return out;
  });
}

test.describe('at 320 CSS px no screen scrolls horizontally', () => {
  test.use({ viewport: REFLOW });
  for (const pattern of PATTERNS) {
    test(`route ${pattern}`, async ({ page }) => {
      test.setTimeout(300_000);
      await installSweepMocks(page, { accountSettings: pattern.includes('$') });
      const path = concretePath(pattern);
      await visit(page, path);
      await hideDevtools(page);

      const problems: string[] = [];
      for (const p of await horizontalProblems(page)) problems.push(`screen: ${p}`);
      await visitEveryTab(page, async (name) => {
        for (const p of await horizontalProblems(page)) problems.push(`tab "${name}": ${p}`);
      });
      const opened = await openEveryOverlay(page, path, async (overlay) => {
        if (overlay.role === 'tooltip') return;
        await waitForAnimationsToDrain(page); // a sheet is measured where it settles, not mid-slide
        for (const p of [
          ...(await horizontalProblems(page)),
          ...(await overlayFitProblems(page)),
        ]) {
          problems.push(`${overlay.role} from "${overlay.trigger}": ${p}`);
        }
      });
      record('reflow', pattern, { route: pattern, overlays: opened, problems });
      expect(problems).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. 200 % zoom and text spacing (1.4.4, 1.4.12)
// ---------------------------------------------------------------------------

/** 1280 × 800 at 200 % browser zoom, as the browser reports it. */
const ZOOM_200 = { width: 640, height: 400 } as const;

async function clippedTextElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel, svg')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const clips =
        ['hidden', 'clip'].includes(style.overflowX) ||
        ['hidden', 'clip'].includes(style.overflowY);
      if (!clips) continue;
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      );
      if (!hasText) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        const cls =
          typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '';
        out.push(
          `${el.tagName.toLowerCase()}.${cls}: "${(el.textContent ?? '').trim().slice(0, 40)}"`,
        );
      }
    }
    return [...new Set(out)];
  });
}

const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

test.describe('at 200 % zoom and with 1.4.12 text spacing nothing is lost', () => {
  test.use({ viewport: ZOOM_200, deviceScaleFactor: 2 });
  for (const pattern of PATTERNS) {
    test(`route ${pattern}`, async ({ page }) => {
      test.setTimeout(240_000);
      await installSweepMocks(page, { accountSettings: pattern.includes('$') });
      const path = concretePath(pattern);
      await visit(page, path);
      await hideDevtools(page);

      // 1.4.4: at 200 % the screen still reflows and is still axe-clean, in both themes.
      expect(await horizontalProblems(page), 'horizontal overflow at 200 %').toEqual([]);
      await scanBothThemes(page, `${pattern} at 200 %`);

      // 1.4.12: text spacing can be raised to the stated minimums without clipping text that fitted before.
      const before = new Set(await clippedTextElements(page));
      await page.addStyleTag({ content: TEXT_SPACING });
      await page.waitForTimeout(100);
      const newlyClipped = (await clippedTextElements(page)).filter((e) => !before.has(e));
      record('zoom', pattern, {
        route: pattern,
        alreadyClipped: [...before],
        newlyClippedByTextSpacing: newlyClipped,
      });
      expect(newlyClipped, '1.4.12: text spacing clips text').toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Reduced motion: nothing animates (2.3.3 / CF-11)
// ---------------------------------------------------------------------------

/** Every element and pseudo-element whose computed transition or animation has a non-zero duration, plus any running animation. */
async function motionOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seconds = (list: string): number[] =>
      list.split(',').map((v) => {
        const t = v.trim();
        return t.endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t);
      });
    const out: string[] = [];
    const describe = (el: Element, pseudo: string): string =>
      `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}${pseudo}`;
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel')) continue;
      for (const pseudo of ['', '::before', '::after']) {
        const style = getComputedStyle(el, pseudo === '' ? null : pseudo);
        const t = seconds(style.transitionDuration);
        const a = seconds(style.animationDuration);
        if (t.some((v) => v > 0))
          out.push(`${describe(el, pseudo)} transition-duration ${style.transitionDuration}`);
        if (a.some((v) => v > 0))
          out.push(`${describe(el, pseudo)} animation-duration ${style.animationDuration}`);
      }
    }
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (
        timing !== undefined &&
        Number(timing.duration) > 0 &&
        animation.playState === 'running'
      ) {
        out.push(`a running animation of ${String(timing.duration)}ms`);
      }
    }
    return [...new Set(out)].slice(0, 12);
  });
}

test.describe('with reduced motion, nothing animates', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  for (const pattern of PATTERNS) {
    test(`route ${pattern}`, async ({ page }) => {
      test.setTimeout(240_000);
      await installSweepMocks(page, { accountSettings: pattern.includes('$') });
      const path = concretePath(pattern);
      await visit(page, path);

      const offenders: string[] = [];
      for (const o of await motionOffenders(page)) offenders.push(`screen: ${o}`);
      const opened = await openEveryOverlay(page, path, async (overlay) => {
        for (const o of await motionOffenders(page))
          offenders.push(`${overlay.role} from "${overlay.trigger}": ${o}`);
      });
      await closeOverlays(page);
      record('motion', pattern, { route: pattern, overlays: opened, offenders });
      expect(offenders).toEqual([]);
    });
  }
});
