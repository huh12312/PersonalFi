// SPDX-License-Identifier: MIT
/**
 * `scripts/categorization-learn-backfill.ts` — replay standing category picks
 * into the learning path (WP 11.2), from the host.
 *
 *     node scripts/categorization-learn-backfill.ts --holder=Chris [--json]
 *
 * A thin entry point: the program is `apps/api/src/bin/categorization-learn-backfill.ts`,
 * the copy the api image ships. Idempotent; see that file's header.
 */
await import('../apps/api/src/bin/categorization-learn-backfill.ts');
