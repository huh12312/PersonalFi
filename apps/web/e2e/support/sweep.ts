// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { DEVTOOLS_SELECTORS } from './axe.ts';
import { signIn } from './mock-sweep.ts';

/**
 * Shared machinery for `a11y-sweep.spec.ts` (WP 9.8). Nothing in here names a screen or a dialog: the routes
 * come from the generated route tree and the triggers from the DOM the real components render (C5-11).
 */

// ---------------------------------------------------------------------------
// The routes: the router's own list
// ---------------------------------------------------------------------------

const ROUTE_TREE = new URL('../../src/routeTree.gen.ts', import.meta.url);

/**
 * Every path in `src/routeTree.gen.ts`'s `FileRoutesByFullPath` (TanStack Router writes it from
 * `src/routes/**`), with the trailing-slash index entries folded into their parent. A screen added under
 * `src/routes/` is in this list the moment the generator runs; the sweep cannot skip it.
 */
export function routePatternsInTree(): string[] {
  const source = readFileSync(ROUTE_TREE, 'utf8');
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (block === undefined) throw new Error('FileRoutesByFullPath not found in routeTree.gen.ts');
  const paths = [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] as string);
  const folded = paths.map((p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p));
  return [...new Set(folded)].sort();
}

/**
 * The value a dynamic segment takes. A new `$param` with no entry here fails the sweep by name rather than
 * being skipped — the fixture, not the router, is what has to learn about it.
 */
const PARAM_VALUES: Readonly<Record<string, string>> = {
  accountId: 'acct_ira',
  // WP 10.12: a pillar of the health score.
  pillar: 'emergency-fund',
  // WP 10.14: a category the general fixture's chart of categories has (`mock-api.ts`).
  categoryId: 'cat_dining_coffee',
};

export function concretePath(pattern: string): string {
  return pattern.replace(/\$(\w+)/g, (_, name: string) => {
    const value = PARAM_VALUES[name];
    if (value === undefined) {
      throw new Error(
        `the route ${pattern} has a $${name} segment and the sweep has no fixture value for it`,
      );
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Visiting a route
// ---------------------------------------------------------------------------

/** What a screen is waiting on when it is not done: a skeleton, a busy region, a progress bar. */
const LOADING = '.skeleton, [aria-busy="true"], [role="progressbar"]';

/**
 * Goes to `path`; if the app sends an unauthenticated visitor to `/login`, signs in (the mocks accept the
 * TOTP path) and goes again. Public routes (login, register, unlock) are therefore scanned signed-out, which
 * is how a visitor meets them. Waits for the screen's loading chrome to go.
 */
export async function visit(page: Page, path: string): Promise<{ stillLoading: boolean }> {
  const land = async (): Promise<string> => {
    // The session check and any redirect to /login are client-side, after the document has loaded. (Not
    // `networkidle`: the plan screen polls, and a screen that never goes quiet is not a screen to skip.)
    const session = page
      .waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/session', { timeout: 3_000 })
      .catch(() => undefined); // a public screen (the kitchen sink) never asks
    await page.goto(path);
    await session;
    await page.waitForTimeout(400);
    await page.locator('#app-content *').first().waitFor();
    return new URL(page.url()).pathname;
  };
  const landed = await land();
  if (landed === '/login' && path !== '/login') {
    await signIn(page);
    await land();
  }
  // A screen that is still showing a skeleton after this long is reported, not scanned as if it were done.
  const stillLoading = await expect(page.locator(LOADING))
    .toHaveCount(0, { timeout: 8_000 })
    .then(() => false)
    .catch(() => true);
  return { stillLoading };
}

/**
 * Takes the dev-only devtools panels out of the layout, for the measurements that are about the page's own size
 * (reflow, zoom): the panels are positioned past the viewport edge and would make `<html>` scroll sideways in a
 * dev server and never in a build.
 */
export async function hideDevtools(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `${DEVTOOLS_SELECTORS.join(', ')} { display: none !important; }`,
  });
}

// ---------------------------------------------------------------------------
// Finding and opening overlays
// ---------------------------------------------------------------------------

/** Anything a trigger can open: Base UI's dialog/popover (`dialog`), combobox/select (`listbox`), menus, tooltips. */
export const OVERLAY = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="menu"]',
].join(', ');

/**
 * A Base UI tooltip popup: inside a portal, open, focusable-but-not-tabbable, and with none of the roles above.
 * (This Base UI release gives the popup no `role="tooltip"`, so a role selector would never find one — the sweep
 * found that out the hard way. The portal wrapper itself has no box, which is why the popup is what is selected.)
 */
const TOOLTIP = '[data-base-ui-portal] [data-open][tabindex="-1"]:not([role])';

export interface OpenedOverlay {
  /** The trigger's accessible label, as the DOM gives it. */
  readonly trigger: string;
  readonly role: string;
  readonly via: 'click' | 'hover';
  /** Where focus was when the overlay closed, when that was not the trigger and the sweep does not assert it. */
  focusNote?: string;
}

interface Candidate {
  readonly key: string;
  readonly label: string;
}

/**
 * Tags the first not-yet-tried trigger candidate with `data-sweep-trigger` and returns it.
 *
 * A candidate is a visible, enabled control that could open something: a `button`, a `combobox`, anything that
 * declares `aria-haspopup`/`aria-expanded`. Plain links are navigation, not overlays, and are left alone. Which
 * of them *do* open something is found by clicking, not by a list: a dialog added to any screen is found the
 * day it renders.
 */
async function nextCandidate(
  page: Page,
  tried: ReadonlySet<string>,
  inside: boolean,
): Promise<Candidate | null> {
  return page.evaluate(
    ({ triedKeys, insideOverlay }) => {
      const seen = new Set(triedKeys);
      document.querySelectorAll('[data-sweep-trigger]').forEach((el) => {
        el.removeAttribute('data-sweep-trigger');
      });
      const overlaySelector =
        '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]';
      const overlays = [...document.querySelectorAll<HTMLElement>(overlaySelector)].filter(
        (o) => o.getBoundingClientRect().width > 0,
      );
      // Inside an overlay: only the topmost one's controls. Outside: nothing that sits in an overlay.
      const scope: ParentNode = insideOverlay
        ? (overlays[overlays.length - 1] ?? document)
        : document;
      const selector =
        'button, [role="button"], [role="combobox"], [aria-haspopup], summary, [role="row"][tabindex]';
      const counts = new Map<string, number>();
      for (const el of scope.querySelectorAll<HTMLElement>(selector)) {
        if (!insideOverlay && el.closest(overlaySelector)) continue;
        if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel')) continue;
        if (el.closest('[inert], [aria-hidden="true"]')) continue;
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
          continue;
        // A submit button saves a form; closing and opening is what this pass is for.
        if (insideOverlay && el.getAttribute('type') === 'submit') continue;
        if (insideOverlay && el.getAttribute('aria-label') === 'Close') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '')
          .trim()
          .replace(/\s+/g, ' ');
        const base = `${insideOverlay ? 'in' : 'out'}|${el.tagName.toLowerCase()}|${el.getAttribute('role') ?? ''}|${label}`;
        const nth = counts.get(base) ?? 0;
        counts.set(base, nth + 1);
        const key = `${base}|${String(nth)}`;
        if (seen.has(key)) continue;
        el.setAttribute('data-sweep-trigger', '');
        return { key, label: label.slice(0, 80) };
      }
      return null;
    },
    { triedKeys: [...tried], insideOverlay: inside },
  );
}

function triggerLocator(page: Page): Locator {
  return page.locator('[data-sweep-trigger]');
}

async function overlayCount(page: Page): Promise<number> {
  return page.locator(OVERLAY).filter({ visible: true }).count();
}

/** Closes whatever is open with Escape, the way a keyboard user would, and waits for it to leave. */
export async function closeOverlays(page: Page): Promise<void> {
  await closeDownTo(page, 0);
}

/** Escape, until only `target` overlays remain: one Escape closes the topmost. */
async function closeDownTo(page: Page, target: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await overlayCount(page)) <= target) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  const still = await page
    .locator(OVERLAY)
    .filter({ visible: true })
    .evaluateAll((els) =>
      els.map((el) => {
        const active = document.activeElement;
        return `<${el.tagName.toLowerCase()} role=${el.getAttribute('role') ?? ''}> "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 50)}" (focus in it: ${String(el.contains(active))}; focus on ${active?.tagName.toLowerCase() ?? 'nothing'} "${(active?.getAttribute('aria-label') ?? active?.textContent ?? '').trim().slice(0, 30)}")`;
      }),
    );
  expect(
    still.length,
    `an overlay did not close on Escape (2.1.2 / 1.4.13); still open: ${still.join(' | ')}`,
  ).toBeLessThanOrEqual(target);
}

/** Waits briefly for an overlay beyond the `existing` ones to appear. */
async function overlayBeyond(page: Page, existing: number): Promise<Locator | null> {
  try {
    await expect.poll(() => overlayCount(page), { timeout: 800 }).toBeGreaterThan(existing);
  } catch {
    return null;
  }
  return page.locator(OVERLAY).filter({ visible: true }).nth(existing);
}

const MAX_TRIGGERS = 80;
const MAX_DEPTH = 2;

interface Walk {
  readonly page: Page;
  readonly returnTo: string;
  readonly whileOpen: (opened: OpenedOverlay) => Promise<void>;
  readonly opened: OpenedOverlay[];
}

/**
 * Tries every trigger candidate on the current screen — and, inside every overlay that opens, every control
 * in it (two levels, so a transaction's detail sheet reaches its split, rule and transfer dialogs). For each
 * one that opens an overlay (by click, or for an icon-only control by hover, which is how a tooltip opens),
 * `whileOpen` runs with the overlay on screen; the overlay is then closed with Escape and focus is required to
 * be back on the trigger (2.4.3). A click that navigates is undone with `returnTo`; a click inside an overlay
 * that closes it (Cancel, Save) is undone by opening the overlay again.
 */
export async function openEveryOverlay(
  page: Page,
  returnTo: string,
  whileOpen: (opened: OpenedOverlay) => Promise<void>,
): Promise<OpenedOverlay[]> {
  const walk: Walk = { page, returnTo, whileOpen, opened: [] };
  await explore(walk, 0, null);
  return walk.opened;
}

async function explore(
  walk: Walk,
  depth: number,
  reopen: (() => Promise<boolean>) | null,
): Promise<void> {
  const { page } = walk;
  const tried = new Set<string>();
  for (let n = 0; n < MAX_TRIGGERS; n += 1) {
    const candidate = await nextCandidate(page, tried, depth > 0);
    if (candidate === null) return;
    tried.add(candidate.key);
    const trigger = triggerLocator(page);
    const existing = await overlayCount(page);

    // A tooltip opens on hover for an icon-only control (it has an aria-label and no text of its own).
    const iconOnly =
      depth === 0 &&
      (await trigger.evaluate(
        (el) => el.hasAttribute('aria-label') && (el.textContent ?? '').trim() === '',
      ));
    if (iconOnly) {
      await trigger.hover({ timeout: 2_000 }).catch(() => undefined);
      const tooltip = page.locator(TOOLTIP).first();
      const shown = await tooltip
        .waitFor({ state: 'visible', timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      if (shown) {
        const info: OpenedOverlay = { trigger: candidate.label, role: 'tooltip', via: 'hover' };
        walk.opened.push(info);
        await walk.whileOpen(info);
        // 1.4.13 hoverable + persistent: the pointer can move onto the tooltip and it stays.
        await tooltip.hover({ timeout: 2_000 });
        await page.waitForTimeout(500);
        await expect(
          tooltip,
          `1.4.13: the tooltip on "${candidate.label}" vanished when hovered`,
        ).toBeVisible();
        // 1.4.13 dismissible: Escape closes it without moving the pointer or focus.
        await page.keyboard.press('Escape');
        await expect(
          page.locator(TOOLTIP),
          `1.4.13: Escape did not dismiss the tooltip on "${candidate.label}"`,
        ).toHaveCount(0, { timeout: 2_000 });
        await page.mouse.move(0, 0);
      }
    }

    const before = new URL(page.url()).pathname;
    try {
      await trigger.click({ timeout: 2_000 });
    } catch {
      continue;
    }
    const overlay = await overlayBeyond(page, existing);
    if (overlay !== null) {
      const role = (await overlay.getAttribute('role')) ?? 'overlay';
      const info: OpenedOverlay = {
        trigger: depth === 0 ? candidate.label : `${candidate.label} (inside an overlay)`,
        role,
        via: 'click',
      };
      walk.opened.push(info);
      await walk.whileOpen(info);
      // Mark this trigger so a nested pass can reopen the overlay and focus can be checked on the way back.
      await page.evaluate((level) => {
        document.querySelectorAll(`[data-sweep-root="${String(level)}"]`).forEach((el) => {
          el.removeAttribute('data-sweep-root');
        });
        document
          .querySelector('[data-sweep-trigger]')
          ?.setAttribute('data-sweep-root', String(level));
      }, depth);
      if (depth < MAX_DEPTH) {
        await explore(walk, depth + 1, async () => {
          const root = page.locator(`[data-sweep-root="${String(depth)}"]`);
          // The control that opened this overlay may be gone (a merge removes its own row): nothing to reopen.
          if ((await root.count()) === 0) return false;
          await root.click({ timeout: 2_000 });
          await overlayBeyond(page, existing);
          return true;
        });
      }
      await closeDownTo(page, existing);
      // 2.4.3: closing without acting hands focus back to what opened it.
      const returned = await page.evaluate((level) => {
        const root = document.querySelector(`[data-sweep-root="${String(level)}"]`);
        const active = document.activeElement;
        const describe = (el: Element | null): string =>
          el === null
            ? 'nothing'
            : `<${el.tagName.toLowerCase()} role=${el.getAttribute('role') ?? ''} aria-label=${el.getAttribute('aria-label') ?? ''}>`;
        const ok = root !== null && active !== null && (root === active || root.contains(active));
        return { ok, root: describe(root), active: describe(active) };
      }, depth);
      // Checked for dialogs. A combobox's popup is not asked: whether focus lands back on its input depends on what
      // held focus before the click that opened it, which a pointer-driven sweep cannot make meaningful — the
      // keyboard journeys check it with real Tab/arrow focus. A trigger an action inside the overlay removed
      // (a confirmed rejection takes its own row with it) has nowhere to go back to and is recorded, not failed.
      if ((role === 'dialog' || role === 'alertdialog') && returned.root !== 'nothing') {
        expect(
          returned.ok,
          `focus did not return to "${candidate.label}" when its overlay closed (trigger ${returned.root}; focus is on ${returned.active})`,
        ).toBe(true);
      } else if (!returned.ok) {
        info.focusNote = `focus is on ${returned.active}, trigger ${returned.root}`;
      }
    } else if (depth > 0 && reopen !== null && (await overlayCount(page)) < existing) {
      if (!(await reopen())) return;
    }
    const after = new URL(page.url()).pathname;
    if (after !== before) {
      await page.goto(walk.returnTo);
      await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 15_000 });
      return;
    }
  }
  throw new Error(
    `more than ${String(MAX_TRIGGERS)} trigger candidates on one screen — raise MAX_TRIGGERS on purpose`,
  );
}

/**
 * Every visible, not-selected tab in `scope` (the whole page by default), clicked in turn; `afterEach` runs on each
 * tab's panel. Pass an open dialog as `scope` to walk the tabs inside it (the "Add a connection" dialog is a tab
 * per connector, each with its own form).
 */
export async function visitEveryTab(
  page: Page,
  afterEach: (name: string) => Promise<void>,
  scope: Locator = page.locator('body'),
): Promise<string[]> {
  const names = await scope
    .locator('[role="tab"]:visible')
    .evaluateAll((tabs) =>
      tabs
        .filter((t) => t.getAttribute('aria-selected') !== 'true')
        .map((t) => (t.textContent ?? '').trim()),
    );
  // The dev gallery shows skeletons and progress bars on purpose (`visit` says the same); no real screen may.
  const settles = !new URL(page.url()).pathname.startsWith('/dev/');
  for (const name of names) {
    await scope.getByRole('tab', { name, exact: true }).first().click();
    if (settles) await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 15_000 });
    await afterEach(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 2.5.3 Label in Name
// ---------------------------------------------------------------------------

/**
 * WCAG 2.5.3: the accessible name of a control with a visible text label contains that text, so a voice-control
 * user who says what they see gets the control. axe has no rule for it. The failure that happens in practice is an
 * explicit `aria-label` that replaces the visible text ("Assign amount for Groceries" on a button that reads
 * "$0.00"), so that is what is measured: every interactive element that carries `aria-label` or `aria-labelledby`
 * and shows text of its own (anything not `sr-only`, not an icon) must have that text inside its name, compared
 * ignoring case, spacing and punctuation. Icon-only controls (no visible text) are out of scope by definition.
 */
export async function labelInNameProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const interactive =
      'button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"]';
    const problems: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(interactive)) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel')) continue;
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const aria = el.getAttribute('aria-label');
      const labelledby = el.getAttribute('aria-labelledby');
      if (aria === null && labelledby === null) continue;
      const name =
        aria ??
        (labelledby ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      // The text a sighted user reads on the control: its text nodes, minus visually hidden spans.
      let visible = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent === null) continue;
        if (parent.closest('.sr-only') !== null) continue;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        visible += ` ${node.textContent ?? ''}`;
      }
      const shown = norm(visible);
      if (shown === '') continue;
      if (!norm(name).includes(shown)) {
        problems.push(
          `<${el.tagName.toLowerCase()}> shows "${visible.trim().replace(/\s+/g, ' ').slice(0, 40)}" but is named "${name.slice(0, 60)}"`,
        );
      }
    }
    return [...new Set(problems)];
  });
}

// ---------------------------------------------------------------------------
// 1.4.13 Content on Hover or Focus: a chart's value readout
// ---------------------------------------------------------------------------

/**
 * Every chart surface on the screen (the transparent rect a chart listens to the pointer on) is hovered; the readout
 * it shows must be there, must stay when the pointer moves onto it (hoverable, persistent) and must go on Escape
 * without the pointer moving (dismissible). Returns how many charts it checked.
 */
export async function checkChartReadouts(page: Page, screen: string): Promise<number> {
  const surfaces = page.locator('main svg rect[fill="transparent"]');
  const count = await surfaces.count();
  for (let n = 0; n < count; n += 1) {
    const surface = surfaces.nth(n);
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (box === null) continue;
    const readout = page.locator('[data-chart-readout]');
    // A chart can have gaps (a day with no value shows no readout), so sweep across it until one appears.
    let shown = false;
    for (const fraction of [0.5, 0.3, 0.7, 0.9, 0.1, 0.6, 0.4, 0.8, 0.2]) {
      await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width * fraction + 2, box.y + box.height / 2);
      shown = await readout
        .first()
        .waitFor({ state: 'visible', timeout: 600 })
        .then(() => true)
        .catch(() => false);
      if (shown) break;
    }
    expect(shown, `${screen}: hovering chart ${String(n + 1)} shows no readout`).toBe(true);
    // The pointer leaves the chart surface (to the margin above it) and is not yet on the readout: it has to still be
    // there a moment later, or the pointer could never travel from the chart onto it.
    await page.mouse.move(box.x + box.width * 0.5, Math.max(1, box.y - 6));
    await page.waitForTimeout(120);
    await expect(
      readout,
      `${screen}: the readout went the instant the pointer left the chart (1.4.13)`,
    ).toBeVisible();
    // Hoverable + persistent: onto the readout itself, and it is still there after the grace period would have run out.
    await readout.hover();
    await page.waitForTimeout(600);
    await expect(
      readout,
      `${screen}: the readout vanished when the pointer moved onto it (1.4.13)`,
    ).toBeVisible();
    // Dismissible: Escape, with the pointer still where it is.
    await page.keyboard.press('Escape');
    await expect(readout, `${screen}: Escape did not dismiss the readout (1.4.13)`).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(350);
  }
  return count;
}
