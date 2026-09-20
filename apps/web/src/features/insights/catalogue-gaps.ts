// SPDX-License-Identifier: MIT
/**
 * A display-only mirror of `packages/contexts/insights/src/advisors/
 * catalogue.ts`'s `CATALOGUE_GAPS` (docs/evidence/phase-2/
 * wp2.7-advisor-catalog.md §1, "the nine that cannot be written from Phase 2
 * data"). That constant lives in `@ctx/insights`, a server-only package
 * (drizzle, node-only imports) with no browser build target and no route
 * that serialises it — `GET /advisors` answers "what is registered", not
 * "what could never be". Importing the context package into this bundle
 * would pull a database driver into the browser for a string table; copying
 * the nine rows here, named and dated to their source, is the honest
 * trade-off. If the catalogue's own gap list changes, this one needs an
 * update too — `catalog.test.ts` on the server side is what keeps *that*
 * list itself exhaustive; nothing here re-derives it.
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
  { id: 'U8', needs: 'a card APR and revolving balance' },
  { id: 'C5', needs: 'a credit limit and statement date' },
  { id: 'C6', needs: 'an APR and revolving balance' },
  { id: 'S1', needs: 'an exact transaction amount and a per-category distribution' },
  { id: 'S5', needs: 'an exact amount and a merchant-first-seen date' },
]);
