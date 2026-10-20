// SPDX-License-Identifier: MIT
/**
 * `just genai-selftest holder=<name or id>` — the GenAI controls self-test
 * from the host, without a browser (WP 10.16; RUNBOOK "Proving the GenAI
 * controls").
 *
 * The same catalogue, the same ports and the same row as Settings, Language
 * model, **Run control checks** (`../control-checks.ts`): the api's half runs
 * here, in a one-shot container built from the api service's own definition
 * (as `just bootstrap-user` runs — it derives the KEK, so it gets its own
 * cgroup rather than the running api's), and the worker's half is handed to
 * the running worker through the job queue (`insights.control_checks`),
 * exactly as the button does. No ops route takes an operator token, so the
 * recipe composes the run directly rather than calling the api over HTTP.
 * It prints the same table in text and writes the same dated row the
 * dashboard reads. The 10-minute window applies here too.
 *
 * Exit codes: 0 pass, 2 partial (a check could not run), 1 fail or refused,
 * 78 config.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { newId, systemClock } from '@core/kernel';
import { SecretBox, isSecretBoxError } from '@core/secretbox';
import { withKekDerivationLock } from '@ctx/identity';
import {
  CONTROL_CHECKS_MIN_INTERVAL_MS,
  listControlCheckRuns,
  runControlChecks,
  startControlCheckRun,
  type InsightsContext,
} from '@ctx/insights';
import {
  apiCheckPorts,
  exitCodeOf,
  formatControlCheckRun,
  queueHandoff,
} from '../control-checks.ts';
import { appRoleDatabaseUrl, ensureAppRole } from '../db-role.ts';
import { createPreviewModel } from '../modules.ts';
import { createNarratorStores } from '../narrator-stores.ts';
import { createNarratorRuntime } from '../narrator-wiring.ts';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    holder: { type: 'string' },
    'prove-switch': { type: 'boolean', default: false },
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

const appRole = await ensureAppRole(config.databaseUrl.reveal());
if (!appRole.ok) fail(`could not ensure the database app role: ${appRole.error}`);
const pool = createPool({
  databaseUrl: appRoleDatabaseUrl(config.databaseUrl.reveal()),
  max: 4,
  applicationName: 'personalfi-genai-selftest',
});
const database = createDatabase(pool);

let secretBox: SecretBox | undefined;
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
        : 'more than one account holder: name one, e.g. `just genai-selftest holder="Chris"`.',
    );
  }
  const holder = users.rows[0] as { id: string; display_name: string };
  out(`holder    ${holder.display_name} (${holder.id})`);

  const [latest] = await listControlCheckRuns(database, holder.id, 1);
  if (
    latest !== undefined &&
    latest.startedAt.getTime() + CONTROL_CHECKS_MIN_INTERVAL_MS > systemClock.nowMs()
  ) {
    fail(`the controls were checked at ${latest.startedAt.toISOString()}; one run per 10 minutes.`);
  }

  // The preview runtime resolves the holder's narrator as the api does; a
  // stored key is opened only to know the provider is ready — this process
  // never calls a model (every transport the preview runtime builds rejects).
  const passphrase = config.secrets.master_key;
  if (passphrase !== undefined) {
    out('deriving the key-encryption key (argon2id); this takes a few seconds…');
    const box = new SecretBox({
      db: pool,
      userId: holder.id,
      clock: systemClock,
      kdfParams: config.kek.params,
      kdfFloor: config.kek.floor,
    });
    try {
      const { result: state } = await withKekDerivationLock(pool, () =>
        box.unlock(passphrase.reveal()),
      );
      if (state.state === 'unlocked') secretBox = box;
      else box.destroy();
    } catch (error) {
      if (isSecretBoxError(error)) fail(`key custody: ${error.message}`);
      throw error;
    }
  }
  const runtime = createNarratorRuntime({
    mode: 'preview',
    stores: createNarratorStores({ database, secretBox: () => secretBox }),
    localModel: undefined,
    localModelPin: config.localModelPin,
    timeoutMs: config.env.LOCAL_MODEL_TIMEOUT_MS,
    allowRemote: config.env.LOCAL_MODEL_ALLOW_REMOTE,
    fileKeys: {
      openai: config.secrets.openai_api_key,
      openrouter: config.secrets.openrouter_api_key,
      anthropic: config.secrets.anthropic_api_key,
    },
    clock: systemClock,
  });
  const resolution = await runtime.resolve(holder.id);
  const context: InsightsContext = {
    userId: holder.id,
    clock: systemClock,
    correlationId: newId(),
    causationId: null,
  };
  const run = await startControlCheckRun(database, context, {
    provider: resolution.provider,
    model: resolution.narrator?.label ?? null,
  });
  out(`run       ${run.id} (the worker runs the checks that need the model; up to 5 minutes)`);
  const ports = await apiCheckPorts(
    {
      database,
      pool,
      clock: systemClock,
      config,
      runtime,
      preview: createPreviewModel(config.localModelPin),
    },
    context,
  );
  const finished = await runControlChecks({
    database,
    context,
    runId: run.id,
    ports,
    handoff: queueHandoff(database, context),
    proveSwitch: values['prove-switch'] === true,
  });
  if (finished === null) fail('the run row disappeared.');
  out('');
  process.stdout.write(formatControlCheckRun(finished));
  process.exitCode = exitCodeOf(finished.overall);
} finally {
  secretBox?.destroy();
  await pool.end();
}
