#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * WP 9.9: load the scale corpus into the scratch stack `pf-perf` and mint the
 * holder a session, so the curl-through-Caddy pass and the RTO drill run over a
 * 50k-row database that arrived by the real write path.
 *
 *   PF_PERF_DATABASE_URL=postgres://… node scripts/perf/load-scale.ts \
 *       --months 1264 --session-out /tmp/wp99/session.cookie
 *
 * Reaches the stack's Postgres at the db container's bridge address (a Linux
 * host routes to it; nothing is published). The URL carries the scratch stack's
 * own password and is read from the environment, never from an argument.
 *
 * Relative imports on purpose: the repository root has no workspace links, and
 * each package resolves its own dependencies from its own `node_modules`.
 *
 * Refuses any database whose name is not `personalfi` on a host that is not a
 * private bridge address: this script writes 50k rows, so it checks where it is
 * pointed before it does.
 */
import { writeFileSync } from 'node:fs';
import { createDatabase, createPool } from '../../packages/db/src/index.ts';
import { generateDemoData } from '../../packages/seed/src/index.ts';
import { systemClock } from '../../packages/kernel/src/index.ts';
import { loadSeedDataset } from '../../packages/contexts/ledger/src/index.ts';
import { SessionService } from '../../packages/contexts/identity/src/index.ts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const raw = process.env['PF_PERF_DATABASE_URL'];
if (raw === undefined || raw === '') {
  console.error('load-scale: PF_PERF_DATABASE_URL is not set');
  process.exit(2);
}
const url = new URL(raw);
if (!/^(172\.(1[6-9]|2\d|3[01])|10|192\.168)\./.test(url.hostname)) {
  console.error(`load-scale: refusing ${url.hostname}: not a private bridge address`);
  process.exit(2);
}

const months = Number(argument('--months', '1264'));
// `--session-only`: mint a fresh session and load nothing (the idle window of a session is short).
const sessionOnly = process.argv.includes('--session-only');
const sessionOut = argument('--session-out', '');
const pool = createPool({ databaseUrl: raw, max: 4, applicationName: 'wp99-load-scale' });
try {
  const db = createDatabase(pool);
  const holder = await pool.query<{ id: string }>(
    'SELECT id FROM users ORDER BY created_at LIMIT 1',
  );
  const userId = holder.rows[0]?.id;
  if (userId === undefined) throw new Error('no account holder: run `just bootstrap-user` first');

  if (!sessionOnly) {
    const dataset = generateDemoData(1, { monthCount: months });
    const started = performance.now();
    await loadSeedDataset(db, userId, dataset, { clock: systemClock });
    const seconds = (performance.now() - started) / 1_000;
    await pool.query('ANALYZE');
    const counted = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM transactions WHERE user_id = $1 AND removed_at IS NULL',
      [userId],
    );
    console.log(
      `load-scale: ${String(dataset.transactions.length)} rows generated, ${String(counted.rows[0]?.n)} ` +
        `live in the database, loadSeedDataset ${seconds.toFixed(1)} s`,
    );
  }

  if (sessionOut !== '') {
    const sessions = new SessionService({ db: pool, clock: systemClock });
    const issued = await sessions.issue({ userId, authMethod: 'webauthn', fresh: true });
    writeFileSync(sessionOut, `__Host-pfi_session=${issued.accessToken}\n`, { mode: 0o600 });
    console.log(`load-scale: session cookie written to ${sessionOut} (mode 0600)`);
  }
} finally {
  await pool.end();
}
