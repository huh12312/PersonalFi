// SPDX-License-Identifier: MIT
/**
 * Worker entry point.
 *
 * Same image, same code, same configuration as the API — only `ROLE=worker` and
 * the command differ (08 §3.2). That matters more than it looks: two images means
 * two build pipelines, two SBOMs, two digests to pin, and eventually two
 * subtly different dependency trees on a box that is supposed to be one app.
 *
 * What runs here and deliberately not in the API:
 *
 *   * the **consumer pump**, so a slow read-model rebuild cannot make an HTTP
 *     request time out;
 *   * the **job runners**, so a 40-minute backfill does not hold a connection
 *     the API needs;
 *   * the **scheduler**, under an advisory lock, so running two workers does not
 *     double every nightly sync.
 *
 * The API stays a request/response process. The one thing both do is record
 * their configuration at boot, which is why `config_snapshots` is keyed by role.
 */
import { ConfigError, describeConfig, loadConfig } from '@core/config';
import { createPool } from '@core/db';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import {
  createConsumerPump,
  createJobRunner,
  createScheduler,
  outboxHealth,
  queueHealth,
  recordConfigSnapshot,
  type ConsumerPump,
  type JobRunner,
  type Scheduler,
} from '@core/platform';
import pino from 'pino';
import { buildLoggerOptions } from './logging.ts';
import { buildPlatform, resolveModules, type ModuleRegistration } from './platform.ts';

/**
 * Every module the worker knows about.
 *
 * Empty in Phase 0 because there are no contexts yet. Phase 1 appends
 * `{ flagKey: 'module.ledger', events: [...], consumers: [...], jobs: [...] }`
 * and nothing else in this file changes.
 */
const MODULES: readonly ModuleRegistration[] = [];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ ...buildLoggerOptions(config), base: { service: 'worker' } });

  const pool = createPool({
    databaseUrl: config.databaseUrl.reveal(),
    max: config.env.DATABASE_POOL_MAX,
    statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'personalfi-worker',
  });

  const platform = buildPlatform({ config, pool });

  const snapshot = await recordConfigSnapshot(platform.db, {
    role: 'worker',
    payload: describeConfig(config),
    appVersion: OPENAPI_CONTRACT_VERSION,
  });
  logger.info(
    { config: describeConfig(config), configHash: snapshot.hash, changed: snapshot.isNew },
    'configuration loaded',
  );

  // Single user today (decision D6): the worker serves whoever is in `users`.
  // Multi-user is additive — this becomes a loop, and nothing below changes.
  //
  // Read through the pool rather than through a context reader because
  // `@ctx/identity` does not exist yet (WP 0.2). This is the composition root,
  // the one layer allowed to reach across a seam, and it is three lines that WP
  // 0.2 replaces with `identity.currentUser()`.
  const owner = await pool.query<{ id: string }>(
    'SELECT id FROM users ORDER BY created_at LIMIT 1',
  );
  const userId = owner.rows[0]?.id;

  let pump: ConsumerPump | null = null;
  let runner: JobRunner | null = null;
  let scheduler: Scheduler | null = null;

  if (userId === undefined) {
    // Not an error: a freshly migrated database has no account holder until the
    // first passkey is enrolled. Come back after a restart rather than crash-looping.
    logger.warn({}, 'no account holder yet; the worker will idle until one is enrolled');
  } else {
    await platform.flags.watch(pool);
    const modules = await resolveModules(platform, userId, MODULES);
    logger.info({ enabled: modules.enabled, disabled: modules.disabled }, 'modules resolved');

    if (modules.consumers.length > 0) {
      pump = createConsumerPump({
        pool,
        db: platform.db,
        consumers: modules.consumers,
        logger,
        metrics: platform.metrics,
        pollIntervalMs: config.env.EVENT_POLL_INTERVAL_MS,
      });
      await pump.start();
    }

    if (modules.jobs.length > 0) {
      runner = createJobRunner({
        pool,
        db: platform.db,
        handlers: modules.jobs,
        logger,
        metrics: platform.metrics,
        concurrency: config.env.WORKER_CONCURRENCY,
        pollIntervalMs: config.env.JOB_POLL_INTERVAL_MS,
        heartbeatIntervalMs: config.env.JOB_HEARTBEAT_INTERVAL_MS,
        shutdownGraceMs: config.env.WORKER_SHUTDOWN_GRACE_MS,
        ...(config.env.WORKER_ID === undefined ? {} : { workerId: config.env.WORKER_ID }),
      });
      await runner.start();
    }

    if (await platform.flags.isEnabled(userId, 'platform.scheduler')) {
      scheduler = createScheduler({
        pool,
        db: platform.db,
        logger,
        metrics: platform.metrics,
        tickIntervalMs: config.env.SCHEDULER_INTERVAL_MS,
      });
      await scheduler.start();
    } else {
      logger.warn({}, 'platform.scheduler is off; no scheduled work will run');
    }

    const outbox = await outboxHealth(platform.db);
    const queue = await queueHealth(platform.db);
    logger.info(
      { outboxLag: outbox.maxLagEvents, queuePending: queue.pending, queueDead: queue.dead },
      'worker ready',
    );
  }

  /**
   * Shutdown order is the whole point of a graceful stop and is not arbitrary.
   *
   * Scheduler first: stop *creating* work. Pump next: stop taking events. Job
   * runner last, because it is the one with work in its hands, and `stop()`
   * waits for it. Only then does the pool close — closing it first would fail
   * every in-flight query and turn a clean deploy into a batch of abandoned jobs.
   */
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    try {
      await scheduler?.stop();
      await pump?.stop();
      await runner?.stop();
      await platform.flags.close();
      await pool.end();
      logger.info({}, 'shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`worker failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
