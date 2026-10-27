// SPDX-License-Identifier: MIT
/**
 * `just categorization-eval holder=<name or id>` — the gold-set replay (WP 11.1).
 *
 * Replays the holder's **hand-filed** transactions (the categories they picked —
 * the ledger overlay — and any confirmed assignments) through `decide()`, leaving
 * one transaction out at a time and then one merchant out at a time, and prints
 * per-tier and overall precision, recall, abstain rate and the top ten
 * confusion pairs (`@ctx/categorization`'s `replayGoldSet`). The figure WP 11.2
 * gates its model suggestions on (≥ 85 % precision) is read from this output,
 * so its shape is versioned (`categorization-eval/1`) and stable.
 *
 *     node apps/api/src/bin/categorization-eval.ts --holder=Chris          # text tables
 *     node apps/api/src/bin/categorization-eval.ts --holder=Chris --json   # one JSON document
 *
 * ## It never writes
 *
 * Every connection this process opens starts with
 * `default_transaction_read_only = on`, so a write anywhere on the path — the
 * loader, the ledger port, a future change to either — is refused by Postgres
 * rather than trusted not to happen. Nothing here calls a model or the network.
 *
 * It prints counts, ratios and category keys; never a payee, a descriptor, an
 * amount or a transaction id (the confusion pairs are category keys only).
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { systemClock } from '@core/kernel';
import {
  formatReplayReport,
  loadGoldSet,
  replayGoldSet,
  type CategorizationExecutor,
  type ReplayReport,
} from '@ctx/categorization';
import type { LedgerDatabase } from '@ctx/ledger';
import { createCategorizationLedgerPort } from '../domain.ts';

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** The output document. `schema` matches `EVAL_SCHEMA`; 11.2 parses both. */
interface CategorizationEvalOutput {
  readonly schema: 'categorization-eval/1';
  readonly examples: number;
  readonly rules: number;
  readonly lockedMerchants: number;
  /** Where the answers came from: the ledger overlay, or a confirmed assignment alone. */
  readonly fromOverlay: number;
  readonly fromConfirmed: number;
  readonly missingTransactions: number;
  readonly transaction: ReplayReport;
  readonly merchant: ReplayReport;
}

/**
 * The login URL with every transaction read-only.
 *
 * Not the app role (`appRoleDatabaseUrl`): that role's grants are re-asserted
 * by `ensureAppRole` at api/worker boot, which is a write this program must not
 * make, and a read-only session is the stronger guarantee for a program whose
 * promise is that it writes nothing — the app role could still write rows.
 */
function readOnlyDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get('options') ?? '';
  url.searchParams.set('options', `${options} -c default_transaction_read_only=on`.trim());
  return url.toString();
}

const { values } = parseArgs({
  options: {
    holder: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
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
  databaseUrl: readOnlyDatabaseUrl(config.databaseUrl.reveal()),
  max: 2,
  applicationName: 'personalfi-categorization-eval',
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
        : 'more than one account holder: name one, e.g. `just categorization-eval holder="Chris"`.',
    );
  }
  const holder = users.rows[0] as { id: string; display_name: string };

  const port = createCategorizationLedgerPort(database as unknown as LedgerDatabase, systemClock);
  const loaded = await loadGoldSet(database as unknown as CategorizationExecutor, port, holder.id);
  const options = { rules: loaded.rules, lockedMerchantDefaults: loaded.lockedMerchantDefaults };
  const output: CategorizationEvalOutput = {
    schema: 'categorization-eval/1',
    examples: loaded.examples.length,
    rules: loaded.rules.length,
    lockedMerchants: loaded.lockedMerchantDefaults.size,
    fromOverlay: loaded.fromOverlay,
    fromConfirmed: loaded.fromConfirmed,
    missingTransactions: loaded.missingTransactions,
    transaction: replayGoldSet(loaded.examples, { ...options, holdout: 'transaction' }),
    merchant: replayGoldSet(loaded.examples, { ...options, holdout: 'merchant' }),
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `holder    ${holder.display_name}`,
        `gold set  ${String(output.examples)} hand-filed transactions (${String(output.fromOverlay)} from ` +
          `your edits, ${String(output.fromConfirmed)} from confirmations), ${String(output.rules)} rules, ` +
          `${String(output.lockedMerchants)} locked merchants` +
          (output.missingTransactions === 0
            ? ''
            : `, ${String(output.missingTransactions)} confirmations whose transaction is gone`),
        '',
        formatReplayReport(output.transaction),
        '',
        formatReplayReport(output.merchant),
        '',
      ].join('\n'),
    );
  }
  if (output.examples === 0) {
    process.stderr.write(
      'no hand-filed transactions yet: pick some categories in the Inbox first.\n',
    );
  }
} finally {
  await pool.end();
}
