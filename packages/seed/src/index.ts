// SPDX-License-Identifier: MIT
/**
 * `@core/seed` — the deterministic demo-seed generator.
 *
 * `generateDemoData(seed)` produces 24 months of realistic, in-memory history
 * for one household: accounts, merchants with statement-descriptor noise,
 * transactions (pending -> posted, recurring series, transfers, refunds),
 * and investment holdings/prices — plus the ground-truth labels a detection
 * algorithm's golden tests are graded against. See `src/types.ts` for why the
 * output is plain data rather than Drizzle tables, and `OWNERSHIP.md`.
 */
export { generateDemoData, type GenerateOptions } from './generate.ts';
export { writeJson } from './write-json.ts';
export { computeStats, formatStats, type SeedStats } from './stats.ts';
export { mulberry32, type Rng } from './prng.ts';
export * from './types.ts';
/**
 * WP 2.12: standalone, additive scenario fixtures a Phase 2 engine can load
 * on top of (never instead of) `generateDemoData`'s pinned default output —
 * see `phase2-scenarios.ts`'s own header for why these are separate rather
 * than folded into the main household.
 */
export {
  generateCardMigration,
  generateCreditOverspend,
  generateDuplicateService,
  type CardMigrationScenario,
  type CreditOverspendScenario,
  type DuplicateServiceScenario,
} from './phase2-scenarios.ts';
/**
 * WP 3.14: the investments dataset, additive in exactly the same way and for
 * the same reason — securities, holdings, lots **with the ground truth a basis
 * engine is graded against**, investment transactions, a price series, an FX
 * series with one deliberate gap, a non-USD account, a manual asset and a
 * liability. See `phase3-investments.ts`'s header for why it is not folded
 * into `generateDemoData`.
 */
export * from './phase3-investments.ts';
/**
 * WP 4.13: the Phase 4 **scale** seed — 200 positions across four tax
 * buckets, five years of daily prices/holdings-snapshots/net-worth, a
 * multi-currency account with an FX series, and a plan with goals,
 * contributions and life events. `generatePhase3Investments` above is the
 * correctness seed and stays byte-identical; this is a second, additive
 * dataset for the 800 ms / 150 ms perf budgets (08 §7.1–7.2). See
 * `phase4-scale.ts`'s own header.
 */
export * from './phase4-scale.ts';
