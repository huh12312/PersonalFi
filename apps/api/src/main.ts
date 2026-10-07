// SPDX-License-Identifier: MIT
/**
 * API entry point.
 *
 * Boot order matters and is deliberate: configuration is validated *before* a
 * socket is opened or a connection pool is created, so a misconfigured container
 * fails immediately and loudly instead of at 03:15 during a sync.
 */
import {
  ConfigError,
  assessKekMemory,
  describeConfig,
  describeKekMemory,
  loadConfig,
  readCgroupMemoryLimitBytes,
} from '@core/config';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import { createPool } from '@core/db';
import { recordConfigSnapshot } from '@core/platform';
import { loadAssumptions } from '@ctx/planning';
import { buildApp } from './app.ts';
import { APP_DATABASE_ROLE, appRoleDatabaseUrl, ensureAppRole } from './db-role.ts';
import { buildPlatform } from './platform.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  // `loadAssumptions()` (`@ctx/planning`) is lazy by design — its own doc says
  // the composition root should call it at boot so a malformed 07 §5.5/§6.4/
  // Appendix A file (docs/evidence/phase-4/wp4.2-assumptions.md §9 item 5)
  // refuses to start the process, rather than surfacing as a 500 on whichever
  // request happens to read it first. Unguarded on purpose — a bad file must
  // reach the `catch` below and exit non-zero, not be logged and survived the
  // way the config snapshot a few lines down deliberately is.
  loadAssumptions();

  // CF-18 / G-01 (WP 9.11): every pooled connection starts as the DML-only
  // `personalfi_app` role, never the owner the login may still be; the role
  // and its grants are re-asserted first, because a restore drops both.
  const appRole = await ensureAppRole(config.databaseUrl.reveal());
  const pool = createPool({
    databaseUrl: appRoleDatabaseUrl(config.databaseUrl.reveal()),
    max: config.env.DATABASE_POOL_MAX,
    statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'personalfi-api',
  });

  const platform = buildPlatform({ config, pool });
  const { app, security } = await buildApp({ config, pool, platformDb: platform.db });

  // Recorded at boot, in the log and in `config_snapshots`, so "what changed?"
  // after a behaviour shift is answerable months later rather than argued about.
  // `describeConfig` omits every secret by construction.
  //
  // Deliberately not fatal: a database that is up but not yet migrated should
  // still get an API that can say so on /ready, rather than a crash loop.
  let configHash: string | undefined;
  try {
    const snapshot = await recordConfigSnapshot(platform.db, {
      role: 'api',
      payload: describeConfig(config),
      appVersion: OPENAPI_CONTRACT_VERSION,
    });
    configHash = snapshot.hash;
  } catch (error) {
    app.log.warn({ err: error }, 'could not record the config snapshot; continuing');
  }
  app.log.info({ config: describeConfig(config), configHash }, 'configuration loaded');
  if (appRole.ok) {
    app.log.info({ role: APP_DATABASE_ROLE }, 'database connections use the app role');
  } else {
    app.log.error(
      { role: APP_DATABASE_ROLE, error: appRole.error },
      'could not ensure the database app role; queries will fail until the migrator has run',
    );
  }

  // Derive the KEK before the socket opens, so the first request after a restart
  // does not pay six seconds of Argon2id (03 §2.2 Tier 1: boot is unattended).
  //
  // Deliberately not fatal. `SecurityRuntime` resolves to `locked`/`not_started`
  // rather than throwing when there is no user yet or the passphrase does not
  // match, and in both states the right behaviour is an API that serves /health
  // and /auth/unlock-state and says what is wrong — not a crash loop that tells
  // the operator nothing.
  // Say what the derivation is about to cost, and against what, *before* it is
  // attempted. `hash-wasm` allocates the full Argon2id buffer in one call, so a
  // container whose limit is at or below the cost does not degrade: the OOM
  // killer takes the process mid-boot and the only artefact is exit code 137,
  // with nothing in the log mentioning Argon2 or memory. Advisory, never fatal —
  // a reading from /sys describes where we are running, not whether the
  // configuration is valid, and a parent cgroup's limit is a common false alarm.
  const kekMemory = describeKekMemory(
    assessKekMemory(config.kek.params.memoryKiB, readCgroupMemoryLimitBytes()),
  );
  if (kekMemory['warning'] === undefined) {
    app.log.info({ kekMemory }, 'KEK derivation memory budget');
  } else {
    app.log.warn({ kekMemory }, 'KEK derivation may not fit this container');
  }

  await security.initialise();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      // After the last request has drained: zeroes the KEK and every cached DEK
      // (P0-2), so a heap dump or a core file taken after shutdown does not
      // contain the key that opens every provider credential.
      security.destroy();
      await platform.flags.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      security.destroy();
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  // Binds to loopback by default. Never 0.0.0.0 on a machine holding financial
  // data: Caddy or Tailscale owns exposure, not this process.
  await app.listen({ host: config.env.HTTP_HOST, port: config.env.HTTP_PORT });
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`api failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
