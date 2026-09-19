// SPDX-License-Identifier: MIT
/**
 * `GET /export` and `POST /import` — the full-database bundle.
 *
 * Both need a step-up assertion (decision D21), the same policy
 * `connections.ts` uses for attaching or destroying a credential: an export is
 * "walk out with the whole ledger" and an import is "overwrite it", and a
 * stolen session cookie must not be enough for either.
 *
 * `POST /import` accepts the bundle as a raw body under a dedicated content
 * type (`application/x-ndjson`) rather than `multipart/form-data` — the same
 * choice `connections.ts`'s `ImportFile` schema already made for CSV uploads,
 * and for the same reason: `@fastify/multipart` would be a dependency added to
 * move bytes a raw body already moves, and this work package owns no
 * `package.json` edit. The content-type parser and the larger `bodyLimit` are
 * registered on this plugin's own encapsulation context, so no other route's
 * defaults change.
 */
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AgeUnavailableError,
  buildExportBundle,
  encryptWithAge,
  parseAndVerifyBundle,
  serialiseBundle,
  BundleValidationError,
  type ParsedBundle,
} from '../reports/export/bundle.ts';
import { importBundle, instanceHasUserData } from '../reports/export/import.ts';
import { assertRegistryIsComplete } from '../reports/export/registry.ts';
import { AppError, problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

/** The bundle for a real 50k-transaction seed database is comfortably under this. */
const IMPORT_BODY_LIMIT = 200 * 1024 * 1024;
const BUNDLE_CONTENT_TYPE = 'application/x-ndjson';
/** `app.ts`'s `CORRELATION_ID_HEADER`, duplicated: the two raw-response branches below
 * bypass the `onSend` hook that stamps it (`reply.hijack()`'s whole point). */
const CORRELATION_ID_HEADER = 'x-correlation-id';

function parseBundleOrThrow(text: string): ParsedBundle {
  try {
    return parseAndVerifyBundle(text);
  } catch (error) {
    if (error instanceof BundleValidationError) {
      throw new AppError({
        status: 409,
        code: error.code,
        title: 'Conflict',
        detail: error.message,
        family: 'domain',
      });
    }
    throw error;
  }
}

export interface ExportRouteOptions {
  /** `@core/config`'s `env.SECRETS_DIR` — where `age_recipients` is looked for. */
  readonly secretsDir: string;
}

export const exportRoutes = (
  deps: RouteDeps,
  options: ExportRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, pool, clock } = deps;

  return async (app) => {
    app.addContentTypeParser(
      BUNDLE_CONTENT_TYPE,
      { parseAs: 'string', bodyLimit: IMPORT_BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );

    app.get(
      '/export',
      {
        schema: {
          operationId: 'exportBundle',
          summary: 'Every table this user owns, as a versioned JSONL bundle',
          description:
            'Needs a step-up assertion. A manifest line (contract version, per-stream row ' +
            'count and sha256, `created_at`, app version) followed by every row, in dependency ' +
            'order. `?encrypt=true` pipes the bundle through `age` to the backup recipient ' +
            "(docker/backup's own recipients file) and returns ciphertext instead; a 503 names " +
            'why if `age` or the recipients file is unavailable rather than silently returning ' +
            'plaintext.',
          tags: ['export'],
          querystring: z.object({ encrypt: z.enum(['true', 'false']).optional() }),
          produces: [BUNDLE_CONTENT_TYPE, 'application/octet-stream'],
          // No `200` entry: the body is plaintext JSONL when `encrypt` is
          // absent and raw `age` ciphertext (a `Buffer`, not a JSON value) when
          // it is `true`. Zod's serializer compiler runs `schema.parse(data)`
          // then `JSON.stringify`s the result (`fastify-type-provider-zod`'s
          // `createSerializerCompiler`), which cannot represent either shape
          // faithfully — a declared `z.string()` would throw a
          // `ResponseSerializationError` the moment `data` is a `Buffer`.
          // Omitting the entry is what lets `reply.send()` below write the
          // content-type this route set and nothing else, for both shapes.
          response: { ...problems(401, 403, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const bundle = await buildExportBundle(pool, {
          userId: session.userId,
          appVersion: OPENAPI_CONTRACT_VERSION,
          now: clock.now(),
        });
        const text = serialiseBundle(bundle);

        if (request.query.encrypt === 'true') {
          // Errors are thrown *before* `hijack()` below, so they still reach
          // the app's normal `setErrorHandler` and a real problem-details body.
          const ciphertext = await encryptWithAge(text, { secretsDir: options.secretsDir }).catch(
            (error: unknown) => {
              if (error instanceof AgeUnavailableError) {
                throw new AppError({
                  status: 503,
                  code: 'export.encryption_unavailable',
                  title: 'Service Unavailable',
                  detail: error.message,
                  family: 'connector',
                });
              }
              throw error;
            },
          );
          // `reply.hijack()`: the body is a raw `Buffer` of `age` ciphertext,
          // not a JSON value the zod serializer (`schema.parse` then
          // `JSON.stringify`) can represent — see this route's schema comment.
          // Bypasses the `onSend` hook that stamps the correlation id, so it is
          // set directly below instead.
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="personalfi-export.jsonl.age"',
            [CORRELATION_ID_HEADER]: String(request.id),
          });
          reply.raw.end(ciphertext);
          return;
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': `${BUNDLE_CONTENT_TYPE}; charset=utf-8`,
          'content-disposition': 'attachment; filename="personalfi-export.jsonl"',
          [CORRELATION_ID_HEADER]: String(request.id),
        });
        reply.raw.end(text);
      },
    );

    app.post(
      '/import',
      {
        schema: {
          operationId: 'importBundle',
          summary: 'Load a bundle into a clean instance',
          description:
            'Needs a step-up assertion. Refused (409) unless this instance has no user data yet — ' +
            "import restores a whole database, it does not merge into one. Every stream's hash is " +
            'verified against the manifest before anything is written; a mismatch anywhere refuses ' +
            'the whole bundle. Loads in one transaction, in dependency order, then re-runs ' +
            "`@ctx/ledger`'s own projection for every transaction rather than trusting the " +
            'exported `effective_*` columns (decision D11). Body is the plaintext bundle ' +
            '`GET /export` produces; an `?encrypt=true` export must be decrypted with the `age` ' +
            'identity file before it is posted here — this application never holds that key ' +
            '(decision D24).',
          tags: ['export'],
          consumes: [BUNDLE_CONTENT_TYPE],
          body: z.string(),
          response: {
            200: z.object({
              tablesLoaded: z.array(z.string()),
              rowsLoaded: z.int().nonnegative(),
              transactionsReprojected: z.int().nonnegative(),
            }),
            ...problems(400, 401, 403, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);

        if (await instanceHasUserData(pool)) {
          throw new AppError({
            status: 409,
            code: 'export.instance_not_empty',
            title: 'Conflict',
            detail: 'This instance already has user data; import only targets a clean instance.',
            family: 'domain',
          });
        }

        const parsed = parseBundleOrThrow(request.body);
        // Every row's `user_id` is rewritten to this session's own user, not
        // preserved from the export — see `import.ts`'s header for why: the
        // column carries a real foreign key to `users`, and only this
        // instance's own bootstrap user is guaranteed to exist.
        return importBundle(pool, parsed, session.userId);
      },
    );

    app.get(
      '/export/manifest-check',
      {
        schema: {
          operationId: 'checkExportManifestCompleteness',
          summary: 'Every user-scoped table is either exported or named exempt',
          description:
            "The dispatch's own exit test, exposed as a route so the gate's independent reviewer " +
            'can re-run it against the booted stack without a database console. Computed from ' +
            '`information_schema`, never a hand list (see `reports/export/registry.ts`).',
          tags: ['export'],
          response: {
            200: z.object({ complete: z.boolean(), missing: z.array(z.string()) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        await guards.requireSession(request);
        return assertRegistryIsComplete(pool);
      },
    );
  };
};
