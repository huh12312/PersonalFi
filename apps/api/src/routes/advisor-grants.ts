// SPDX-License-Identifier: MIT
/**
 * `/advisors/{id}/scopes` and `/advisors/{id}/grants` — the scope-consent
 * route, as HTTP.
 *
 * `grantScopes` (`@ctx/insights`, WP 2.6) has never had a production caller
 * (wp2.6-insights.md §6, wp3.10a-snapshot-readers.md §7.1): a scope has
 * reached the database (migration 0019 widened `snapshot_grants_scope_check`)
 * before consent ever did. This file is that caller.
 *
 * ## D21: step-up on the write, not the read
 *
 * `GET /advisors/{id}/scopes` — seeing the catalogue and which scopes are
 * already granted — is a question about the caller's own settings, and
 * `guards.requireSession` covers it. `PUT /advisors/{id}/grants` is a
 * *standing* grant of data an advisor will read on every future run —
 * `holdings.detail` or `transactions.raw` is exactly D21's "credential
 * access" class of act, so it needs a fresh WebAuthn assertion, the same gate
 * `connections.ts`'s link/unlink and `net-worth.ts`'s correction carry.
 *
 * ## The route refuses an unpublished scope before the database does (0019's lesson)
 *
 * Two independent layers, both checked before `grantScopes`/`revokeScopes`
 * ever runs a statement:
 *
 *   1. **The wire type.** `z.enum(ADVISOR_SCOPES)` refuses a scope string
 *      that is not in the published v1 enum at all — a 400, from Fastify's
 *      schema validation, before this file's handler even starts.
 *   2. **`scopesPermittedForKind`.** A scope that *is* published but is
 *      `externalAllowed: false` and the advisor's own `kind` is `'external'`
 *      is a 422 domain refusal, named — `SCOPE_CATALOGUE`'s own minimisation
 *      rule, read here rather than left to the CHECK migration 0019 widened.
 *
 * Only after both pass does anything reach `snapshot_grants`, whose own
 * `snapshot_grants_scope_check` is the backstop this route is never supposed
 * to need.
 */
import {
  ADVISOR_SCOPES,
  findAdvisor,
  grantScopes,
  listGrants,
  revokeScopes,
  SCOPE_CATALOGUE,
  scopesPermittedForKind,
  type AdvisorScope,
  type InsightsContext,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): InsightsContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

function advisorNotFound(advisorId: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.advisor_not_found',
    title: 'Not Found',
    detail: `no advisor ${advisorId}`,
    family: 'user',
  });
}

/**
 * A scope that is published (`ADVISOR_SCOPES`, checked by the wire type
 * already) but not permitted for this advisor's execution mode — 08 §4.1's
 * three modes, `externalAllowed: false` on the catalogue row. Refused here,
 * before `grantScopes` is ever called, and named so it reads differently
 * from "not a scope at all".
 */
function scopeNotPermittedForKind(scope: AdvisorScope, kind: string): AppError {
  return new AppError({
    status: 422,
    code: 'insights.scope_not_permitted_for_kind',
    title: 'Unprocessable Content',
    detail: `${scope} is not permitted for a '${kind}' advisor (08 §4.2's minimisation table)`,
    family: 'domain',
  });
}

const scopeDefinitionSchema = z
  .object({
    scope: z.enum(ADVISOR_SCOPES),
    sensitivity: z.int(),
    key: z.string(),
    yields: z.string(),
    drops: z.string(),
    externalAllowed: z.boolean(),
    requiresPerRunConsent: z.boolean(),
    sourcedInPhase2: z.boolean(),
    granted: z.boolean(),
  })
  .meta({ id: 'AdvisorScopeDefinition' });

export const advisorGrantRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  return async (app) => {
    app.get(
      '/advisors/:advisorId/scopes',
      {
        schema: {
          operationId: 'getAdvisorScopes',
          summary: 'Every scope permitted for this advisor, sensitivity order, with grant status',
          description:
            '08 §4.2’s catalogue, filtered to what this advisor’s execution mode may ' +
            'ever hold (`externalAllowed`) — a scope an `external` advisor could never be granted ' +
            'is not listed as a choice at all, rather than listed and then refused.',
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          response: {
            200: z.object({
              advisorId: z.string(),
              kind: z.string(),
              scopes: z.array(scopeDefinitionSchema),
            }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const advisor = await findAdvisor(database, session.userId, request.params.advisorId);
        if (advisor === null) throw advisorNotFound(request.params.advisorId);
        const permitted = new Set(scopesPermittedForKind(advisor.kind));
        const granted = new Set(await listGrants(database, session.userId, advisor.advisorId));
        return {
          advisorId: advisor.advisorId,
          kind: advisor.kind,
          scopes: SCOPE_CATALOGUE.filter((definition) => permitted.has(definition.scope)).map(
            (definition) => ({
              scope: definition.scope,
              sensitivity: definition.sensitivity,
              key: definition.key,
              yields: definition.yields,
              drops: definition.drops,
              externalAllowed: definition.externalAllowed,
              requiresPerRunConsent: definition.requiresPerRunConsent,
              sourcedInPhase2: definition.sourcedInPhase2,
              granted: granted.has(definition.scope),
            }),
          ),
        };
      },
    );

    app.put(
      '/advisors/:advisorId/grants',
      {
        schema: {
          operationId: 'putAdvisorGrants',
          summary: 'Replace the caller’s standing scope grants for one advisor',
          description:
            'Needs a fresh session (D21): a standing grant of `holdings.detail` or similar is ' +
            'credential-access-class consent. Full desired-set semantics — a scope present in the ' +
            'body and not currently granted is granted; a scope currently granted and absent from ' +
            'the body is revoked. A scope outside the published v1 enum is a 400 before this ' +
            'handler runs; one published but not permitted for this advisor’s kind is a 422 ' +
            'named here, before `grantScopes` is called.',
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          body: z.object({
            scopes: z.array(z.enum(ADVISOR_SCOPES)),
            /** 08 §4.2: some scopes need consent per run, not just a standing grant. */
            perRunConsent: z.boolean().optional(),
          }),
          response: {
            200: z.object({
              advisorId: z.string(),
              granted: z.array(z.enum(ADVISOR_SCOPES)),
              revoked: z.array(z.enum(ADVISOR_SCOPES)),
            }),
            ...problems(400, 401, 403, 404, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const advisor = await findAdvisor(database, session.userId, request.params.advisorId);
        if (advisor === null) throw advisorNotFound(request.params.advisorId);

        const permitted = scopesPermittedForKind(advisor.kind);
        const permittedSet = new Set(permitted);
        for (const scope of request.body.scopes) {
          if (!permittedSet.has(scope)) throw scopeNotPermittedForKind(scope, advisor.kind);
        }

        const desired = new Set(request.body.scopes);
        const current = new Set(await listGrants(database, session.userId, advisor.advisorId));
        const toGrant = [...desired].filter((scope) => !current.has(scope));
        const toRevoke = [...current].filter((scope) => !desired.has(scope));

        const context = contextOf(deps, session.userId, request);
        await database.transaction(async (tx) => {
          await grantScopes(
            tx,
            context,
            advisor.advisorId,
            toGrant,
            request.body.perRunConsent ?? false,
          );
          await revokeScopes(tx, context, advisor.advisorId, toRevoke);
        });

        return { advisorId: advisor.advisorId, granted: toGrant, revoked: toRevoke };
      },
    );
  };
};
