// SPDX-License-Identifier: MIT
/**
 * API entry point.
 *
 * Boot order matters and is deliberate: configuration is validated *before* a
 * socket is opened or a connection pool is created, so a misconfigured container
 * fails immediately and loudly instead of at 03:15 during a sync.
 */
import { ConfigError, describeConfig, loadConfig } from '@core/config';
import { createPool } from '@core/db';
import { buildApp } from './app.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool({
    databaseUrl: config.databaseUrl.reveal(),
    max: config.env.DATABASE_POOL_MAX,
    statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'personalfi-api',
  });

  const app = await buildApp({ config, pool });

  // Recorded at boot so "what changed?" after a behaviour shift is answerable.
  // `describeConfig` omits every secret by construction.
  app.log.info({ config: describeConfig(config) }, 'configuration loaded');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
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
