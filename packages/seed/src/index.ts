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
