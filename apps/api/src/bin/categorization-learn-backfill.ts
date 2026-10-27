// SPDX-License-Identifier: MIT
/**
 * `just categorization-learn-backfill holder=…` (WP 11.2 §1): replay the
 * holder's standing category picks into the learning path, once.
 *
 * Before WP 11.2 a pick went to the ledger overlay only, so `classifier_examples`
 * and the learned merchant defaults never grew on a real install. Picks made
 * from now on teach as they happen (`ledger.TransactionCategoryChosen`); this
 * recipe teaches from the ones already made. It is never run automatically:
 * switching tier 3 and the classifier on for a whole history changes what
 * later syncs categorise, and that is the holder's decision.
 *
 * Idempotent: a pick already learned (the current assignment is a confirmed
 * `user` row for the same category) counts nothing, so a second run prints
 * `learned 0`. Output is counts only — never a payee, an amount or an id.
 * The classifier itself is rebuilt by the weekly retrain (or `retrainClassifier`);
 * the merchant defaults move at once.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { newId, systemClock } from '@core/kernel';
import { backfillLearningFromPicks, type CategorizationDatabase } from '@ctx/categorization';
import type { LedgerDatabase } from '@ctx/ledger';
import { createCategorizationLedgerPort } from '../domain.ts';

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const { values } = parseArgs({
  options: { holder: { type: 'string' }, json: { type: 'boolean', default: false } },
  allowPositionals: false,
});

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message, 78);
    throw error;
  }
})();

const pool = createPool({
  databaseUrl: config.databaseUrl.reveal(),
  max: 2,
  applicationName: 'personalfi-categorization-learn-backfill',
});
const database = createDatabase(pool);

try {
  const wanted = (values.holder ?? '').trim();
  const users = await pool.query<{ id: string; display_name: string }>(
    wanted.length === 0
      ? 'SELECT id, display_name FROM users ORDER BY created_at, id'
      : 'SELECT id, display_name FROM users WHERE id::text = $1 OR display_name = $1 ORDER BY created_at, id',
    wanted.length === 0 ? [] : [wanted],
  );
  if (users.rows.length !== 1) {
    fail(
      users.rows.length === 0
        ? `no account holder ${wanted.length === 0 ? 'exists' : `named ${JSON.stringify(wanted)}`}.`
        : 'more than one account holder: name one, e.g. `just categorization-learn-backfill holder="Chris"`.',
    );
  }
  const holder = users.rows[0] as { id: string; display_name: string };
  const port = createCategorizationLedgerPort(database as unknown as LedgerDatabase, systemClock);
  const result = await backfillLearningFromPicks(
    database as unknown as CategorizationDatabase,
    port,
    { userId: holder.id, clock: systemClock, correlationId: newId() },
  );
  if (values.json === true) {
    process.stdout.write(
      `${JSON.stringify({ schema: 'categorization-learn-backfill/1', ...result })}\n`,
    );
  } else {
    process.stdout.write(
      [
        `holder          ${holder.display_name}`,
        `picks           ${String(result.picks)}`,
        `learned         ${String(result.learned)}`,
        `already learned ${String(result.alreadyLearned)}`,
        `skipped         ${String(result.skipped)} (Uncategorised, or a category you no longer have)`,
        '',
      ].join('\n'),
    );
  }
} finally {
  await pool.end();
}
