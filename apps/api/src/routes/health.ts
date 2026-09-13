// SPDX-License-Identifier: MIT
import { checkConnection, pendingMigrations } from '@core/db';
import { outboxHealth, queueHealth, type TransactionalExecutor } from '@core/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, problemSchema, serviceUnavailable, toProblem } from '../problem.ts';

const healthResponse = z
  .object({
    status: z.literal('ok'),
    service: z.literal('api'),
    version: z.string(),
  })
  .meta({ id: 'HealthResponse' });

const outboxSchema = z
  .object({
    maxSeq: z.string().describe('Highest event sequence, as a string: it is a bigint.'),
    maxLagEvents: z.int().describe('Events the furthest-behind consumer has not read.'),
    oldestUnprocessedAgeSeconds: z.number().nullable(),
    failedConsumers: z
      .array(z.string())
      .describe('Consumers stopped at an event they cannot handle.'),
  })
  .meta({ id: 'OutboxHealth' });

const queueSchema = z
  .object({
    pending: z.int(),
    running: z.int(),
    dead: z.int(),
    stalled: z.int().describe('Running jobs whose worker stopped heartbeating.'),
    oldestPendingAgeSeconds: z.number().nullable(),
  })
  .meta({ id: 'QueueHealth' });

const readyResponse = z
  .object({
    status: z.enum(['ready', 'degraded']),
    database: z.literal('reachable'),
    migrations: z.literal('current'),
    outbox: outboxSchema.optional(),
    queue: queueSchema.optional(),
    degradedReasons: z.array(z.string()).optional(),
  })
  .meta({ id: 'ReadyResponse' });

/**
 * A 503 problem body, built by the same `toProblem` the global error handler
 * uses rather than assembled by hand.
 *
 * `/ready` answers in-handler instead of throwing, because throwing would route
 * through `setErrorHandler`, which logs an `internal` family failure at `error`.
 * An unreachable database during a rollout is a `warn` the operator is already
 * watching for, and the log line above each call site says which one it is.
 */
function unavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  detail: string,
): FastifyReply {
  const { problem } = toProblem(serviceUnavailable(code, detail), String(request.id), request.url);
  return reply.code(503).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * The four conditions that make the platform `degraded`, as operator-readable
 * sentences. Pure, so the thresholds can be exercised without a database.
 */
function collectDegradedReasons(
  outbox: Awaited<ReturnType<typeof outboxHealth>>,
  queue: Awaited<ReturnType<typeof queueHealth>>,
  limits: { readonly maxLag: number; readonly maxWait: number },
): string[] {
  const reasons: string[] = [];
  if (outbox.failedConsumers.length > 0) {
    reasons.push(
      `consumer(s) stopped at an event they cannot handle: ${outbox.failedConsumers.join(', ')}`,
    );
  }
  if (outbox.maxLagEvents > limits.maxLag) {
    reasons.push(
      `outbox lag is ${String(outbox.maxLagEvents)} events (limit ${String(limits.maxLag)})`,
    );
  }
  if (queue.stalled > 0) {
    reasons.push(`${String(queue.stalled)} job(s) have a stale heartbeat; is a worker running?`);
  }
  if (queue.oldestPendingAgeSeconds !== null && queue.oldestPendingAgeSeconds > limits.maxWait) {
    reasons.push(
      `oldest runnable job has waited ${String(Math.round(queue.oldestPendingAgeSeconds))}s (limit ${String(limits.maxWait)}s)`,
    );
  }
  return reasons;
}

export interface HealthRouteOptions {
  readonly pool: pg.Pool;
  readonly version: string;
  /** Omit to keep `/ready` to database and migrations only. */
  readonly platformDb?: TransactionalExecutor;
  readonly maxOutboxLagEvents?: number;
  readonly maxQueueWaitSeconds?: number;
  /** Whether `degraded` returns 503. Default false; see the doc comment below. */
  readonly failOnDegraded?: boolean;
}

/**
 * Liveness and readiness.
 *
 * `/health` answers "is this process alive" and must never touch the database:
 * an orchestrator that restarts the API because Postgres is slow turns a blip
 * into an outage.
 *
 * `/ready` answers "may this process take traffic" and therefore *must* touch it,
 * and must also confirm the schema matches the code. Serving requests against a
 * half-migrated database is how a nightly sync corrupts a ledger.
 *
 * Outbox lag and queue health are reported in the body but deliberately kept out
 * of the 503 decision by default. A stuck consumer or a dead job is a
 * *worker* problem, and the API is how the operator finds out about it — an API
 * that takes itself out of rotation because the pump is behind hides the
 * maintenance page behind the very failure it exists to report. The hard 503
 * remains reserved for the two conditions under which serving would be wrong:
 * the database is unreachable, or the schema does not match the code.
 * `READINESS_FAIL_ON_DEGRADED=true` is there for a deployment that would rather
 * hold a rollout than serve degraded.
 */
export const healthRoutes = (options: HealthRouteOptions): FastifyPluginAsyncZod => {
  const maxLag = options.maxOutboxLagEvents ?? 1_000;
  const maxWait = options.maxQueueWaitSeconds ?? 900;

  return async (app) => {
    app.get(
      '/health',
      {
        schema: {
          operationId: 'getHealth',
          summary: 'Liveness probe',
          description: 'Always answers if the process is running. Does not touch the database.',
          tags: ['system'],
          response: { 200: healthResponse },
        },
      },
      async () => ({ status: 'ok', service: 'api', version: options.version }) as const,
    );

    app.get(
      '/ready',
      {
        schema: {
          operationId: 'getReady',
          summary: 'Readiness probe',
          description:
            'Reports 503 until the database is reachable and every migration is applied. ' +
            'Outbox lag and queue health are reported in the body and mark the service ' +
            '`degraded` without, by default, failing the probe.',
          tags: ['system'],
          response: { 200: readyResponse, 503: problemSchema },
        },
      },
      async (request, reply) => {
        try {
          await checkConnection(options.pool);
        } catch (cause) {
          request.log.warn({ err: cause }, 'readiness: database unreachable');
          return unavailable(
            request,
            reply,
            'database_unavailable',
            'The database is not reachable.',
          );
        }

        const pending = await pendingMigrations(options.pool);
        if (pending.length > 0) {
          request.log.warn({ pending }, 'readiness: migrations pending');
          return unavailable(
            request,
            reply,
            'migrations_pending',
            `${pending.length} migration(s) have not been applied: ${pending.join(', ')}.`,
          );
        }

        if (options.platformDb === undefined) {
          return reply.code(200).send({
            status: 'ready',
            database: 'reachable',
            migrations: 'current',
          } as const);
        }

        const [outbox, queue] = await Promise.all([
          outboxHealth(options.platformDb),
          queueHealth(options.platformDb),
        ]);

        const degradedReasons = collectDegradedReasons(outbox, queue, { maxLag, maxWait });

        const body = {
          status: degradedReasons.length === 0 ? ('ready' as const) : ('degraded' as const),
          database: 'reachable' as const,
          migrations: 'current' as const,
          outbox: {
            maxSeq: outbox.maxSeq.toString(),
            maxLagEvents: outbox.maxLagEvents,
            oldestUnprocessedAgeSeconds: outbox.oldestUnprocessedAgeSeconds,
            failedConsumers: [...outbox.failedConsumers],
          },
          queue: {
            pending: queue.pending,
            running: queue.running,
            dead: queue.dead,
            stalled: queue.stalled,
            oldestPendingAgeSeconds: queue.oldestPendingAgeSeconds,
          },
          ...(degradedReasons.length === 0 ? {} : { degradedReasons }),
        };

        if (degradedReasons.length > 0) {
          request.log.warn({ degradedReasons }, 'readiness: platform degraded');
          if (options.failOnDegraded === true) {
            return unavailable(request, reply, 'platform_degraded', degradedReasons.join('; '));
          }
        }

        return reply.code(200).send(body);
      },
    );
  };
};
