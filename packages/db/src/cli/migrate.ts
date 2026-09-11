// SPDX-License-Identifier: MIT
/**
 * Migration entry point. `just migrate` and the compose `migrator` service both
 * run this; WP 0.4 wires it into the one-shot container.
 */
import { loadConfig, ConfigError } from '@core/config';
import { runMigrations, MigrationError } from '../migrate.ts';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const result = await runMigrations({ databaseUrl: config.databaseUrl.reveal(), dryRun });

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
