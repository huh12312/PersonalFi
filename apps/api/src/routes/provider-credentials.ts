// SPDX-License-Identifier: MIT
/**
 * `/connections/providers/plaid/credentials` — a holder's own Plaid keys, kept by
 * the product (WP 10.1).
 *
 * ## Who can do what
 *
 * - `GET` needs a session. It answers *whether* Plaid is configured and *from
 *   where*, with the environment and the last four characters of the client id.
 *   It never returns, and has no way to read back, the secret.
 * - `PUT` and `DELETE` need a **step-up** (D21): this is the moment a provider
 *   credential enters or leaves the install, the same class of act as
 *   `POST /connections`. A stolen session cookie must not be able to point the
 *   install at somebody else's Plaid account, or silence the one it has.
 *
 * ## Precedence
 *
 * The operator's secret files win. When `config.plaid` is non-null the answer is
 * `source: 'files'`, read-only, and a `PUT` is refused (409) rather than stored
 * and silently ignored. Otherwise the holder's stored credentials are the source.
 * `env: production` is refused unless `PLAID_ALLOW_PRODUCTION=true`, at write time
 * here and again at use time in `plaid-stored.ts` (D16).
 *
 * ## Validation
 *
 * A `PUT` is checked against Plaid before anything is sealed: it builds a client
 * from the submitted values and asks for a Link token, which is the call the
 * product makes next anyway. It is authenticated, free (Plaid bills when an Item
 * is created, not for a link token), works in both environments, and is on the
 * adapter's allow-listed surface; `/institutions/get` is not, and widening that
 * surface is a deliberate edit in another package (D16). A rejection (bad key,
 * wrong environment) is a 422 and nothing is stored; Plaid being unreachable is
 * a 502 and nothing is stored either.
 *
 * ## What is never in a response, a log line, an error or an audit row
 *
 * The secret and the full client id. The audit row (`security_events`,
 * `provider_credentials.set | .rotated | .removed`) carries the provider, the
 * environment and the four-character hint.
 *
 * `DELETE` revokes nothing at Plaid: the key stays valid there until the holder
 * rolls it in the Plaid dashboard, and connections linked with it stop syncing
 * (their access tokens belong to that Plaid account).
 */
import { PLAID_PROVIDER } from '@connector/plaid';
import {
  ConnectorError,
  eraseCredentialKey,
  getProviderCredentialStatus,
  PROVIDER_CREDENTIAL_ENVS,
  removeProviderCredentials,
  setProviderCredentials,
} from '@ctx/connections';
import { recordSecurityEvent, type RequestContext } from '@ctx/identity';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { StoredPlaid } from '../plaid-stored.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import { contextOf } from './connections.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

const credentialsStatus = z
  .object({
    configured: z
      .boolean()
      .describe('True when a Plaid connector is usable for this holder right now.'),
    source: z
      .enum(['files', 'stored', 'none'])
      .describe(
        "`files`: the operator's secret files configure Plaid (read-only here). `stored`: this " +
          "holder's credentials, sealed in the install. `none`: neither.",
      ),
    env: z.enum(PROVIDER_CREDENTIAL_ENVS).nullable(),
    clientIdHint: z
      .string()
      .nullable()
      .describe('The last four characters of the stored client id. Never the secret.'),
    rotatedAt: isoInstant.nullable().describe('When stored credentials were last replaced.'),
    productionAllowed: z
      .boolean()
      .describe('PLAID_ALLOW_PRODUCTION: whether `production` may be stored or used (D16).'),
  })
  .meta({ id: 'PlaidCredentialsStatus' });

type CredentialsStatus = z.infer<typeof credentialsStatus>;

/**
 * A pasted Plaid client id / secret: hex in practice. Lenient on purpose (a
 * length range of URL-safe characters), strict about what a paste artefact looks
 * like: whitespace and quotes are trimmed or refused, never stored.
 */
const credentialValue = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, hyphen and underscore only');

const putBody = z.object({
  clientId: credentialValue.describe('Plaid client_id.'),
  secret: credentialValue.describe('Plaid secret for the chosen environment. Never echoed back.'),
  env: z.enum(PROVIDER_CREDENTIAL_ENVS),
});

/** The audit kinds. `@ctx/identity` owns the union; see the report's wiring note. */
const EVENT_KIND = {
  set: 'provider_credentials.set',
  rotated: 'provider_credentials.rotated',
  removed: 'provider_credentials.removed',
} as const;

export const providerCredentialRoutes = (
  deps: RouteDeps,
  stored: StoredPlaid,
): FastifyPluginAsyncZod => {
  const { guards, database, pool, clock } = deps;

  async function audit(
    kind: (typeof EVENT_KIND)[keyof typeof EVENT_KIND],
    outcome: 'success' | 'failure' | 'blocked',
    userId: string,
    detail: Record<string, unknown>,
    context: RequestContext,
  ): Promise<void> {
    await recordSecurityEvent(pool, clock, {
      // WP; the column is free text. The cast is removed when the three kinds are
      // added to the union (wiring item in docs/evidence/phase-10/wp10.1).
      kind: kind,
      outcome,
      userId,
      detail,
      context,
    });
  }

  async function statusFor(userId: string): Promise<CredentialsStatus> {
    const productionAllowed = stored.allowProduction;
    if (stored.filesConfigured) {
      return {
        configured: true,
        source: 'files',
        env: stored.filesEnvironment,
        clientIdHint: null,
        rotatedAt: null,
        productionAllowed,
      };
    }
    const row = await mapDomainErrors(() =>
      getProviderCredentialStatus(database, userId, PLAID_PROVIDER),
    );
    if (row === null) {
      return {
        configured: false,
        source: 'none',
        env: null,
        clientIdHint: null,
        rotatedAt: null,
        productionAllowed,
      };
    }
    const { registry } = deps.connections();
    return {
      configured: await registry.hasFor(PLAID_PROVIDER, userId),
      source: 'stored',
      env: row.env,
      clientIdHint: row.clientIdHint,
      rotatedAt: row.rotatedAt === null ? null : row.rotatedAt.toISOString(),
      productionAllowed,
    };
  }

  return async (app) => {
    app.get(
      '/connections/providers/plaid/credentials',
      {
        schema: {
          operationId: 'getPlaidCredentials',
          summary: 'Where Plaid is configured from, without the secret',
          description:
            "Whether Plaid is usable, and whether that is the operator's secret files " +
            '(read-only), this holder’s stored credentials, or neither. Carries the environment ' +
            'and the last four characters of the stored client id. The secret is never returned.',
          tags: ['connections'],
          response: { 200: credentialsStatus, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return statusFor(session.userId);
      },
    );

    app.put(
      '/connections/providers/plaid/credentials',
      {
        schema: {
          operationId: 'putPlaidCredentials',
          summary: 'Store (or replace) this holder’s Plaid credentials',
          description:
            'Needs a step-up assertion (D21). Checks the credentials against Plaid (a Link token ' +
            'request: authenticated, free) before sealing them under the KEK. Refused with 409 ' +
            "when the operator's secret files configure Plaid, 403 for `production` without " +
            'PLAID_ALLOW_PRODUCTION, 422 when Plaid rejects the credentials, 502 when Plaid ' +
            'cannot be reached. The response is the same shape as the GET; the secret is never ' +
            'returned.',
          tags: ['connections'],
          body: putBody,
          response: { 200: credentialsStatus, ...problems(400, 401, 403, 409, 422, 502, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { secretBox, registry } = deps.connections();
        const { clientId, secret, env } = request.body;
        const requestContext = guards.contextOf(request);

        if (stored.filesConfigured) {
          throw new AppError({
            status: 409,
            code: 'provider_credentials.managed_by_files',
            title: 'Conflict',
            detail:
              "Plaid is configured by the operator's secret files, which take precedence. Remove " +
              'plaid_client_id and plaid_secret from the secrets directory to use stored credentials.',
            family: 'domain',
          });
        }
        if (env === 'production' && !stored.allowProduction) {
          await audit(
            EVENT_KIND.set,
            'blocked',
            session.userId,
            { provider: PLAID_PROVIDER, env, reason: 'production_not_allowed' },
            requestContext,
          ).catch(() => undefined);
          throw new AppError({
            status: 403,
            code: 'provider_credentials.production_refused',
            title: 'Forbidden',
            detail:
              'Plaid Production is off for this install. Choose sandbox, or set ' +
              'PLAID_ALLOW_PRODUCTION=true and restart (D16).',
            family: 'domain',
          });
        }

        // Validate before sealing: nothing is stored for a key Plaid does not accept.
        try {
          await stored
            .buildConnector({ clientId, secret, environment: env })
            .createLinkToken({ clientUserId: session.userId });
        } catch (error) {
          const rejected =
            error instanceof ConnectorError &&
            (error.condition === 'CONFIG_ERROR' ||
              error.kind === 'invalid_input' ||
              error.kind === 'auth_required' ||
              error.kind === 'permanent');
          await audit(
            EVENT_KIND.set,
            'failure',
            session.userId,
            {
              provider: PLAID_PROVIDER,
              env,
              reason: rejected ? 'rejected_by_plaid' : 'plaid_unreachable',
            },
            requestContext,
          ).catch(() => undefined);
          // Fixed copy only: a provider's prose, or the thrown error itself, is
          // never repeated to the client or logged from here.
          if (rejected) {
            const code = error.providerCode;
            throw new AppError({
              status: 422,
              code: 'provider_credentials.rejected',
              title: 'Unprocessable Content',
              detail:
                'Plaid did not accept these credentials' +
                (code === null || !/^[A-Z_]{3,64}$/.test(code) ? '' : ` (${code})`) +
                '. Check that the client id and the secret are the ones for the chosen environment.',
              family: 'connector',
            });
          }
          throw new AppError({
            status: 502,
            code: 'provider_credentials.provider_unavailable',
            title: 'Bad Gateway',
            detail: 'Plaid could not be reached to check these credentials. Nothing was saved.',
            family: 'connector',
          });
        }

        const result = await mapDomainErrors(() =>
          database.transaction((tx) =>
            setProviderCredentials(
              tx,
              { provider: PLAID_PROVIDER, clientId, secret, env, secretBox },
              contextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        // This process sees the new credentials at once; the worker's consumer
        // drops its own cache when the event reaches it.
        registry.invalidate(PLAID_PROVIDER);
        await audit(
          result.rotated ? EVENT_KIND.rotated : EVENT_KIND.set,
          'success',
          session.userId,
          { provider: PLAID_PROVIDER, env, clientIdHint: result.status.clientIdHint },
          requestContext,
        );
        return statusFor(session.userId);
      },
    );

    app.delete(
      '/connections/providers/plaid/credentials',
      {
        schema: {
          operationId: 'deletePlaidCredentials',
          summary: 'Remove this holder’s stored Plaid credentials',
          description:
            'Needs a step-up assertion (D21). Deletes the sealed row and retires its key. Revokes ' +
            'nothing at Plaid: the key stays valid there until rolled in the Plaid dashboard, and ' +
            'connections linked with it stop syncing. Idempotent. Returns the GET shape.',
          tags: ['connections'],
          response: { 200: credentialsStatus, ...problems(401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { secretBox, registry } = deps.connections();
        const before = await mapDomainErrors(() =>
          getProviderCredentialStatus(database, session.userId, PLAID_PROVIDER),
        );
        const removed = await mapDomainErrors(() =>
          database.transaction((tx) =>
            removeProviderCredentials(
              tx,
              { provider: PLAID_PROVIDER },
              contextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        // Even when nothing was removed: a cached answer is never worth keeping
        // across a holder saying "remove it".
        registry.invalidate(PLAID_PROVIDER);
        if (removed) {
          // After the delete committed: retiring a key is not transactional, and a
          // rolled-back delete with a retired key would strand a row nobody can open.
          await eraseCredentialKey(secretBox, session.userId, PLAID_PROVIDER).catch(
            () => undefined,
          );
          await audit(
            EVENT_KIND.removed,
            'success',
            session.userId,
            {
              provider: PLAID_PROVIDER,
              env: before?.env ?? null,
              clientIdHint: before?.clientIdHint ?? null,
            },
            guards.contextOf(request),
          );
        }
        return statusFor(session.userId);
      },
    );
  };
};
