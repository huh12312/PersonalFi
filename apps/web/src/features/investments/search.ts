// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * URL search state for `/investments` (`src/routes/_app.investments.tsx`'s
 * `validateSearch`).
 *
 * Every piece of screen state a reader could want to link to lives here and
 * nowhere else — the selected tab, the expanded account, the allocation
 * dimension and the valuation basis — so a drift view or one account's lots
 * is a URL somebody can paste, and a browser Back button undoes a tab change
 * rather than leaving the screen. `basis` and `dimension` deliberately reuse
 * the wire vocabulary of `GET /investments/allocation`
 * (`AllocationReport.basis`, `AllocationReport.dimension`) rather than a
 * second UI-side spelling, so the mapping into the query is an identity.
 */
export const investmentsSearchSchema = z.object({
  tab: z.enum(['holdings', 'allocation', 'drift', 'performance']).optional(),
  /** The account whose per-account detail (lots, basis source) is open. */
  account: z.string().min(1).optional(),
  dimension: z.enum(['asset_class', 'region', 'sector']).optional(),
  basis: z.enum(['as_of_now', 'last_known']).optional(),
  /**
   * `?target=US_EQUITY:0.6` — repeated. `GET /investments/drift` takes its
   * targets in the query because there is no `allocation_targets` table
   * (`docs/evidence/phase-3/wp3.9-routes.md` §8 item 1), so the URL is
   * literally where a target set lives today.
   */
  target: z.array(z.string()).optional(),
  /** Performance window start, `YYYY-MM-DD`; `GET /investments/performance` requires it. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type InvestmentsSearch = z.infer<typeof investmentsSearchSchema>;

export type InvestmentsTab = NonNullable<InvestmentsSearch['tab']>;
export type AllocationDimension = NonNullable<InvestmentsSearch['dimension']>;
export type ValuationBasis = NonNullable<InvestmentsSearch['basis']>;

export const DEFAULT_TAB: InvestmentsTab = 'holdings';
export const DEFAULT_DIMENSION: AllocationDimension = 'asset_class';
export const DEFAULT_BASIS: ValuationBasis = 'as_of_now';

/**
 * A one-year performance window ending today, as the default `from`.
 *
 * Pure date arithmetic on a caller-supplied "today" — never `new Date()`
 * inside a render — so a test and a Playwright screenshot can pin it.
 */
export function defaultPerformanceFrom(today: Date): string {
  const from = new Date(
    Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()),
  );
  return from.toISOString().slice(0, 10);
}
