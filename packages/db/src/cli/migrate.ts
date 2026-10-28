// SPDX-License-Identifier: MIT
/**
 * Migration entry point. `just migrate` and the compose `migrator` one-shot
 * service both run this, so there is one code path that applies a migration.
 */
import { loadConfig, ConfigError } from '@core/config';
import { runMigrations, MigrationError, type RestampRequest } from '../migrate.ts';

/** `--restamp 0045=48a0357c1375`, repeatable: an operator vouching for a comment-only file change. */
function restampArgs(argv: readonly string[]): RestampRequest[] {
  const out: RestampRequest[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--restamp') continue;
    const value = argv[i + 1];
    const match = value === undefined ? null : /^(\d{4})=([0-9a-f]{12,64})$/u.exec(value);
    if (match === null) {
      throw new MigrationError(
        'migration.restamp_invalid',
        '--restamp takes <version>=<recorded checksum>, e.g. --restamp 0045=48a0357c1375',
      );
    }
    out.push({ version: match[1]!, previousChecksum: match[2]! });
    i += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const restamp = restampArgs(process.argv);
  const config = loadConfig();
  // CF-18 / G-01 (WP 9.11): the owner's URL when the roles are split; else
  // `database_url`, as before (`migrator_database_url` is optional and empty
  // by default — an empty secret file is absent to @core/config).
  const databaseUrl = (config.secrets.migrator_database_url ?? config.databaseUrl).reveal();
  const result = await runMigrations({ databaseUrl, dryRun, restamp });

  if (result.restamped.length > 0) {
    process.stdout.write(
      `${dryRun ? 'would re-stamp' : 're-stamped'}: ${result.restamped.join(', ')} (SQL not re-run)\n`,
    );
  }
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
