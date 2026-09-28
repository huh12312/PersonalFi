// SPDX-License-Identifier: MIT
/**
 * The slider preview's capital-market defaults — the same numbers
 * `packages/contexts/planning/data/assumptions.ts` ships as PersonalFi's
 * default assumptions (07 §5.5 and Appendix A), inlined here rather than read
 * from `GET /assumptions` at render time.
 *
 * **Why inlined, not fetched.** `AssumptionsPanel.tsx` already renders the
 * live, possibly-overridden assumptions the *server* projects with — this
 * panel is a client-side, seed-and-all preview that intentionally runs its
 * own local kernel (`../../../workers/kernel/**`, the WP 4.11 scoped port),
 * and D20 already means it can never be more than an approximation of the
 * saved plan. Reading the caller's *overridden* assumptions into a client-side
 * simulation would suggest a precision this preview does not have — the
 * override changes what the *server* projects, not what this quick what-if
 * sandbox previews. Documented here rather than silently guessed, the same
 * pattern `../GoalControls.tsx`'s own header uses for its own scope cut.
 */

/** 07 §5.5 defaults, `data/assumptions.ts`'s `capitalMarket.usEquity`. */
export const DEFAULT_EQUITY_NOMINAL = 0.065;
export const DEFAULT_EQUITY_VOLATILITY = 0.17;

/** `data/assumptions.ts`'s `capitalMarket.usAggregateBonds`. */
export const DEFAULT_BOND_NOMINAL = 0.045;
export const DEFAULT_BOND_VOLATILITY = 0.06;

/** `data/assumptions.ts`'s `capitalMarket.inflation`. */
export const DEFAULT_INFLATION = 0.025;
export const DEFAULT_INFLATION_VOLATILITY = 0.015;

/** `data/assumptions.ts`'s `capitalMarket.wageGrowth.spreadOverInflation` — `contributionGrowth: 'wage'`. */
export const DEFAULT_WAGE_GROWTH_SPREAD = 0.005;

/**
 * `data/assumptions.ts`'s `correlation` block, verbatim (assets and matrix
 * together — the kernel's `reorderCorrelation` looks each asset up by name,
 * so this can carry the source file's own row order unchanged; no manual
 * reordering here to get wrong).
 */
export const DEFAULT_CORRELATION_ASSETS = [
  'USEQ',
  'INTL',
  'EM',
  'BOND',
  'TIPS',
  'REIT',
  'CASH',
  'CRYPTO',
] as const;

export const DEFAULT_CORRELATION_MATRIX: readonly (readonly number[])[] = [
  [1, 0.85, 0.75, 0.1, 0, 0.7, -0.05, 0.4],
  [0.85, 1, 0.85, 0.1, 0.05, 0.65, -0.05, 0.35],
  [0.75, 0.85, 1, 0.05, 0.05, 0.6, -0.05, 0.4],
  [0.1, 0.1, 0.05, 1, 0.7, 0.25, 0.2, 0.05],
  [0, 0.05, 0.05, 0.7, 1, 0.25, 0.25, 0.05],
  [0.7, 0.65, 0.6, 0.25, 0.25, 1, 0, 0.3],
  [-0.05, -0.05, -0.05, 0.2, 0.25, 0, 1, 0],
  [0.4, 0.35, 0.4, 0.05, 0.05, 0.3, 0, 1],
];

/** No lever the sliders panel exposes touches this — a fixed, documented scope cut. */
export const DEFAULT_TAX_DEFERRED_RATE = 0.15;

export const PREVIEW_PATHS = 250;
export const REFINE_PATHS = 5_000;

/** 300ms — dispatch §3's own number for the server-fallback debounce. */
export const FALLBACK_DEBOUNCE_MS = 300;
