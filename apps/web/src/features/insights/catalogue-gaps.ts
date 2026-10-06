// SPDX-License-Identifier: MIT
/**
 * A display-only mirror of `packages/contexts/insights/src/advisors/
 * catalogue.ts`'s `CATALOGUE_GAPS` (first written from docs/evidence/phase-2/
 * wp2.7-advisor-catalog.md §1, since extended with Phase 3 and 4's gaps). That
 * constant lives in `@ctx/insights`, a server-only package (drizzle, node-only
 * imports) with no browser build target and no route that serialises it — `GET /advisors` answers "what is registered", not
 * "what could never be". Importing the context package into this bundle
 * would pull a database driver into the browser for a string table; copying
 * the rows here is the honest trade-off. S1 and S5 were released by WP 5.7 and
 * were still listed here at the Phase 5 gate (G5-4): nothing kept the two in
 * step. `packages/contexts/insights/test/catalogue-gaps-mirror.test.ts` now
 * fails when the id sets differ, so the next release or new gap cannot go stale
 * here silently. The wording below stays this file's own.
 */
export interface CatalogueGap {
  readonly id: string;
  readonly needs: string;
}

export const CATALOGUE_GAPS: readonly CatalogueGap[] = Object.freeze([
  { id: 'U1', needs: 'a user declaration that a subscription is unused' },
  { id: 'U4', needs: 'a vendor plan price table' },
  { id: 'U5', needs: 'trial-watch state (a trial start or end date)' },
  { id: 'U6', needs: "a user 'cancelling' flag on a stream" },
  { id: 'U8', needs: 'a way to tell which card a recurring charge is billed to' },
  { id: 'C5', needs: 'to be written: the credit limit and statement balance exist' },
  { id: 'C6', needs: 'to be written: the cash and the revolving balance both exist' },
  { id: 'I7', needs: 'disposals across every account, including IRAs' },
  { id: 'I8', needs: 'year-to-date payroll deferrals and the plan’s match formula' },
  { id: 'I9', needs: 'contributions to date and an income test' },
  { id: 'I10', needs: 'an HSA-eligible plan flag and contributions to date' },
  { id: 'X4', needs: 'staking receipts: when each arrived and its value then' },
  { id: 'R5', needs: 'year-to-date deferrals, payroll cadence and the plan’s true-up terms' },
]);
