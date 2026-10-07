// SPDX-License-Identifier: MIT
/**
 * `just consumer-resume <name>` — put a dead-lettered (or paused) event
 * consumer back to `running` (WP 9.11, G-23 / F-94-5).
 *
 * When a consumer fails the same event `maxAttempts` times the pump stops it
 * (`status = 'failed'`) and `/ready` reads `degraded`, naming it in
 * `outbox.failedConsumers`. Fix the cause first (the error is printed below);
 * then this resumes the consumer, which retries the same event — nothing is
 * skipped. `@core/platform`'s `resumeConsumer` does the work; this is only the
 * composition (config, the app-role pool) and the words.
 *
 * Exit codes: 0 resumed or already running, 1 unknown consumer, 78 config.
 */
import { ConfigError, loadConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { platformExecutor, resumeConsumer } from '@core/platform';
import { appRoleDatabaseUrl, ensureAppRole } from '../db-role.ts';

const name = (process.argv[2] ?? '').trim();
if (name.length === 0) {
  process.stderr.write(
    'usage: consumer-resume <consumer name>, e.g. budgeting.actuals@v1 ' +
      '(the names /ready lists under outbox.failedConsumers)\n',
  );
  process.exit(1);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78);
    }
    throw error;
  }
})();

const appRole = await ensureAppRole(config.databaseUrl.reveal());
if (!appRole.ok) {
  process.stderr.write(`could not ensure the database app role: ${appRole.error}\n`);
  process.exit(1);
}
const pool = createPool({
  databaseUrl: appRoleDatabaseUrl(config.databaseUrl.reveal()),
  max: 1,
  applicationName: 'personalfi-consumer-resume',
});
try {
  const outcome = await resumeConsumer(platformExecutor(createDatabase(pool)), name);
  switch (outcome.kind) {
    case 'unknown_consumer':
      process.stderr.write(`no consumer named ${JSON.stringify(name)}\n`);
      process.exitCode = 1;
      break;
    case 'already_running':
      process.stdout.write(`${name} is already running (at event ${outcome.lastSeq})\n`);
      break;
    case 'resumed':
      process.stdout.write(
        `${name} resumed (was ${outcome.previousStatus}, at event ${outcome.lastSeq}).\n` +
          (outcome.failedSeq === null
            ? ''
            : `It stopped on event ${outcome.failedSeq}: ${outcome.failedError ?? '(no error recorded)'}\n` +
              'The worker retries that event next; if the cause is still there it will stop ' +
              'again after five attempts.\n'),
      );
      break;
  }
} finally {
  await pool.end();
}
