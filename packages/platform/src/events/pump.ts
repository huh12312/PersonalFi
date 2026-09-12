// SPDX-License-Identifier: MIT
import { systemClock, type Clock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { DEFAULT_CONSUMER_BACKOFF, backoffDelayMs, type BackoffOptions } from '../backoff.ts';
import { ConsumerHandlerError, describeError } from '../errors.ts';
import {
  silentLogger,
  type Executor,
  type PlatformLogger,
  type TransactionalExecutor,
} from '../executor.ts';
import { toInstant, toInstantOrNull, type TimestampValue } from '../instants.ts';
import {
  CONSUMER_ADVISORY_LOCK_CLASS,
  tryAcquireNamedAdvisoryLease,
  type AdvisoryLease,
} from '../locks.ts';
import { CONSUMER_STATUS_ORDINAL, METRIC, type Metrics } from '../metrics.ts';
import { CHANNEL, createNotifyListener, type NotifyListener } from '../notify.ts';
import { createSleeper } from '../sleep.ts';
import type { EventEnvelope, Redaction } from './envelope.ts';

/**
 * The consumer pump.
 *
 * One loop per consumer, each reading the log in `seq` order from its own offset
 * and each isolated from the others: a broken Insights rule stops Insights and
 * nothing else. There is no cross-consumer ordering guarantee and nothing may
 * depend on one — where Insights needs Budgeting's read model to be current it
 * reacts to the event Budgeting emits *after* its write, not to the event
 * Budgeting reacted to.
 *
 * Per event, in one transaction:
 *
 *   1. claim the delivery receipt (`processed_events`), which is a no-op if this
 *      consumer has already seen the event;
 *   2. run the handler, handing it the same transaction so its writes land or
 *      roll back with the receipt;
 *   3. advance the offset.
 *
 * All three or none. That is what makes "duplicate delivery does not re-run the
 * side effect" a property of the design rather than of a careful handler.
 */

export type ConsumerStatus = 'running' | 'paused' | 'replaying' | 'failed';

export interface ConsumerContext {
  /** The transaction the receipt and the offset advance are written in. */
  readonly tx: Executor;
  readonly logger: PlatformLogger;
  readonly clock: Clock;
}

export type ConsumerHandler = (
  event: EventEnvelope,
  context: ConsumerContext,
) => Promise<void> | void;

export interface ConsumerOptions {
  /**
   * Event types this consumer wants. Omit for all of them.
   *
   * A filter is not just an optimisation: it is what keeps a consumer's offset
   * meaningful after a new event type is introduced, because the consumer does
   * not silently start skipping rows it was never written to understand.
   */
  readonly filter?: readonly string[];
  readonly batchSize?: number;
  /** Retries before the consumer dead-letters and stops. Default 5. */
  readonly maxAttempts?: number;
  readonly backoff?: BackoffOptions;
  /**
   * Skip `redaction = 'purged'` events instead of handing them to the handler.
   * Default true: a purged payload is gone by design and every handler would
   * otherwise need the same guard.
   */
  readonly skipPurged?: boolean;
}

export interface RegisteredConsumer {
  readonly name: string;
  readonly handler: ConsumerHandler;
  readonly filter: readonly string[] | undefined;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly backoff: BackoffOptions;
  readonly skipPurged: boolean;
}

/**
 * Declare a consumer.
 *
 * The name carries a version by convention — `budgeting.actuals@v3`. Changing a
 * consumer's logic means bumping the version and replaying from 0, which rebuilds
 * the read model from the log and current state. That is a one-line operation
 * instead of a bespoke repair script, and it is the single biggest reason the
 * event log is worth its one table.
 */
export function registerConsumer(
  name: string,
  handler: ConsumerHandler,
  options: ConsumerOptions = {},
): RegisteredConsumer {
  return {
    name,
    handler,
    filter: options.filter === undefined ? undefined : [...options.filter],
    batchSize: options.batchSize ?? 500,
    maxAttempts: options.maxAttempts ?? 5,
    backoff: options.backoff ?? DEFAULT_CONSUMER_BACKOFF,
    skipPurged: options.skipPurged ?? true,
  };
}

export interface ConsumerPumpOptions {
  readonly pool: pg.Pool;
  readonly db: TransactionalExecutor;
  readonly consumers: readonly RegisteredConsumer[];
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
  readonly metrics?: Metrics;
  /** Fallback poll when no notification arrives. Default 5s (08 §3.2 rule 5). */
  readonly pollIntervalMs?: number;
  /** How often to retry taking a consumer's advisory lock. Default 15s. */
  readonly leaseRetryMs?: number;
  readonly random?: () => number;
}

export interface ConsumerPump {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drain every consumer once, synchronously. The test and replay entry point. */
  drain(): Promise<number>;
  runConsumerOnce(name: string): Promise<number>;
}

interface EventRow extends Record<string, unknown> {
  seq: bigint;
  id: string;
  user_id: string;
  aggregate_type: string;
  aggregate_id: string | null;
  event_type: string;
  event_version: number;
  payload: unknown;
  occurred_at: TimestampValue;
  recorded_at: TimestampValue;
  correlation_id: string;
  causation_id: string | null;
  redaction: string;
}

function toEnvelope(row: EventRow): EventEnvelope {
  return {
    seq: BigInt(row.seq),
    id: row.id,
    userId: row.user_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    occurredAt: toInstant(row.occurred_at),
    recordedAt: toInstant(row.recorded_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    redaction: row.redaction as Redaction,
  };
}

export function createConsumerPump(options: ConsumerPumpOptions): ConsumerPump {
  const {
    pool,
    db,
    consumers,
    clock = systemClock,
    logger = silentLogger,
    metrics,
    pollIntervalMs = 5_000,
    leaseRetryMs = 15_000,
    random = Math.random,
  } = options;

  const byName = new Map(consumers.map((consumer) => [consumer.name, consumer]));
  let running = false;
  let listener: NotifyListener | null = null;
  const loops: Array<Promise<void>> = [];
  const leases = new Map<string, AdvisoryLease>();
  const sleeper = createSleeper();

  async function ensureOffsetRow(name: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO event_consumer_offsets (consumer_name)
      VALUES (${name})
      ON CONFLICT (consumer_name) DO NOTHING
    `);
  }

  interface OffsetState {
    lastSeq: bigint;
    status: ConsumerStatus;
    failedCount: number;
    retryAfter: Date | null;
  }

  /**
   * Read a consumer's bookkeeping row, creating it if this is its first sight.
   *
   * The create is not an optimisation, it is the precondition for every write
   * further down: advancing the offset and counting a failure are both `UPDATE …
   * WHERE consumer_name = $1`, and against a missing row they match nothing and
   * report success. The consumer then re-reads the same events forever — masked,
   * because `processed_events` still deduplicates the side effect — and a poison
   * event never reaches `maxAttempts`, so it never dead-letters either. Cheap
   * insurance: on the hot path this is one indexed SELECT and nothing else.
   */
  async function readOffset(name: string): Promise<OffsetState> {
    const select = async (): Promise<OffsetState | undefined> => {
      const result = await db.execute<{
        last_seq: bigint;
        status: string;
        failed_count: number;
        retry_after: TimestampValue | null;
      }>(sql`
        SELECT last_seq, status, failed_count, retry_after
        FROM event_consumer_offsets
        WHERE consumer_name = ${name}
      `);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        lastSeq: BigInt(row.last_seq),
        status: row.status as ConsumerStatus,
        failedCount: row.failed_count,
        retryAfter: toInstantOrNull(row.retry_after),
      };
    };

    const existing = await select();
    if (existing !== undefined) return existing;
    await ensureOffsetRow(name);
    return (await select()) ?? { lastSeq: 0n, status: 'running', failedCount: 0, retryAfter: null };
  }

  /**
   * Process one batch for one consumer. Returns how many events were handled.
   *
   * Each event gets its own transaction rather than the batch sharing one. That
   * costs round trips and buys the property that matters on a 40-minute backfill:
   * a failure at event 400 of 500 keeps the first 399, so a restart resumes
   * rather than redoing, and a poison event is isolated to itself.
   */
  async function pumpBatch(consumer: RegisteredConsumer): Promise<number> {
    const offset = await readOffset(consumer.name);

    if (offset.status === 'failed' || offset.status === 'paused') return 0;
    if (offset.retryAfter !== null && offset.retryAfter.getTime() > clock.nowMs()) return 0;

    const filter = consumer.filter;
    const rows = await db.execute<EventRow>(
      filter === undefined
        ? sql`
            SELECT seq, id, user_id, aggregate_type, aggregate_id, event_type, event_version,
                   payload, occurred_at, recorded_at, correlation_id, causation_id, redaction
            FROM domain_events
            WHERE seq > ${offset.lastSeq.toString()}::bigint
            ORDER BY seq
            LIMIT ${consumer.batchSize}
          `
        : sql`
            SELECT seq, id, user_id, aggregate_type, aggregate_id, event_type, event_version,
                   payload, occurred_at, recorded_at, correlation_id, causation_id, redaction
            FROM domain_events
            WHERE seq > ${offset.lastSeq.toString()}::bigint
              AND event_type = ANY(${sql.param([...filter])}::text[])
            ORDER BY seq
            LIMIT ${consumer.batchSize}
          `,
    );

    if (rows.rows.length === 0) return 0;
    metrics?.increment(METRIC.consumerBatches, { consumer: consumer.name });

    let handled = 0;
    for (const row of rows.rows) {
      const event = toEnvelope(row);
      try {
        await handleOne(consumer, event);
        handled += 1;
      } catch (cause) {
        await recordFailure(consumer, event, cause);
        return handled;
      }
    }
    return handled;
  }

  async function handleOne(consumer: RegisteredConsumer, event: EventEnvelope): Promise<void> {
    await db.transaction(async (tx) => {
      // The receipt is claimed first and in the same transaction as everything
      // else. If this consumer has already processed the event — a crash between
      // COMMIT and the next read, a manual re-run, two workers racing before the
      // advisory lock settled — the INSERT returns nothing and the handler is not
      // called again. The side effect happened exactly once.
      const claim = await tx.execute<{ event_id: string }>(sql`
        INSERT INTO processed_events (consumer_name, event_id, user_id, event_seq)
        VALUES (${consumer.name}, ${event.id}::uuid, ${event.userId}::uuid, ${event.seq.toString()}::bigint)
        ON CONFLICT (consumer_name, event_id) DO NOTHING
        RETURNING event_id
      `);

      const alreadyProcessed = claim.rows.length === 0;
      const purged = consumer.skipPurged && event.redaction === 'purged';

      if (!alreadyProcessed && !purged) {
        try {
          await consumer.handler(event, { tx, logger, clock });
        } catch (cause) {
          throw new ConsumerHandlerError(consumer.name, event.seq, cause);
        }
      }

      await tx.execute(sql`
        UPDATE event_consumer_offsets
        SET last_seq = ${event.seq.toString()}::bigint,
            failed_count = 0,
            failed_seq = NULL,
            failed_event_id = NULL,
            failed_error = NULL,
            retry_after = NULL,
            last_event_at = ${event.occurredAt.toISOString()}::timestamptz,
            updated_at = now()
        WHERE consumer_name = ${consumer.name}
      `);

      if (alreadyProcessed) {
        metrics?.increment(METRIC.eventsSkippedDuplicate, { consumer: consumer.name });
      } else {
        metrics?.increment(METRIC.eventsProcessed, {
          consumer: consumer.name,
          type: event.eventType,
        });
      }
    });
  }

  /**
   * A handler threw. Back off, and after `maxAttempts` dead-letter the consumer.
   *
   * It **stops at the offending event** rather than skipping it. A skipped event
   * is a read model that is quietly wrong, which a solo operator will not notice
   * for months; a stopped consumer is a red dot on the maintenance page and a
   * `/ready` degradation, which they notice today.
   */
  async function recordFailure(
    consumer: RegisteredConsumer,
    event: EventEnvelope,
    cause: unknown,
  ): Promise<void> {
    const result = await db.execute<{ failed_count: number }>(sql`
      UPDATE event_consumer_offsets
      SET failed_count = failed_count + 1,
          failed_seq = ${event.seq.toString()}::bigint,
          failed_event_id = ${event.id}::uuid,
          failed_error = ${describeError(cause).slice(0, 4_000)},
          updated_at = now()
      WHERE consumer_name = ${consumer.name}
      RETURNING failed_count
    `);
    const attempts = result.rows[0]?.failed_count ?? 1;
    metrics?.increment(METRIC.eventsFailed, { consumer: consumer.name });

    if (attempts >= consumer.maxAttempts) {
      await db.execute(sql`
        UPDATE event_consumer_offsets
        SET status = 'failed', retry_after = NULL, updated_at = now()
        WHERE consumer_name = ${consumer.name}
      `);
      metrics?.increment(METRIC.eventsDeadLettered, { consumer: consumer.name });
      logger.error(
        { consumer: consumer.name, seq: String(event.seq), eventId: event.id, attempts },
        'consumer dead-lettered and stopped; it will not skip the event',
      );
      return;
    }

    const delay = backoffDelayMs(attempts, consumer.backoff, random);
    await db.execute(sql`
      UPDATE event_consumer_offsets
      SET retry_after = now() + make_interval(secs => ${delay / 1_000}),
          updated_at = now()
      WHERE consumer_name = ${consumer.name}
    `);
    logger.warn(
      {
        consumer: consumer.name,
        seq: String(event.seq),
        attempts,
        delayMs: delay,
        err: describeError(cause),
      },
      'consumer handler failed; retrying with backoff',
    );
  }

  async function publishLag(): Promise<void> {
    if (metrics === undefined) return;
    const health = await outboxHealth(db);
    for (const consumer of health.consumers) {
      metrics.gauge(METRIC.consumerLagEvents, consumer.lagEvents, { consumer: consumer.name });
      metrics.gauge(METRIC.consumerStatus, CONSUMER_STATUS_ORDINAL[consumer.status] ?? 0, {
        consumer: consumer.name,
      });
    }
  }

  /**
   * One consumer's loop. Holds that consumer's advisory lock for as long as it
   * runs, so a second worker starting up does not double-process: it simply fails
   * to take the lock, sleeps, and takes over if the first worker dies (the lock
   * is session-scoped, so a dropped connection releases it).
   */
  async function loop(consumer: RegisteredConsumer): Promise<void> {
    await ensureOffsetRow(consumer.name);
    while (running) {
      if (!leases.has(consumer.name)) {
        const acquired = await tryAcquireNamedAdvisoryLease(
          pool,
          CONSUMER_ADVISORY_LOCK_CLASS,
          consumer.name,
        );
        if (acquired === null) {
          await sleeper.sleep(leaseRetryMs);
          continue;
        }
        leases.set(consumer.name, acquired);
        logger.debug({ consumer: consumer.name }, 'consumer lease acquired');
      }

      try {
        let handled = 0;
        // Keep draining while full batches come back: a backfill of 50k events
        // should not take 50k / 500 * 5 seconds because the poll interval is the
        // rate limiter.
        for (;;) {
          const count = await pumpBatch(consumer);
          handled += count;
          if (count < consumer.batchSize) break;
          if (!running) break;
        }
        if (handled > 0) await publishLag();
      } catch (cause) {
        logger.error({ consumer: consumer.name, err: describeError(cause) }, 'consumer loop error');
        await sleeper.sleep(1_000);
        continue;
      }

      if (!running) break;
      await (listener?.wait(pollIntervalMs) ?? sleeper.sleep(pollIntervalMs));
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      // One listener shared by every consumer loop: a notification means "some
      // event was appended", and deciding which consumers care is what the
      // `seq > last_seq` query already does.
      listener = await createNotifyListener(pool, CHANNEL.domainEvents, logger);
      for (const consumer of consumers) {
        loops.push(loop(consumer));
      }
      logger.info({ consumers: consumers.map((c) => c.name) }, 'consumer pump started');
    },

    async stop() {
      running = false;
      // A consumer parked on `leaseRetryMs` — the second worker, waiting its
      // turn — would otherwise hold shutdown for fifteen seconds.
      sleeper.wake();
      await listener?.close();
      listener = null;
      await Promise.allSettled(loops);
      loops.length = 0;
      for (const lease of leases.values()) await lease.release();
      leases.clear();
      logger.info({}, 'consumer pump stopped');
    },

    async drain() {
      let total = 0;
      for (const consumer of consumers) {
        for (;;) {
          const handled = await pumpBatch(consumer);
          total += handled;
          if (handled < consumer.batchSize) break;
        }
      }
      await publishLag();
      return total;
    },

    async runConsumerOnce(name) {
      const consumer = byName.get(name);
      if (consumer === undefined) return 0;
      return await pumpBatch(consumer);
    },
  };
}

/**
 * Rewind a consumer and let the pump replay it.
 *
 * The delivery receipts are deleted along with the offset, because a replay whose
 * receipts survive would skip every event it is meant to re-run. That is safe
 * precisely because handlers are idempotent: a recompute-style handler produces
 * the same read model, and a side-effecting handler has a natural dedupe key of
 * its own (`notification_outbox.dedupe_key`, `insights (advisor_id, key, period)`)
 * that survives the receipt being dropped.
 *
 * This is the operator action behind *Settings → Maintenance → Rebuild read
 * model*, and the reason it can be a button rather than a `docker exec`.
 */
export async function replayConsumer(
  db: TransactionalExecutor,
  name: string,
  fromSeq = 0n,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM processed_events
      WHERE consumer_name = ${name} AND event_seq > ${fromSeq.toString()}::bigint
    `);
    await tx.execute(sql`
      INSERT INTO event_consumer_offsets (consumer_name, last_seq, status)
      VALUES (${name}, ${fromSeq.toString()}::bigint, 'running')
      ON CONFLICT (consumer_name) DO UPDATE
        SET last_seq = EXCLUDED.last_seq,
            status = 'running',
            failed_count = 0,
            failed_seq = NULL,
            failed_event_id = NULL,
            failed_error = NULL,
            retry_after = NULL,
            updated_at = now()
    `);
  });
}

/** Operator actions for a dead-lettered or paused consumer. */
export async function setConsumerStatus(
  db: Executor,
  name: string,
  status: ConsumerStatus,
): Promise<void> {
  await db.execute(sql`
    UPDATE event_consumer_offsets
    SET status = ${status},
        failed_count = CASE WHEN ${status} = 'running' THEN 0 ELSE failed_count END,
        retry_after = NULL,
        updated_at = now()
    WHERE consumer_name = ${name}
  `);
}

/**
 * Move a dead-lettered consumer past the event it cannot handle.
 *
 * Deliberately explicit and deliberately separate from `setConsumerStatus`: this
 * is the only operation in the pump that accepts a permanently missing side
 * effect, so it should be something an operator types on purpose after reading
 * `failed_error`, never something a retry policy does on their behalf.
 */
export async function skipFailedEvent(db: TransactionalExecutor, name: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute<{ failed_seq: bigint | null }>(sql`
      SELECT failed_seq FROM event_consumer_offsets WHERE consumer_name = ${name}
    `);
    const failedSeq = result.rows[0]?.failed_seq;
    if (failedSeq === null || failedSeq === undefined) return false;
    await tx.execute(sql`
      UPDATE event_consumer_offsets
      SET last_seq = ${failedSeq.toString()}::bigint,
          status = 'running',
          failed_count = 0,
          failed_seq = NULL,
          failed_event_id = NULL,
          retry_after = NULL,
          updated_at = now()
      WHERE consumer_name = ${name}
    `);
    return true;
  });
}

export interface ConsumerHealth {
  readonly name: string;
  readonly lastSeq: bigint;
  readonly status: ConsumerStatus;
  readonly lagEvents: number;
  readonly failedCount: number;
  readonly failedSeq: bigint | null;
  readonly failedError: string | null;
}

export interface OutboxHealth {
  readonly maxSeq: bigint;
  readonly totalEvents: number;
  readonly consumers: readonly ConsumerHealth[];
  readonly maxLagEvents: number;
  readonly failedConsumers: readonly string[];
  /** Age of the oldest event no consumer has processed, in seconds. */
  readonly oldestUnprocessedAgeSeconds: number | null;
}

/**
 * The numbers behind `/ready` and the future maintenance page.
 *
 * One query, no locks, cheap enough to call on every readiness probe.
 */
export async function outboxHealth(db: Executor): Promise<OutboxHealth> {
  const head = await db.execute<{ max_seq: bigint | null; total: bigint }>(sql`
    SELECT coalesce(max(seq), 0) AS max_seq, count(*) AS total FROM domain_events
  `);
  const maxSeq = BigInt(head.rows[0]?.max_seq ?? 0);
  const totalEvents = Number(head.rows[0]?.total ?? 0);

  const rows = await db.execute<{
    consumer_name: string;
    last_seq: bigint;
    status: string;
    failed_count: number;
    failed_seq: bigint | null;
    failed_error: string | null;
    lag_events: bigint;
    oldest_age_seconds: string | null;
  }>(sql`
    SELECT o.consumer_name,
           o.last_seq,
           o.status,
           o.failed_count,
           o.failed_seq,
           o.failed_error,
           (SELECT count(*) FROM domain_events e WHERE e.seq > o.last_seq) AS lag_events,
           (SELECT extract(epoch FROM now() - min(e.recorded_at))::text
              FROM domain_events e WHERE e.seq > o.last_seq) AS oldest_age_seconds
    FROM event_consumer_offsets o
    ORDER BY o.consumer_name
  `);

  const consumers = rows.rows.map((row) => ({
    name: row.consumer_name,
    lastSeq: BigInt(row.last_seq),
    status: row.status as ConsumerStatus,
    lagEvents: Number(row.lag_events),
    failedCount: row.failed_count,
    failedSeq: row.failed_seq === null ? null : BigInt(row.failed_seq),
    failedError: row.failed_error,
  }));

  const ages = rows.rows
    .map((row) => (row.oldest_age_seconds === null ? null : Number(row.oldest_age_seconds)))
    .filter((age): age is number => age !== null);

  return {
    maxSeq,
    totalEvents,
    consumers,
    maxLagEvents: consumers.reduce((max, consumer) => Math.max(max, consumer.lagEvents), 0),
    failedConsumers: consumers.filter((c) => c.status === 'failed').map((c) => c.name),
    oldestUnprocessedAgeSeconds: ages.length === 0 ? null : Math.max(...ages),
  };
}
