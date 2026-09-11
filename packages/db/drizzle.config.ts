// SPDX-License-Identifier: MIT
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used for *introspection and diffing only*. Migrations are
 * hand-written SQL under `migrations/`, applied by our own runner: generated DDL
 * is fine for greenfield tables and quietly wrong for the expand → backfill →
 * contract sequence every destructive change here has to use.
 *
 * `just migrate-check` diffs the Drizzle model against the live database; a
 * difference means a migration is missing, not that one should be generated.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/index.ts', '../contexts/*/schema/index.ts'],
  out: './.drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/personalfi_dev',
  },
  strict: true,
  verbose: true,
});
