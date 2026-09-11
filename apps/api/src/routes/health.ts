// SPDX-License-Identifier: MIT
import { checkConnection, pendingMigrations } from '@core/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, problemSchema } from '../problem.ts';

const healthResponse = z
  .object({
    status: z.literal('ok'),
    service: z.literal('api'),
    version: z.string(),
  })
  .meta({ id: 'HealthResponse' });

const readyResponse = z
  .object({
    status: z.literal('ready'),
    database: z.literal('reachable'),
    migrations: z.literal('current'),
  })
  .meta({ id: 'ReadyResponse' });

export interface HealthRouteOptions {
  readonly pool: pg.Pool;
  readonly version: string;
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
 */
export const healthRoutes = (options: HealthRouteOptions): FastifyPluginAsyncZod => {
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
            'Reports 503 until the database is reachable and every migration is applied.',
          tags: ['system'],
          response: { 200: readyResponse, 503: problemSchema },
        },
      },
      async (request, reply) => {
        try {
          await checkConnection(options.pool);
        } catch (cause) {
          request.log.warn({ err: cause }, 'readiness: database unreachable');
          return reply.code(503).type(PROBLEM_CONTENT_TYPE).send({
            type: 'https://personalfi.local/problems/database_unavailable',
            title: 'Service Unavailable',
            status: 503,
            detail: 'The database is not reachable.',
            instance: request.url,
            code: 'database_unavailable',
            correlationId: request.id,
          });
        }

        const pending = await pendingMigrations(options.pool);
        if (pending.length > 0) {
          request.log.warn({ pending }, 'readiness: migrations pending');
          return reply
            .code(503)
            .type(PROBLEM_CONTENT_TYPE)
            .send({
              type: 'https://personalfi.local/problems/migrations_pending',
              title: 'Service Unavailable',
              status: 503,
              detail: `${pending.length} migration(s) have not been applied: ${pending.join(', ')}.`,
              instance: request.url,
              code: 'migrations_pending',
              correlationId: request.id,
            });
        }

        return reply.code(200).send({
          status: 'ready',
          database: 'reachable',
          migrations: 'current',
        } as const);
      },
    );
  };
};
