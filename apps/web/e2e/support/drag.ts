// SPDX-License-Identifier: MIT
import type { Locator, Page } from '@playwright/test';

/**
 * A real pointer drag from one locator's centre towards an x offset, clamped
 * inside a second locator's box — `steps` intermediate `pointermove`s so a
 * component's own drag handling (`onValueChange` while dragging vs
 * `onValueCommitted` on release) fires the way an actual user's drag would,
 * never a single teleporting jump. Does not call `mouse.up()` — the caller
 * decides when to release, since a caller that wants to assert something
 * mid-drag and a caller that wants the committed value need different
 * moments.
 *
 * **Scrolls the handle into view first, then measures.** wp4.11 §7's carried
 * finding (`docs/plan/05-phase-5-dispatch.md` §2): a drag handle below the
 * fold has no on-screen point, and `elementFromPoint` (so CDP's
 * coordinate-based mouse dispatch) returns nothing for an off-screen point —
 * `page.mouse.down()` at the handle's *unscrolled* `boundingBox()`
 * coordinates fires a `pointerdown` that bubbles to `window` but never
 * reaches the component's own `onPointerDown` handler, silently dropping the
 * whole gesture with no error and no timeout. Confirmed empirically against
 * WP 4.11's Base UI slider (`docs/evidence/phase-5/wp5.14-quality.md`).
 * Every drag in this repo goes through this function so that lesson is paid
 * for once rather than rediscovered by the next spec that needs one.
 */
export async function dragFromTo(
  page: Page,
  handle: Locator,
  bounds: Locator,
  options: { readonly dx: number; readonly steps?: number },
): Promise<void> {
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const boundsBox = await bounds.boundingBox();
  if (handleBox === null || boundsBox === null) {
    throw new Error('dragFromTo: the handle or its bounds has no layout box to drag from');
  }
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const maxX = boundsBox.x + boundsBox.width - 4;
  const minX = boundsBox.x + 4;
  const targetX = Math.max(minX, Math.min(maxX, startX + options.dx));

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(targetX, startY, { steps: options.steps ?? 12 });
}
