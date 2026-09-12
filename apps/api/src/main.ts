// SPDX-License-Identifier: MIT
/**
 * API entry point.
 *
 * Boot order matters and is deliberate: configuration is validated *before* a
 * socket is opened or a connection pool is created, so a misconfigured container
 * fails immediately and loudly instead of at 03:15 during a sync.
 */
import { ConfigError, describeConfig, loadConfig } from '@core/config';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import { createPool } from '@core/db';
import { recordConfigSnapshot } from '@core/platform';
import { buildApp } from './app.ts';
import { buildPlatform } from './platform.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool({
    databaseUrl: config.databaseUrl.reveal(),
    max: config.env.DATABASE_POOL_MAX,
    statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'personalfi-api',
  });

  const platform = buildPlatform({ config, pool });
  const app = await buildApp({ config, pool, platformDb: platform.db });

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

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await platform.flags.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
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
