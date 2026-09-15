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
import { createDatabase, createPool } from '@core/db';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import { systemClock } from '@core/kernel';
import { SecretBox } from '@core/secretbox';
import { UserService } from '@ctx/identity';
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
import { createConnectorRegistry, createDomainRuntime } from './domain.ts';
import { buildLoggerOptions } from './logging.ts';
import { appModules } from './modules.ts';
import { buildPlatform, resolveModules } from './platform.ts';

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
  // `UserService` needs no KEK, so the worker can read the account holder without
  // the six seconds of Argon2id the API pays at boot.
  const user = await new UserService({ db: pool, clock: systemClock }).findPrimary();

  let pump: ConsumerPump | null = null;
  let runner: JobRunner | null = null;
  let scheduler: Scheduler | null = null;
  let secretBox: SecretBox | null = null;

  if (user === null) {
    // Not an error: a freshly migrated database has no account holder until the
    // first passkey is enrolled. Come back after a restart rather than crash-looping.
    logger.warn({}, 'no account holder yet; the worker will idle until one is enrolled');
  } else {
    const userId = user.id;
    await platform.flags.watch(pool);

    /**
     * The worker derives the KEK too, and it has to.
     *
     * A sync opens a sealed provider credential, so the process that runs syncs
     * needs the key — there is no arrangement in which the API unseals on the
     * worker's behalf that does not amount to passing a plaintext token between
     * containers. This is the same six seconds of Argon2id the API pays at boot,
     * and the same failure mode: with no `master_key` the process stays up, says
     * so, and runs nothing that needs a credential.
     */
    const passphrase = config.secrets.master_key;
    if (passphrase === undefined) {
      logger.error({}, 'master_key secret is absent; no connection can be synced');
    } else {
      const box = new SecretBox({
        db: pool,
        userId,
        clock: systemClock,
        kdfParams: config.kek.params,
        kdfFloor: config.kek.floor,
      });
      const state = await box.unlock(passphrase.reveal());
      if (state.state === 'unlocked') {
        secretBox = box;
        logger.info({ kekVersion: state.kekVersion }, 'key custody: unlocked');
      } else {
        box.destroy();
        logger.error({ reason: state.reason }, 'key custody: locked; syncs will not run');
      }
    }

    const database = createDatabase(pool);
    const modules =
      secretBox === null
        ? { consumers: [], jobs: [], enabled: [], disabled: ['module.connections'] }
        : await resolveModules(
            platform,
            userId,
            appModules({
              database,
              orchestrator: createDomainRuntime({
                database,
                clock: systemClock,
                logger,
                // gate-security-review.md §8.5 N-5: this MUST be built from the
                // same configuration the API's composition root uses
                // (`app.ts`'s `createConnectorRegistry({ plaid: config.plaid,
                // … })`). Called with no arguments it silently omits Plaid, and
                // the worker is the ONLY process that runs a scheduled or
                // queued sync — so a Plaid Item linked through the API could be
                // sealed and stored and then never synced, every
                // `connections.sync` job dying with `no connector is registered
                // for provider "plaid"` after five attempts. compose.yml mounts
                // the three plaid_* secrets on this service precisely so this
                // line can use them.
                registry: createConnectorRegistry({
                  plaid: config.plaid,
                  clock: systemClock,
                  logger,
                }),
                secretBox,
              }).orchestrator,
              timezone: user.displayTimezone,
            }),
          );
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
    } else {
      // Phase 0, or every module switched off. Say so: "the pump is not
      // running" is a five-second diagnosis from a log line and a long one from
      // an outbox that is quietly not draining.
      logger.info({}, 'no enabled module registered a consumer; the event pump is not running');
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
    } else {
      logger.info({}, 'no enabled module registered a job handler; the job runner is not running');
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
      // The KEK goes before the pool does: a process that is shutting down has
      // no further use for it, and the window in which it sits in memory after
      // the last job finished should be as short as the code can make it (P0-2).
      secretBox?.destroy();
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
