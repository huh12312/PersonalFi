// SPDX-License-Identifier: MIT
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DEVTOOLS_SELECTORS,
  setTheme,
  expectNoAxeViolations,
  injectAxe,
  runAxe,
  scanBothThemes,
  waitForAnimationsToDrain,
} from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import {
  checkChartReadouts,
  closeOverlays,
  concretePath,
  hideDevtools,
  labelInNameProblems,
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

/**
 * `evidenceDir` is `playwright.config.ts`'s `PLAYWRIGHT_EVIDENCE_DIR`, handed down as a test option (C-16, O-3):
 * unset, the screenshots below go to a gitignored directory and an ordinary run rewrites nothing that is committed;
 * set it to `docs/evidence/phase-9` to write the committed `wp9.8-*.png` set on purpose, once.
 */
const test = base.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

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

/**
 * 09 §5.6: every chart has a data-table equivalent. On the screen as it stands: each chart (an `<svg>` with a name,
 * wide enough to be a chart rather than an icon) must have one in reach — a table, or a "View as table" control that
 * opens one — and every such control is opened and scanned in both themes, so the table itself is held to the same
 * rules as everything else. Returns how many charts the screen has.
 */
async function openChartTables(
  page: Page,
  screen: string,
  note: (scans: Awaited<ReturnType<typeof scanBothThemes>>) => void,
): Promise<number> {
  const charts = await page.evaluate(() => {
    const out: Array<{ name: string; equivalent: boolean }> = [];
    for (const svg of document.querySelectorAll('main svg[aria-label]')) {
      if (svg.closest('[aria-hidden="true"]') !== null) continue;
      const rect = svg.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 60) continue;
      let scope: Element | null = svg;
      let equivalent = false;
      for (let level = 0; level < 7 && scope !== null && scope.tagName !== 'MAIN'; level += 1) {
        scope = scope.parentElement;
        if (scope === null) break;
        const toggles = [...scope.querySelectorAll('button')].some((b) =>
          /^View as table/.test((b.textContent ?? '').trim()),
        );
        if (scope.querySelector('table') !== null || toggles) {
          equivalent = true;
          break;
        }
      }
      out.push({ name: svg.getAttribute('aria-label') ?? '', equivalent });
    }
    return out;
  });
  for (const chart of charts) {
    expect(
      chart.equivalent,
      `${screen}: the chart "${chart.name}" has no data table (09 §5.6)`,
    ).toBe(true);
  }
  const toggles = page.getByRole('button', { name: /^View as table/ });
  const count = await toggles.count();
  for (let n = 0; n < count; n += 1) await toggles.first().click();
  if (count > 0) {
    await expect(page.getByRole('table').first()).toBeVisible();
    note(await scanBothThemes(page, `${screen} › with every chart's table open`));
    const hide = page.getByRole('button', { name: /^Hide table/ });
    for (let n = await hide.count(); n > 0; n -= 1) await hide.first().click();
  }
  return charts.length;
}

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
      const samples = new Map<
        string,
        { id: string; target: string; reason: string; html: string }
      >();
      const measured = { resolved: 0, unresolved: new Map<string, string>() };
      const note = (scans: Awaited<ReturnType<typeof scanBothThemes>>): void => {
        for (const scan of scans) {
          scan.rulesThatRan.forEach((id) => ran.add(id));
          scan.incomplete.forEach(({ id, nodes }) =>
            incomplete.set(id, (incomplete.get(id) ?? 0) + nodes),
          );
          scan.incompleteSamples.forEach((sample) =>
            samples.set(`${sample.id}|${sample.target}`, sample),
          );
          measured.resolved += scan.contrast.resolved;
          scan.contrast.unresolved.forEach(({ target, why }) =>
            measured.unresolved.set(target, why),
          );
        }
      };

      // 2.4.2: every screen names itself in the document title, not one title for the whole app.
      const title = await page.title();
      expect(title, `${pattern}: the document title does not name the screen (2.4.2)`).toMatch(
        / · PersonalFi$/,
      );
      let chartCount = 0;
      const labelProblems = new Set<string>();
      const checkLabels = async (where: string): Promise<void> => {
        for (const p of await labelInNameProblems(page)) labelProblems.add(`${where}: ${p}`);
      };
      const dialogTabs: string[] = [];
      const h1s = (await page.locator('h1').allTextContents()).map((t) => t.trim());
      note(await scanBothThemes(page, `${pattern}`));
      await checkLabels('screen');
      chartCount += await checkChartReadouts(page, pattern);
      const tabs = await visitEveryTab(page, async (name) => {
        note(await scanBothThemes(page, `${pattern} › tab "${name}"`));
        await checkLabels(`tab "${name}"`);
        await openChartTables(page, `${pattern} › tab "${name}"`, note);
      });
      await openChartTables(page, pattern, note);
      const opened = await openEveryOverlay(page, path, async (overlay) => {
        note(
          await scanBothThemes(
            page,
            `${pattern} › ${overlay.role} opened by ${overlay.via} on "${overlay.trigger}"`,
          ),
        );
        await checkLabels(`${overlay.role} from "${overlay.trigger}"`);
        // A dialog with tabs of its own (Add a connection: one per connector, each its own form) is scanned on every one.
        if (overlay.role === 'dialog') {
          const inside = await visitEveryTab(
            page,
            async (name) => {
              note(
                await scanBothThemes(
                  page,
                  `${pattern} › dialog from "${overlay.trigger}" › tab "${name}"`,
                ),
              );
            },
            page.getByRole('dialog').last(),
          );
          dialogTabs.push(...inside.map((name) => `${overlay.trigger} › ${name}`));
        }
      });

      // axe has to have been able to look: the canary below proves target-size and contrast are on and reach a portal.
      // (A screen with nothing interactive on it — `/register` with no token — has no targets to measure; the canary
      // below proves the rules are on.)
      expect(ran.size, 'axe evaluated almost nothing').toBeGreaterThan(12);
      expect(ran.has('color-contrast'), 'colour contrast was never measured').toBe(true);

      record('axe', pattern, {
        route: pattern,
        path,
        title,
        chartsWithReadouts: chartCount,
        labelInNameProblems: [...labelProblems],
        h1s,
        tabs,
        dialogTabs,
        overlays: opened,
        rulesThatRan: [...ran].sort(),
        incomplete: Object.fromEntries(incomplete),
        incompleteSamples: [...samples.values()].slice(0, 120),
        contrastIncompleteMeasuredHere: measured.resolved,
        contrastIncompleteUnresolved: Object.fromEntries(measured.unresolved),
        unmockedApiCalls: [...new Set(mocks.unmocked)].sort(),
      });
      expect([...labelProblems], '2.5.3 Label in Name').toEqual([]);
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
        // Two, side by side: an isolated small target passes 2.5.8 on spacing alone.
        '<button type="button" aria-label="a" style="width:10px;height:10px;display:inline-block"></button>' +
        '<button type="button" aria-label="b" style="width:10px;height:10px;display:inline-block;margin-left:2px"></button>' +
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

// ---------------------------------------------------------------------------
// 7. The add-wallet form (wp5.14 item 26), in both chains and both themes
// ---------------------------------------------------------------------------

test.describe('the add-wallet form is axe-clean in both chains and both themes', () => {
  test('Settings › Crypto: Bitcoin, then Ethereum with its Etherscan note', async ({ page }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Crypto' }).click();
    await expect(page.getByRole('heading', { name: /wallet \(watch-only\)/ })).toBeVisible();
    await scanBothThemes(page, '/settings › Crypto › add wallet (Bitcoin)');
    await page.getByLabel('Chain').selectOption('ethereum');
    await expect(page.getByText(/Etherscan API key/)).toBeVisible();
    await scanBothThemes(
      page,
      '/settings › Crypto › add wallet (Ethereum, with the Etherscan note)',
    );
  });
});

// ---------------------------------------------------------------------------
// 7b. WP 10.4's states, pinned: the sweep reaches them through the shared fixtures
// ---------------------------------------------------------------------------

/**
 * The route sweep above already walks `/settings`'s "Market data" tab and `/investments`'s Holdings tab with every
 * overlay open; these pin that the fixtures it walks them with carry WP 10.4's states (a key card of each kind,
 * the Remove confirmation, an unidentified position as a named row and as a card in its account), so a fixture change
 * cannot quietly take them out of the sweep.
 */
test.describe('WP 10.4 states are axe-clean in both themes', () => {
  test('Settings › Market data: the four key cards and the Remove confirmation', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Market data' }).click();
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
    for (const provider of ['tiingo', 'fred', 'coingecko', 'openfigi']) {
      await expect(page.getByTestId(`market-data-key-${provider}`)).toBeVisible();
    }
    await expect(page.getByTestId('market-data-key-tiingo')).toContainText(
      "Set by the operator's secret file",
    );
    await expect(page.getByTestId('market-data-key-coingecko')).toContainText('ends in 9f2c');
    await scanBothThemes(page, '/settings › Market data › API keys');
    await page
      .getByTestId('market-data-key-coingecko')
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Remove the stored CoinGecko key?' }),
    ).toBeVisible();
    await scanBothThemes(page, '/settings › Market data › confirm removing a stored key');
  });

  test('Investments: an unidentified position as a named row, on the Holdings tab and in its account', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/investments');
    const row = page.locator('[data-testid^="unresolved-row-"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Could not identify this security');
    await row.getByText('Why it could not be identified').click();
    await scanBothThemes(page, '/investments › Holdings with an unidentified position');
    await visit(page, '/investments?account=acct-ira');
    await expect(page.locator('[data-testid^="unresolved-position-"]')).toHaveCount(1);
    await scanBothThemes(page, "/investments › the IRA's panel with an unidentified position");
    // Activity's marker is scanned in both themes by `investments.spec.ts` ('Activity keeps the movement in the
    // unidentified fund …'): under these layered fixtures `mock-api.ts` answers `/investments/transactions` as
    // an install with no activity (WP 10.3), so the sweep's Activity tab is its empty state.
  });
});

// ---------------------------------------------------------------------------
// 7c. WP 10.5's states, pinned: Refresh prices, its result, its disclosure and the 409
// ---------------------------------------------------------------------------

/**
 * `POST /market-data/refresh` is answered by `mock-market-data-keys.ts` (accepted once, then the ten-minute 409), so
 * these walk the one state the route sweep cannot reach by opening an overlay: the result in words with its
 * disclosure open, and the "try again after" sentence, on both screens that offer the button.
 */
test.describe('WP 10.5 states are axe-clean in both themes', () => {
  test('Investments: the Refresh prices result with its disclosure open, then the 409', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/investments');
    const refresh = page.getByRole('button', { name: 'Refresh prices' });
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(page.getByRole('status').filter({ hasText: 'Priced 12 of 13' })).toBeVisible();
    await page.getByText('Which holdings were not priced (1)').click();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'BTC: no CoinGecko key' }),
    ).toBeVisible();
    await scanBothThemes(page, '/investments › Refresh prices result');
    await refresh.click();
    await expect(page.getByRole('status').filter({ hasText: 'Try again after' })).toBeVisible();
    await scanBothThemes(page, '/investments › Refresh prices, refused as too soon');
  });

  test('Settings › Market data: the Refresh prices result with its disclosure open, then the 409', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Market data' }).click();
    const keys = page.getByTestId('market-data-keys');
    const refresh = keys.getByRole('button', { name: 'Refresh prices' });
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(keys.getByRole('status').filter({ hasText: 'Priced 12 of 13' })).toBeVisible();
    await keys.getByText('Which holdings were not priced (1)').click();
    await scanBothThemes(page, '/settings › Market data › Refresh prices result');
    await refresh.click();
    await expect(keys.getByRole('status').filter({ hasText: 'Try again after' })).toBeVisible();
    await scanBothThemes(page, '/settings › Market data › Refresh prices, refused as too soon');
  });
});

// ---------------------------------------------------------------------------
// 7d. WP 10.6's states, pinned: Settings › Language model
// ---------------------------------------------------------------------------

/**
 * `/api/narrator/*` is answered by `mock-narrator.ts` (through `mock-api.ts`). The route sweep reaches the tab's
 * resting state; these walk the states it cannot: a Test result in its live region, the remove confirmation, a
 * refused switch's alert, and the approval-withdrawn note after a switch.
 */
test.describe('WP 10.6 states are axe-clean in both themes', () => {
  test('Settings › Language model: as found, a Test result, and the remove confirmation', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Language model' }).click();
    const section = page.getByTestId('narrator-settings');
    await expect(section.getByTestId('narrator-card-anthropic')).toBeVisible();
    await scanBothThemes(page, '/settings › Language model');

    const openai = section.getByTestId('narrator-card-openai');
    await openai.getByRole('button', { name: 'Test OpenAI' }).click();
    await expect(openai.getByTestId('narrator-test-openai')).toContainText('Test passed.');
    await openai.getByRole('button', { name: 'Test OpenAI' }).click();
    await expect(openai.getByTestId('narrator-test-openai')).toContainText('Tested a moment ago.');
    await scanBothThemes(page, '/settings › Language model › a Test result, then the 20 s refusal');

    await section
      .getByTestId('narrator-card-openrouter')
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Remove the stored OpenRouter key?' }),
    ).toBeVisible();
    await scanBothThemes(page, '/settings › Language model › confirm removing a key');
  });

  test('Settings › Language model: a switch to OpenAI, with the approval-withdrawn note', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The switch asks for the passkey step-up; the ceremony is answered in the page.
    await installFakeWebAuthnAssertion(page);
    await installSweepMocks(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Language model' }).click();
    const section = page.getByTestId('narrator-settings');
    await section.getByRole('radio', { name: /^OpenAI/ }).check();
    await section.getByRole('button', { name: 'Use this provider' }).click();
    await expect(section.getByTestId('narrator-approvals-withdrawn')).toBeVisible({
      timeout: 15_000,
    });
    await scanBothThemes(page, '/settings › Language model › after a switch');
  });
});

// ---------------------------------------------------------------------------
// 8. A picture of every route, in both themes (evidence, written deliberately)
// ---------------------------------------------------------------------------

test.describe('a screenshot of every route in both themes', () => {
  for (const pattern of PATTERNS.filter((p) => !p.startsWith('/dev/'))) {
    test(`route ${pattern}`, async ({ page, evidenceDir }) => {
      test.setTimeout(120_000);
      await installSweepMocks(page, { accountSettings: pattern.includes('$') });
      await visit(page, concretePath(pattern));
      await hideDevtools(page);
      const slug = pattern === '/' ? 'dashboard' : pattern.slice(1).replace(/[/$]/g, '-');
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp9.8-${slug}-${theme}.png`,
          animations: 'disabled',
        });
      }
    });
  }
});
