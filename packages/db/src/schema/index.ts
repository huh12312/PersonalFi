// SPDX-License-Identifier: MIT
/**
 * Platform-owned tables only. Context tables live in their own context package
 * (`packages/contexts/<name>/schema/`) and are registered with Drizzle by the
 * composition root, never re-exported from here.
 */
export { schemaMigrations, type SchemaMigrationRow } from './schema-migrations.ts';
export { featureFlags, type FeatureFlagRow } from './feature-flags.ts';
