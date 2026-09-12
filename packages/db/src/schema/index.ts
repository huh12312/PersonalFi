// SPDX-License-Identifier: MIT
/**
 * `@core/db` owns exactly one table: the migration bookkeeping the runner has to
 * bootstrap before anything else exists.
 *
 * Everything else that used to be described as "platform" — the outbox, the job
 * queue, the scheduler, feature flags — belongs to `@core/platform`, which sits
 * one layer up and may depend on this package. Context tables live in their own
 * context package (`packages/contexts/<name>/schema/`) and are registered with
 * Drizzle by the composition root, never re-exported from here.
 */
export { schemaMigrations, type SchemaMigrationRow } from './schema-migrations.ts';
