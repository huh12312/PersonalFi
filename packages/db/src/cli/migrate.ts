// SPDX-License-Identifier: MIT
/**
 * Migration entry point. `just migrate` and the compose `migrator` one-shot
 * service both run this, so there is one code path that applies a migration.
 */
import { loadConfig, ConfigError } from '@core/config';
import { runMigrations, MigrationError } from '../migrate.ts';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  // CF-18 / G-01 (WP 9.11): the owner's URL when the roles are split; else
  // `database_url`, as before (`migrator_database_url` is optional and empty
  // by default — an empty secret file is absent to @core/config).
  const databaseUrl = (config.secrets.migrator_database_url ?? config.databaseUrl).reveal();
  const result = await runMigrations({ databaseUrl, dryRun });

  if (dryRun) {
    if (result.pending.length === 0) {
      process.stdout.write('no pending migrations\n');
    } else {
      process.stdout.write(`pending: ${result.pending.join(', ')}\n`);
    }
    return;
  }
  process.stdout.write(
    `migrations complete: ${result.applied.length} applied, ${result.alreadyApplied} already present\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof MigrationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
