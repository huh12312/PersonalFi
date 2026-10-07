// SPDX-License-Identifier: MIT
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Machinery for `a11y-keyboard.spec.ts` (WP 9.8): moving through the app with `page.keyboard` only and judging
 * every stop. Nothing in here, or in the spec, uses the pointer — a structural test in the spec reads both files
 * and fails on the pointer APIs, so a journey cannot quietly start working because a click rescued it.
 *
 * What is asserted at every stop (`checkFocus`):
 *
 *   - 2.4.7 Focus Visible — the focused element draws an outline or a ring (`:focus-visible` matches and the
 *     computed outline or box-shadow is not none/zero-width). An element that keeps virtual focus (a combobox
 *     input whose highlighted option is named by `aria-activedescendant`) is judged by that option instead.
 *   - 2.4.11 Focus Not Obscured — the focused element is inside the viewport, and what the browser draws at its
 *     centre and four inset corners is the element itself (or its own content), not the bottom tab bar, a toast,
 *     a scrim or anything else laid over it. The criterion's AA bar is "not entirely hidden"; this asks for the
 *     centre as well, which is stricter.
 *   - 2.4.3 Focus Order — see `assertReadingOrder`.
 */

export interface Stop {
  readonly name: string;
  readonly role: string;
  readonly tag: string;
  /** `type` of an input (`range`, `checkbox`, …), else empty. */
  readonly type: string;
  /** The landmark or overlay the stop sits in: `aside`, `header`, `main`, `dialog`, `nav`, or `page`. */
  readonly region: string;
  readonly top: number;
  readonly left: number;
  readonly height: number;
  readonly width: number;
}

interface FocusReport extends Stop {
  readonly visible: boolean;
  readonly visibleHow: string;
  readonly inViewport: boolean;
  readonly obscuredBy: string | null;
}

/** Everything the page can tell about the focused element, computed in the page. */
async function readFocus(page: Page): Promise<FocusReport | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) {
      return null;
    }
    const describe = (el: Element): string =>
      `<${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}${
        el.getAttribute('role') === null ? '' : ` role=${el.getAttribute('role') ?? ''}`
      }>`;

    // Virtual focus: the element that looks focused is the one `aria-activedescendant` names.
    const activeId = active.getAttribute('aria-activedescendant');
    const virtual = activeId === null || activeId === '' ? null : document.getElementById(activeId);
    const subject: Element = virtual ?? active;

    const labelOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria !== null && aria.trim() !== '') return aria.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by !== null) {
        const text = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text !== '') return text;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels !== undefined && labels !== null && labels.length > 0) {
        const text = [...labels]
          .map((l) => l.textContent ?? '')
          .join(' ')
          .trim();
        if (text !== '') return text;
      }
      const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (own !== '') return own;
      return (
        el.getAttribute('placeholder') ??
        el.getAttribute('title') ??
        (el as HTMLInputElement).value ??
        ''
      );
    };

    const style = getComputedStyle(subject);
    const outline =
      style.outlineStyle !== 'none' &&
      parseFloat(style.outlineWidth) > 0 &&
      !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(style.outlineColor);
    const shadow = style.boxShadow !== 'none';
    // A highlighted option or a focused row is drawn with its own state attribute rather than the global ring.
    const highlighted =
      subject.hasAttribute('data-highlighted') || subject.getAttribute('aria-selected') === 'true';
    const focusVisibleMatches = (() => {
      try {
        return subject.matches(':focus-visible');
      } catch {
        return false;
      }
    })();
    // A native date or time field hands focus to a part inside its shadow tree (the month, the picker button):
    // `activeElement` stays the input but `:focus` no longer matches it. The browser draws that part's own ring.
    const nativePart =
      virtual === null &&
      !subject.matches(':focus') &&
      active instanceof HTMLInputElement &&
      ['date', 'time', 'datetime-local', 'month', 'week'].includes(active.type);
    let visibleHow = 'none';
    if (nativePart) visibleHow = 'native sub-control (browser-drawn)';
    else if (virtual !== null && highlighted) visibleHow = 'highlighted option';
    else if (outline) visibleHow = `outline ${style.outlineWidth} ${style.outlineStyle}`;
    else if (shadow) visibleHow = 'box-shadow';
    else if (virtual === null && !focusVisibleMatches) visibleHow = 'not :focus-visible';
    const visible = visibleHow !== 'none' && visibleHow !== 'not :focus-visible';

    const scrolledBy = (el: Element, axis: 'scrollTop' | 'scrollLeft'): number => {
      let total = 0;
      for (let p = el.parentElement; p !== null; p = p.parentElement) {
        if (p !== document.body && p !== document.documentElement) total += p[axis];
      }
      return total;
    };

    const rect = subject.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const inViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < vh &&
      rect.left < vw;

    // What is drawn over it: sample the centre and four points inset by a quarter of the part of the element that
    // is on screen (a panel taller than the viewport is judged where it is visible, not where it ends).
    const seen = {
      left: Math.max(rect.left, 0),
      top: Math.max(rect.top, 0),
      right: Math.min(rect.right, vw),
      bottom: Math.min(rect.bottom, vh),
    };
    const seenW = seen.right - seen.left;
    const seenH = seen.bottom - seen.top;
    const points: Array<[number, number]> = [
      [seen.left + seenW / 2, seen.top + seenH / 2],
      [seen.left + seenW * 0.25, seen.top + seenH * 0.25],
      [seen.left + seenW * 0.75, seen.top + seenH * 0.25],
      [seen.left + seenW * 0.25, seen.top + seenH * 0.75],
      [seen.left + seenW * 0.75, seen.top + seenH * 0.75],
    ];
    let obscuredBy: string | null = null;
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= vw || y >= vh) {
        obscuredBy = 'outside the viewport';
        break;
      }
      const hit = document.elementFromPoint(x, y);
      if (hit === null) continue;
      const related =
        subject.contains(hit) ||
        hit.contains(subject) ||
        // a label or wrapper that belongs to the same control
        (subject.closest('label, [role="row"], li, tr') ?? subject).contains(hit);
      if (!related) {
        obscuredBy = describe(hit);
        break;
      }
    }

    const region =
      subject.closest('[role="dialog"], [role="alertdialog"], [role="listbox"]') !== null
        ? 'dialog'
        : subject.closest('aside') !== null
          ? 'aside'
          : subject.closest('header') !== null
            ? 'header'
            : subject.closest('main') !== null
              ? 'main'
              : subject.closest('nav') !== null
                ? 'nav'
                : 'page';

    return {
      name: labelOf(subject).slice(0, 80),
      role: subject.getAttribute('role') ?? '',
      tag: subject.tagName.toLowerCase(),
      type: subject instanceof HTMLInputElement ? subject.type : '',
      region,
      // Position in the content, not the viewport: the page and `main` scroll as focus moves.
      top: rect.top + scrolledBy(subject, 'scrollTop') + window.scrollY,
      left: rect.left + scrolledBy(subject, 'scrollLeft') + window.scrollX,
      height: rect.height,
      width: rect.width,
      visible,
      visibleHow,
      inViewport,
      obscuredBy,
    };
  });
}

/** A journey: the page, its name, and every stop recorded so far. */
export class Journey {
  readonly stops: Stop[] = [];
  readonly page: Page;
  readonly name: string;
  constructor(page: Page, name: string) {
    this.page = page;
    this.name = name;
  }

  /** Asserts 2.4.7 and 2.4.11 for where focus is now, records the stop, and returns it. */
  async check(step: string): Promise<Stop> {
    // A focus ring and the scroll that reveals it settle a frame after the key.
    await this.page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    );
    const report = await readFocus(this.page);
    expect(
      report,
      `${this.name} — ${step}: focus is on nothing (the document body)`,
    ).not.toBeNull();
    const focus = report as FocusReport;
    const where = `${this.name} — ${step}: "${focus.name}" (${focus.tag}${focus.role === '' ? '' : ` role=${focus.role}`})`;
    expect(focus.visible, `${where} shows no focus indicator (2.4.7): ${focus.visibleHow}`).toBe(
      true,
    );
    expect(focus.inViewport, `${where} is outside the viewport (2.4.11)`).toBe(true);
    expect(
      focus.obscuredBy,
      `${where} is covered by ${String(focus.obscuredBy)} (2.4.11)`,
    ).toBeNull();
    this.stops.push(focus);
    return focus;
  }

  /** One key, then the stop's checks. */
  async press(key: string, step: string): Promise<Stop> {
    await this.page.keyboard.press(key);
    return this.check(step);
  }

  /** Types into the focused field (no pointer), without judging focus again. */
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 15 });
  }

  /**
   * Tabs (or Shift+Tabs) until the focused element's accessible name matches, checking every stop on the way.
   * Fails if it takes more than `max` presses: a control a keyboard user cannot reach in a sensible number of
   * stops is a finding.
   */
  async tabTo(
    match: RegExp,
    options: { backwards?: boolean; max?: number; type?: string } = {},
  ): Promise<Stop> {
    const max = options.max ?? 60;
    const key = options.backwards === true ? 'Shift+Tab' : 'Tab';
    const visited: string[] = [];
    for (let n = 0; n < max; n += 1) {
      const stop = await this.press(key, `${key} #${String(n + 1)} towards ${String(match)}`);
      if (match.test(stop.name) && (options.type === undefined || stop.type === options.type)) {
        return stop;
      }
      visited.push(stop.name);
    }
    throw new Error(
      `${this.name}: no stop matching ${String(match)} in ${String(max)} ${key} presses; visited: ${visited.join(' | ')}`,
    );
  }

  /**
   * Tab from wherever focus is until it wraps (back to the first stop) or leaves the page, up to `max` stops,
   * judging every stop. Returns the stops in order.
   */
  async walk(max: number): Promise<Stop[]> {
    const walked: Stop[] = [];
    const first = (await readFocus(this.page)) === null ? null : await this.focusedName();
    for (let n = 0; n < max; n += 1) {
      await this.page.keyboard.press('Tab');
      await this.page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => done())),
      );
      const report = await readFocus(this.page);
      if (report === null) break; // focus left the document (to the browser's own chrome)
      if (first !== null && n > 0 && report.name === first && walked.length > 2) break;
      walked.push(await this.check(`Tab #${String(n + 1)}`));
    }
    return walked;
  }

  /** The focused element's name now (for assertions about where focus came back to). */
  async focusedName(): Promise<string> {
    const report = await readFocus(this.page);
    return report?.name ?? '';
  }

  /** Asserts focus is on a control whose name matches — the "focus returns to the trigger" check (2.4.3). */
  async expectFocus(match: RegExp, why: string): Promise<void> {
    await expect
      .poll(async () => this.focusedName(), { message: `${this.name}: ${why}`, timeout: 4_000 })
      .toMatch(match);
    await this.check(why);
  }

  /** Waits for animations to finish so a ring is judged where it settles. */
  async settle(): Promise<void> {
    await this.page.waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) => animation.effect?.getComputedTiming().iterations === Infinity),
      undefined,
      { timeout: 5_000 },
    );
  }
}

/**
 * 2.4.3 Focus Order: within a region, the stops go down the page. A stop may sit beside the previous one (the
 * same row, left to right) but may not jump back up past its top edge; and focus does not return to a
 * region it already left (sidebar → header → main, never back to the sidebar mid-page). Consecutive stops on
 * the same element are ignored.
 */
export function assertReadingOrder(journeyName: string, stops: readonly Stop[]): void {
  const SLACK = 16;
  const left: string[] = [];
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1] as Stop;
    const next = stops[i] as Stop;
    if (prev.region !== next.region) {
      left.push(prev.region);
      expect(
        left.includes(next.region),
        `${journeyName}: focus went back to the ${next.region} after leaving it ("${prev.name}" → "${next.name}") — 2.4.3`,
      ).toBe(false);
      continue;
    }
    if (prev.region === 'dialog') continue; // a dialog's stops are its own order; they are checked by name in the journeys
    // "Up" means the next stop lies wholly above the previous one's top edge: a stop beside it, or one whose box
    // overlaps it (a panel and the scroll region inside it, two sliders in a row whose labels differ in height),
    // is the same line of the page.
    const nextBottom = next.top + next.height;
    expect(
      nextBottom >= prev.top - SLACK,
      `${journeyName}: focus jumped up the ${next.region} ("${prev.name}" at y=${String(Math.round(prev.top))} → "${next.name}" ending at y=${String(Math.round(nextBottom))}) — 2.4.3`,
    ).toBe(true);
  }
}
