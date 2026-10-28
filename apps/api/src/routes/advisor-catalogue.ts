// SPDX-License-Identifier: MIT
/**
 * `GET /advisor/catalogue` and `POST /advisor/catalogue/{name}` — the advisory
 * catalogue (WP 11.5b; 12 §2.1), for the holder's own use and inspection.
 *
 * ## Auth policy
 *
 * Session-only, like reading the insight feed (`routes/insights.ts`): both
 * routes read the holder's own data and change nothing — no function stores a
 * run, writes a row, asks a model or moves money — so neither needs a fresh
 * (step-up) session. CSRF applies to the POST as to every mutation-shaped
 * request, through the app's own hook.
 *
 * ## What the holder sees
 *
 * The listing is the published description (`catalogueDescription()`, the
 * same document the compiler will be shown, pinned at
 * `packages/contracts/advisor/catalogue/`) filtered to the functions the
 * holder's live grant to the narrator covers: a function they have not granted
 * is not listed at all. A call returns the typed result envelope — status,
 * inputs, figures with their `source_ref`s — or a problem: 404 for a function
 * that does not exist (or a goal, scenario or insight that does not), 403 for
 * one not granted, 400 for invalid arguments, 422 for a tax year the parameter
 * store does not hold.
 */
import {
  callCatalogueByName,
  isCatalogueRefusal,
  listCatalogue,
  type CatalogueRuntimeDependencies,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAdvisorCatalogueDependencies } from '../advisor-catalogue.ts';
import { AppError, problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

const functionDescriptionSchema = z
  .object({
    name: z.string(),
    summary: z.string(),
    description: z.string(),
    backing: z.string(),
    scopes: z.array(z.string()),
    scope_rule: z.enum(['all', 'any']),
    parameters: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AdvisorCatalogueFunction' });

const listingSchema = z
  .object({
    catalogue_version: z.string(),
    /** The envelope every call answers with (JSON Schema). */
    envelope: z.record(z.string(), z.unknown()),
    /** The shapes the schemas refer to as `#/$defs/<name>`. */
    $defs: z.record(z.string(), z.unknown()),
    functions: z.array(functionDescriptionSchema),
  })
  .meta({ id: 'AdvisorCatalogueListing' });

const resultSchema = z
  .object({
    catalogue_version: z.string(),
    function: z.string(),
    status: z.enum(['ok', 'not_available']),
    as_of: z.string(),
    scopes: z.array(z.string()),
    inputs: z.record(z.string(), z.unknown()),
    input_digest: z.string(),
    result: z.record(z.string(), z.unknown()).nullable(),
    not_available: z.object({ code: z.string(), reason: z.string() }).nullable(),
  })
  .meta({
    id: 'AdvisorCatalogueResult',
    description:
      'One call’s result: every figure in `result` is money, a decimal string or a date with ' +
      '`source_refs` into `inputs`.',
  });

async function timeZoneOf(deps: RouteDeps, userId: string): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users WHERE id = $1`,
    [userId],
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

/** Feature-detected like `routes/insights.ts`: no advisor token secret, no snapshot. */
async function dependenciesOf(
  deps: RouteDeps,
  userId: string,
): Promise<CatalogueRuntimeDependencies> {
  const tokenSecret = deps.config.secrets.advisor_token_secret;
  if (tokenSecret === undefined) {
    throw new AppError({
      status: 503,
      code: 'insights.advisor_token_secret_unconfigured',
      title: 'Service Unavailable',
      detail:
        'No advisor_token_secret is configured; an operator must write one before the advisory ' +
        'catalogue can build a snapshot (see wp2.6-insights.md §6).',
      family: 'internal',
    });
  }
  return createAdvisorCatalogueDependencies({
    database: deps.database,
    clock: deps.clock,
    timeZone: await timeZoneOf(deps, userId),
    monteCarlo: deps.monteCarlo,
    tokenSecret: tokenSecret.reveal(),
  });
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  503: 'Service Unavailable',
};

export const advisorCatalogueRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;
  return async (app) => {
    app.get(
      '/advisor/catalogue',
      {
        schema: {
          operationId: 'listAdvisorCatalogue',
          summary: 'The advisory functions this holder can call, with their parameters and results',
          description:
            'The published catalogue description, filtered to the functions the holder’s grant to ' +
            'the narrator covers. A function not granted is not listed.',
          tags: ['advisors'],
          response: { 200: listingSchema, ...problems(401) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const listing = await listCatalogue({ database }, { userId: session.userId });
        return {
          catalogue_version: listing.catalogue_version,
          envelope: listing.envelope,
          $defs: listing.$defs,
          functions: listing.functions.map((entry) => ({
            ...entry,
            scopes: [...entry.scopes],
          })),
        };
      },
    );

    app.post(
      '/advisor/catalogue/:name',
      {
        schema: {
          operationId: 'callAdvisorCatalogue',
          summary: 'Call one advisory function with its arguments and return its typed result',
          description:
            'Read only: nothing is stored and no model is asked. The body is the function’s ' +
            'arguments as its `parameters` schema describes them (`{}` for none).',
          tags: ['advisors'],
          params: z.object({
            name: z
              .string()
              .min(3)
              .max(64)
              .regex(/^[a-z_]+\.[a-z_]+$/),
          }),
          body: z.record(z.string(), z.unknown()).optional(),
          response: { 200: resultSchema, ...problems(400, 401, 403, 404, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const dependencies = await dependenciesOf(deps, session.userId);
        try {
          const result = await callCatalogueByName(
            dependencies,
            { userId: session.userId, correlationId: String(request.id) },
            request.params.name,
            request.body ?? {},
          );
          return {
            ...result,
            scopes: [...result.scopes],
            inputs: { ...result.inputs },
            result: result.result as Record<string, unknown> | null,
          };
        } catch (error) {
          if (!isCatalogueRefusal(error)) throw error;
          throw new AppError({
            status: error.status,
            code: error.code,
            title: TITLES[error.status] ?? 'Bad Request',
            detail: error.message,
            family: error.status === 422 ? 'domain' : 'user',
          });
        }
      },
    );
  };
};
