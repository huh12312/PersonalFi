// SPDX-License-Identifier: MIT
/**
 * `scripts/categorization-eval.ts` — the gold-set replay (WP 11.1), from the host.
 *
 *     node scripts/categorization-eval.ts --holder=Chris [--json]
 *
 * A thin entry point: the program is `apps/api/src/bin/categorization-eval.ts`,
 * which is the copy the api image ships, so `just categorization-eval` runs the
 * same code inside the stack (one-shot container) or against the local dev
 * database. Read-only; see that file's header.
 */
await import('../apps/api/src/bin/categorization-eval.ts');
