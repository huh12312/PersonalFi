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
import { UserService, type UserRecord } from '@ctx/identity';
import { loadAssumptions } from '@ctx/planning';
import {
  createConsumerPump,
  createJobRunner,
  createLivenessWriter,
  createScheduler,
  outboxHealth,
  queueHealth,
  recordConfigSnapshot,
  PoolCannotCoverPinnedConnectionsError,
  type ConsumerPump,
  type JobRunner,
  type Scheduler,
} from '@core/platform';
import pino from 'pino';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
  createMarketDataRunRecorder,
  createMarketDataRuntime,
  createMarketDataWriter,
  createNotificationChannels,
  createWalletRpcRuntime,
  drizzleTransactionalExecutor,
  createNotificationEgressPolicy,
  hydrateMarketDataBudgets,
} from './domain.ts';
import { buildLoggerOptions } from './logging.ts';
import { appModules } from './modules.ts';
import { MODULE_FLAGS, buildPlatform, resolveModules } from './platform.ts';

/**
 * Connections this process **pins for its whole life** before it does one
 * unit of work — and therefore the number `DATABASE_POOL_MAX` must be *over
 * and above*, not inclusive of.
 *
 * ## The defect this exists to close (found by the Phase 3 cold walk)
 *
 * Three of the worker's connections are `LISTEN` sockets
 * (`personalfi_feature_flags`, `personalfi_domain_events`, `personalfi_jobs`)
 * and are checked out until shutdown. Two more are session-scoped advisory
 * leases — the scheduler leader and the job reaper leader — and
 * `tryAcquireAdvisoryLease` holds the `pg.PoolClient` for the lifetime of the
 * lease, because that is what makes "this process is the scheduler until it
 * dies" true (`packages/platform/src/locks.ts`). And `createConsumerPump`
 * takes **one lease, and therefore one pinned connection, per consumer**
 * (`pump.ts`'s `leases` map, released only in `stop()`), so that two workers
 * cannot run the same consumer.
 *
 * That makes the worker's floor `5 + consumers`, which is not a number
 * `DATABASE_POOL_MAX` was ever meant to include: an operator reading
 * "DATABASE_POOL_MAX=10" reasonably expects ten connections *for queries*.
 *
 * On the Phase 3 cold walk it went over. Observed, on a fresh volume with an
 * account holder and seven consumers registered: all ten pool connections
 * checked out and **idle**, `pg_stat_activity` showing three `LISTEN`s, two
 * `pg_try_advisory_lock($1::bigint)` and five
 * `pg_try_advisory_lock($1::int, $2::int)`; `worker ready` never logged
 * because `outboxHealth` was queued on an eleventh connection that could never
 * arrive; every job-runner poll and scheduler tick queued behind it; the
 * process alive at 0% CPU in `epoll_wait` with no crash, no restart and no
 * error line anywhere. The only thing that reported it was D-3's liveness
 * healthcheck — `job-runner heartbeat missing or stale (age=71335ms
 * max=15000ms)` — which is precisely the failure mode N-4 added it for, and
 * this is the first time it has caught one in the shipped image.
 *
 * It is a **self-inflicted deadlock, not a load problem**: the pool is not
 * busy, it is pinned. Adding a consumer is a pool-sizing change, and nothing
 * said so.
 *
 * ## Why a constant here rather than a bigger default
 *
 * Raising `DATABASE_POOL_MAX` would work and would be wrong: it changes what
 * the *api* gets too (`app.ts` runs no pump, no scheduler and no leases, so
 * its ten really are ten), and it leaves the arithmetic implicit — the next
 * consumer would silently eat the margin again. Here the reservation is named,
 * derived from `MODULE_FLAGS` so it grows with the module list by
 * construction, and checked out loud at boot by `assertPoolCoversLeases`
 * below.
 */
export const WORKER_PINNED_CONNECTIONS =
  /* LISTEN: feature flags, domain events, jobs */ 3 +
  /* leader leases: scheduler, job reaper */ 2 +
  /* at most one consumer lease per module */ MODULE_FLAGS.length;

/**
 * Say so, by name, if the arithmetic above ever stops holding — and refuse to
 * boot rather than merely say so (WP 4.12b, C-6; G3-5).
 *
 * A pool that cannot cover its own pinned connections does not fail — it
 * *hangs*, silently, with every loop queued on `pool.connect()`. So this is
 * checked at the one moment the real number is known (after `resolveModules`
 * has decided which consumers exist).
 *
 * ## Why this throws now, and did not before
 *
 * It used to log and continue. The Phase 3 gate's own sabotage found exactly
 * what that is worth: making the check a no-op (S-P1: `if (poolMax > pinned
 * || true) return;`) or zeroing the reservation it verifies (S-P2:
 * `0 * MODULE_FLAGS.length`) both left `api` 75/75 green, because the one
 * test that existed (`regate-worker-boot.test.ts`) asserted only that the
 * *string* `assertPoolCoversLeases` appears in this file — never that it
 * evaluates anything, never a consequence a test could see. A log line a
 * silent deadlock never triggers is not a control; a thrown error `main()`'s
 * own `try`/`catch` turns into `process.exit(1)` is a crash-loop `docker
 * compose ps` shows in the first second, which is strictly worse to watch and
 * strictly better to notice than an idle process at 0% CPU nobody is paged for.
 *
 * Exported (along with `WORKER_PINNED_CONNECTIONS`) so the arithmetic itself
 * — not just its presence in the source — has a direct unit test
 * (`test/worker-pool-guard.test.ts`), which is what actually goes red under
 * S-P1 and S-P2 reproduced, rather than green the way the string-match test was.
 */
export function assertPoolCoversLeases(
  logger: pino.Logger,
  poolMax: number,
  consumerCount: number,
): void {
  const pinned = 3 + 2 + consumerCount;
  if (poolMax > pinned) return;
  const detail =
    "3 LISTEN + 2 leader leases + one lease per consumer. Every job-runner poll and scheduler " +
    'tick would queue on pool.connect() forever with no error. Raise DATABASE_POOL_MAX or ' +
    'reduce the number of registered consumers.';
  logger.error({ poolMax, pinned, consumerCount }, `refusing to boot: ${detail}`);
  throw new PoolCannotCoverPinnedConnectionsError(poolMax, pinned, detail);
}

/** A real `setTimeout`, deliberately **not** `unref()`'d — see `awaitAccountHolder`'s header. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface AccountHolderPollOptions {
  /** `UserService#findPrimary`, or a fake that answers `null` then a user. */
  readonly findPrimary: () => Promise<UserRecord | null>;
  readonly intervalMs: number;
  /** Checked before every attempt, and again before every wait: a shutdown
   *  signal that arrives while idling must stop the poll, not outlive it. */
  readonly isStopping: () => boolean;
  /** The worker's own idle-heartbeat touch — called once per empty attempt. */
  readonly onIdle?: () => void;
  /** Test seam. Production never overrides this; see `sleep` above. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll for the account holder, and hand back to `main()`'s normal start-up
 * path — **without `main()` ever returning** while idle (C-1, G3-1).
 *
 * ## The defect this replaces
 *
 * `main()` used to build no pump, runner or scheduler in the no-holder
 * branch, touch an `unref()`'d heartbeat timer once, and then fall through to
 * the bottom of the function and return. `unref()` is what made that a
 * defect rather than a design: it does not count towards keeping the event
 * loop alive, so once the pool's `idleTimeoutMillis` (30 s) closed the last
 * checked-out client, nothing held the process open and Node exited 0.
 * Compose's restart policy then started it again, and each restart re-read
 * `users` — a cold install worked only by an accidental exit-and-restart
 * loop at roughly 2/min while no holder existed (the Phase 3 gate's cold
 * walk, `docs/evidence/phase-3/gate-security-review.md` §3.1: `RestartCount=1`
 * exactly 30 s after boot, no `shutting down` line — it was never signalled).
 * On a runtime with no restart policy the worker would simply stop.
 *
 * ## The fix, and why a plain `setTimeout` is the load-bearing part
 *
 * This function loops, calling `findPrimary()` and — while it answers
 * `null` — waiting one `intervalMs` and trying again, exactly like the job
 * runner's and scheduler's own poll loops. The wait is `sleep()` above, a
 * `setTimeout` that is **not** `unref()`'d: a pending, ref'd timer is itself
 * a reason for the event loop to keep turning, which is what "idle until one
 * is enrolled" needs to actually mean rather than "idle for 30 seconds and
 * then restart". `onIdle` (the same `liveness.touch('idle')` the old
 * heartbeat performed) keeps compose.yml's healthcheck fresh across however
 * many cycles this takes; `isStopping` lets a real SIGTERM/SIGINT still stop
 * a worker that has never seen a holder, rather than making it unstoppable.
 */
export async function awaitAccountHolder(
  options: AccountHolderPollOptions,
): Promise<UserRecord | null> {
  const wait = options.sleep ?? sleep;
  while (!options.isStopping()) {
    const user = await options.findPrimary();
    if (user !== null) return user;
    options.onIdle?.();
    if (options.isStopping()) return null;
    await wait(options.intervalMs);
  }
  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ ...buildLoggerOptions(config), base: { service: 'worker' } });

  // See apps/api/src/main.ts's identical call for why: `loadAssumptions()`
  // (`@ctx/planning`) is lazy by design, so nothing forces the checked-in
  // assumptions file to validate until whatever first reads it needs it. The
  // worker is the process that runs `planning.projection_refresh` and the
  // Monte Carlo job, both of which resolve assumptions per run — a malformed
  // file should refuse to start the worker, not fail the first job to touch
  // it five hours after a bad release. Unguarded: the throw must reach the
  // `catch` at the bottom of this file and exit non-zero.
  loadAssumptions();

  const pool = createPool({
    databaseUrl: config.databaseUrl.reveal(),
    // **Not** `DATABASE_POOL_MAX` on its own — see `WORKER_PINNED_CONNECTIONS`.
    max: config.env.DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS,
    statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'personalfi-worker',
  });

  const platform = buildPlatform({ config, pool });

  /**
   * D-3 (gate-security-review.md §8.5 N-6): a liveness signal the job runner
   * and scheduler refresh on every poll, so compose.yml's healthcheck can
   * assert freshness instead of merely asserting the process exists. `/tmp`
   * is the tmpfs mount compose.yml gives this container under `read_only:
   * true`, so this needs no capability and no writable rootfs.
   *
   * N-4's 189 restarts never got here — the process died deriving the KEK,
   * before a single heartbeat could be written, which the healthcheck below
   * would report as unhealthy from the very first missed poll rather than
   * for the whole life of the container.
   */
  const liveness = createLivenessWriter({ dir: '/tmp/liveness', clock: systemClock });

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
  const users = new UserService({ db: pool, clock: systemClock });
  let user = await users.findPrimary();

  let pump: ConsumerPump | null = null;
  let runner: JobRunner | null = null;
  let scheduler: Scheduler | null = null;
  let secretBox: SecretBox | null = null;
  let stopping = false;

  /**
   * Shutdown order is the whole point of a graceful stop and is not arbitrary.
   *
   * Scheduler first: stop *creating* work. Pump next: stop taking events. Job
   * runner last, because it is the one with work in its hands, and `stop()`
   * waits for it. Only then does the pool close — closing it first would fail
   * every in-flight query and turn a clean deploy into a batch of abandoned jobs.
   *
   * Defined and registered **before** the account-holder poll below (C-1):
   * a SIGTERM/SIGINT that arrives while the worker has never seen a holder
   * must still stop it — `pump`/`runner`/`scheduler`/`secretBox` are read at
   * call time, so it is safe for every one of them to still be `null`.
   */
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

  if (user === null) {
    // Not an error: a freshly migrated database has no account holder until the
    // first passkey is enrolled.
    //
    // C-1 (G3-1): this used to touch an `unref()`'d heartbeat once and let
    // `main()` return, which let the process exit 0 once the pool's idle
    // timeout closed the last connection — a cold install "worked" only by an
    // accidental Compose restart-and-retry loop, never by actually idling
    // (`awaitAccountHolder`'s header has the measured timeline). Now `main()`
    // polls, in place, for as long as it takes, and — this is the load-bearing
    // change — never returns while it does: the code below runs in the same
    // invocation, the moment a holder is found, with no restart anywhere.
    logger.warn({}, 'no account holder yet; polling for one — main() does not return while idle');
    // D-3: a fresh install's healthcheck must not fail just because nobody has
    // enrolled a passkey yet, and it must stay fresh for however long that
    // takes — one touch now, then one per unsuccessful poll (`onIdle` below).
    liveness.touch('idle');
    user = await awaitAccountHolder({
      findPrimary: () => users.findPrimary(),
      intervalMs: config.env.JOB_POLL_INTERVAL_MS,
      isStopping: () => stopping,
      onIdle: () => liveness.touch('idle'),
    });
  }

  if (user === null) {
    // `stopping` became true while idling — a shutdown signal arrived before
    // any holder was ever enrolled. `shutdown()` above is already running (and
    // will call `process.exit`); there is nothing left to start.
    return;
  }

  {
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

    // WP 3.4 (docs/evidence/phase-3/wp3.w-wiring.md). Built once per process,
    // in the worker only: the API runs no job runner and no scheduler, so a
    // market-data runtime there would be four adapters nobody can invoke —
    // and four API keys held in a process that is directly reachable from the
    // network, which is the opposite of what `SECRETS_DIR` is for.
    const marketDataRuntime = createMarketDataRuntime({
      secrets: config.secrets,
      allowedHosts: config.marketData.allowedHosts,
      clock: systemClock,
      logger,
    });
    // Prime each provider's budget from `market_data_runs` so a restart does
    // not reset the day's spend (wp3.4-market-data.md §9 item 4). Best-effort
    // on purpose: an empty budget is exactly the behaviour before this line
    // existed, so a read failure must not stop the worker booting.
    try {
      const hydrated = await hydrateMarketDataBudgets(database, userId, marketDataRuntime.budgets);
      logger.info(
        { providers: [...marketDataRuntime.budgets.keys()], spends: hydrated },
        'market-data rate budgets hydrated from market_data_runs',
      );
    } catch (error) {
      logger.warn(
        { err: error },
        'could not hydrate market-data rate budgets; starting from an empty budget',
      );
    }

    const modules =
      secretBox === null
        ? { consumers: [], jobs: [], enabled: [], disabled: ['module.connections'] }
        : await resolveModules(
            platform,
            userId,
            appModules({
              database,
              // D6: one holder. `module.planning` binds `@ctx/investments`'
              // price and FX readers to it, and refuses by name if a job
              // arrives for another (see `modules.ts`'s `planningModule`).
              userId,
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
                  // WP 3.6, and the N-5 reasoning below applies to this one
                  // harder than to any other adapter: `wallet_rpc` is *not* in
                  // `PROCESS_LOCAL_PROVIDERS`, so every wallet sync runs here
                  // and nowhere else. A registry that omitted it would leave a
                  // linked wallet with no connector, five failed attempts and a
                  // dead job every night.
                  walletRpc: createWalletRpcRuntime({
                    database,
                    allowedHosts: config.crypto.allowedHosts,
                    etherscanApiKey: config.secrets.etherscan_api_key,
                  }),
                  // WP 3.5, and the N-5 reasoning above applies unchanged: the
                  // worker is the only process that runs a scheduled sync, so
                  // a Coinbase connection linked through the API would never
                  // sync if this registry omitted the connector.
                  coinbase: config.coinbase,
                  clock: systemClock,
                  logger,
                }),
                secretBox,
              }).orchestrator,
              timezone: user.displayTimezone,
              notificationChannels: createNotificationChannels(
                createNotificationEgressPolicy(config),
              ),
              secretBox,
              // wp2.6-insights.md §6 open item 5: absent until an operator
              // writes `${SECRETS_DIR}/advisor_token_secret`; `module.insights`
              // then registers no consumer, no job and no schedule (see
              // `modules.ts`'s `insightsModule`).
              ...(config.secrets.advisor_token_secret === undefined
                ? {}
                : { advisorTokenSecret: config.secrets.advisor_token_secret.reveal() }),
              // WP 3.2 — the port the lot consumer reads accounts and sync
              // bookkeeping through. Always supplied: unlike a provider key
              // there is no deployment in which it is legitimately absent.
              investmentSyncPort: createInvestmentSyncPort(database),
              // WP 3.4 — supplied here and *not* in `app.ts`, which is what
              // makes `module.integrations` register its schedule in the one
              // process that has a scheduler to fire it.
              marketData: {
                runtime: marketDataRuntime,
                writer: createMarketDataWriter(database),
                recorder: createMarketDataRunRecorder(database),
              },
            }),
          );
    logger.info({ enabled: modules.enabled, disabled: modules.disabled }, 'modules resolved');
    assertPoolCoversLeases(
      logger,
      config.env.DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS,
      modules.consumers.length,
    );

    if (modules.consumers.length > 0) {
      pump = createConsumerPump({
        pool,
        // Not `platform.db`: `platformExecutor` narrows the transaction to
        // `execute` alone, and WP 3.2's lot consumer builds a Drizzle store
        // over the pump's transaction. See `drizzleTransactionalExecutor`.
        db: drizzleTransactionalExecutor(database),
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
        // D-3: compose.yml's worker healthcheck reads this file's freshness
        // against JOB_POLL_INTERVAL_MS * 3.
        onPoll: () => liveness.touch('job-runner'),
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
        // D-3: compose.yml's worker healthcheck reads this file's freshness
        // against SCHEDULER_INTERVAL_MS * 3.
        onTick: () => liveness.touch('scheduler'),
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
}

// `docker/entrypoint.mjs` runs this file by dynamic `import()`, not by
// invoking it as the process's own entry module (so that ROLE dispatch keeps
// one PID and one signal-handler set — see that file's header) — which means
// `import.meta.main` is always `false` in production and cannot be used as
// the "am I actually being run?" guard a plain script would use. Vitest sets
// `process.env.VITEST` in every worker process it runs (documented, and the
// one thing every test process has that a real container never does), so
// this is the guard that lets `awaitAccountHolder` (and `assertPoolCoversLeases`,
// `WORKER_PINNED_CONNECTIONS`) be imported and unit-tested directly
// (`test/worker-account-holder-poll.test.ts`, `test/worker-pool-guard.test.ts`)
// without also booting a real worker — needing a database, a KEK and a
// container's env — every time the module is merely imported.
if (process.env['VITEST'] === undefined) {
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
}
