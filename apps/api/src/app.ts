// SPDX-License-Identifier: MIT
import fastifySwagger from '@fastify/swagger';
import type { AppConfig } from '@core/config';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import { newId } from '@core/kernel';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { buildLoggerOptions } from './logging.ts';
import { AppError, PROBLEM_CONTENT_TYPE, toProblem } from './problem.ts';
import { healthRoutes } from './routes/health.ts';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
}

/**
 * The API shell.
 *
 * Deliberately empty of domain routes: WP 0.2 onward mount their own context
 * routers here. What this file owns is the cross-cutting behaviour every route
 * inherits — correlation ids, redacted structured logs, schema-first validation
 * and serialisation, and RFC 9457 errors.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, pool } = options;

  const app = Fastify({
    logger: buildLoggerOptions(config),
    // One correlation id per request, taken from the caller if it supplied one so
    // a browser, the API, and a worker job all appear under the same id. One id
    // reconstructs an entire sync.
    genReqId: (request) => {
      const supplied = request.headers[CORRELATION_ID_HEADER];
      if (typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128) {
        return supplied;
      }
      return newId();
    },
    requestIdHeader: false,
    // Every request log line keys the id as `correlationId`, matching the field
    // name a job or an event carries, so one grep spans HTTP and background work.
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    // Behind Caddy. Without this every request logs the proxy's address.
    trustProxy: true,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  // Schema-first: one Zod schema per route validates the request, serialises the
  // response, and becomes the OpenAPI document. A response that does not match its
  // schema is a 500, not a silently wrong payload.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'PersonalFi API',
        description:
          'Self-hosted personal finance and advisory. Single user, zero public ingress. ' +
          'Errors are RFC 9457 problem details; clients switch on `code`, never on `detail`.',
        version: OPENAPI_CONTRACT_VERSION,
        license: { name: 'MIT', identifier: 'MIT' },
      },
      servers: [{ url: config.env.BASE_URL }],
      tags: [{ name: 'system', description: 'Liveness, readiness, and operational endpoints.' }],
    },
    transform: jsonSchemaTransform,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const { problem, family } = toProblem(error, String(request.id), request.url);

    if (family === 'internal') {
      request.log.error({ err: error, code: problem.code }, 'unhandled error');
    } else if (family === 'user') {
      request.log.info({ code: problem.code, status: problem.status }, 'request rejected');
    } else {
      request.log.warn({ err: error, code: problem.code }, 'request failed');
    }

    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const { problem } = toProblem(
      new AppError({
        status: 404,
        code: 'route_not_found',
        title: 'Not Found',
        detail: `No route for ${request.method} ${request.url}.`,
        family: 'user',
      }),
      String(request.id),
      request.url,
    );
    return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  await app.register(healthRoutes({ pool, version: OPENAPI_CONTRACT_VERSION }));

  return app;
}
