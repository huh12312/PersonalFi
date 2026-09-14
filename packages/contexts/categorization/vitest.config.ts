// SPDX-License-Identifier: MIT
/**
 * A package-local config, for running this context's suites on their own.
 *
 * The repo's real config is the root `vitest.config.ts`, one project per package
 * (docs/TESTING.md), and this context needs two entries added there —
 * `categorization` and `categorization-db` — exactly like `ledger` and
 * `ledger-db`. WP 1.4 does not own that file (WP 1.3 is appending to it
 * concurrently and two agents editing one array is a guaranteed conflict), so the
 * entries are proposed in `docs/evidence/phase-1/wp1.4-categorization.md` and
 * this file exists so the suites can be run and reviewed in the meantime:
 *
 *     pnpm exec vitest run --config packages/contexts/categorization/vitest.config.ts
 *
 * It is **not** picked up by the root config: a `projects` entry that supplies an
 * inline `test` block uses that block, not a config file discovered under its
 * `root`. Once the two entries land upstream this file can be deleted, and the
 * evidence doc says so.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        root: import.meta.dirname,
        test: { name: 'categorization', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // Every claim in these suites is a claim about Postgres: the partial
        // unique index that keeps exactly one current assignment per
        // transaction, `ON CONFLICT` making the taxonomy seed idempotent, a
        // consumer offset advancing in the same transaction as the rows it
        // wrote. Skips itself when DATABASE_URL is unset.
        root: import.meta.dirname,
        test: {
          name: 'categorization-db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
