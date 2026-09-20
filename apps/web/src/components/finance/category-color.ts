// SPDX-License-Identifier: MIT

/**
 * Categorical colour for a category/merchant band in a chart
 * (05-frontend-architecture.md §2.2 "Categorical series"): eight fixed,
 * CVD-validated hues (`--series-1`..`--series-8` in `src/styles/theme.css`),
 * never a generated/cycled hue, `null`/uncategorised always the neutral tone.
 *
 * The memo's own design ("Category colour is assigned by category ID via a
 * stable hash into the slot order, **persisted server-side**") assumes a
 * server-side slot assignment that does not exist yet — no response in
 * `wp2.8-reports.md`'s report shapes carries a colour or slot field. This is
 * the client-local stand-in: a stable (same id → same slot, every render,
 * every session) hash into the same 8-slot order the memo specifies, so at
 * least the *within-chart* and *across-screens-in-one-session* consistency
 * the memo cares about holds, even without cross-session persistence or a
 * global collision guarantee (two categories can land on the same slot).
 * Flagged in `docs/evidence/phase-2/wp2.9-budget-ui.md` as an open item for
 * whoever adds server-side slot assignment.
 */
const SERIES_SLOTS = 8;

export function categorySeriesVar(categoryId: string | null): string {
  if (categoryId === null || categoryId === '') return 'var(--money-neutral)';
  let hash = 0;
  for (let i = 0; i < categoryId.length; i += 1) {
    hash = (Math.imul(hash, 31) + categoryId.charCodeAt(i)) >>> 0;
  }
  const slot = (hash % SERIES_SLOTS) + 1;
  return `var(--series-${String(slot)})`;
}
