// SPDX-License-Identifier: MIT
/**
 * `/connections/plaid/*` — the two Plaid-specific link-token calls, plus the
 * dedicated exchange route the WP 1.6 UI (`plaid-link.ts`, `PlaidConnectCard`,
 * `ReconnectDialog`) is already shaped to call.
 *
 * ## Why these exist beside the generic `/connections` routes
 *
 * `POST /connections` already links *any* registered provider, Plaid included,
 * once `domain.ts` registers it. What the generic route cannot do is hand back
 * a Plaid `link_token` before a public token exists — that is `createLinkToken`
 * / `createUpdateLinkToken` on `PlaidConnector`, which are not on the `Connector`
 * port (a provider-hosted flow needs a step *before* `connect`'s completion
 * artifact) and so have no generic route to live behind. `POST
 * /connections/plaid/exchange` is a thin, Plaid-shaped wrapper around
 * `linkConnection` (`routes/connections.ts`) with a body that matches exactly
 * what Plaid Link's `onSuccess` callback hands the browser, so the frontend
 * never has to construct the generic `{ provider, input }` envelope by hand.
 *
 * ## Step-up
 *
 * `link-token` and `update-link-token` only ever *read* — they ask Plaid to
 * mint an ephemeral, single-use token addressed to this user and this
 * deployment; nothing in this application changes as a result, and a stolen
 * session cookie that requested one could not do anything with it that
 * `GET /connectors` did not already reveal. `update-link-token` additionally
 * opens the connection's sealed credential to build the request (`openHandle`),
 * which is a good enough reason to ask for the same step-up `reconnect` already
 * requires. `exchange` stores a new credential and creates a connection — the
 * same step-up `POST /connections` requires, for the same reason (D21).
 *
 * ## The ratchet (D16)
 *
 * Trial's ten-Item cap is Plaid's, not ours, but `/item/remove` does not free a
 * slot, so refusing an eleventh **local** Plaid connection before spending a
 * real Item on it is the only place this application can make that fact
 * legible instead of a bill. Every row ever created with `provider = 'plaid'`
 * counts, including a disconnected one: `DELETE /connections/{id}` may leave
 * `providerSlotMayRemain: true` (wp1.5-api.md §1), so a locally "gone"
 * connection can still hold a Plaid slot.
 *
 * **Enforced in `linkConnection` (`routes/connections.ts`), not here.** The
 * gate (R-7, gate-security-review.md §5.2/§6 C-3) found the check only in this
 * route's handler — so `POST /connections` with `provider: "plaid"` reached a
 * real Item exchange with no ratchet consulted at all, and the count run here
 * was scoped to one user while Plaid's cap is per deployment. This route no
 * longer runs its own check; `linkConnection` runs one, before it ever calls
 * `connector.connect`, counted with `countConnectionsByProvider` across every
 * user and every status. `PLAID_ITEM_LIMIT` is imported from there so this
 * route's description below names the same number rather than a second
 * constant that could drift from it.
 */
import { PLAID_PROVIDER, PlaidConnector } from '@connector/plaid';
import { openHandle, requireConnection } from '@ctx/connections';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import { linkConnection, linkResultSchema, PLAID_ITEM_LIMIT } from './connections.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

export { PLAID_ITEM_LIMIT };

function plaidUnavailable(): AppError {
  return new AppError({
    status: 503,
    code: 'connections.unknown_provider',
    title: 'Service Unavailable',
    detail: 'The Plaid connector is not registered in this deployment.',
    family: 'internal',
  });
}

function notAPlaidConnection(): AppError {
  return new AppError({
    status: 404,
    code: 'connections.not_found',
    title: 'Not Found',
    detail: 'No Plaid connection with that id.',
    family: 'user',
  });
}

async function requirePlaidConnector(deps: RouteDeps, userId: string): Promise<PlaidConnector> {
  const { registry } = deps.connections();
  // Per holder (WP 10.1): the credentials may be the holder's own, stored in the product.
  if (!(await registry.hasFor(PLAID_PROVIDER, userId))) throw plaidUnavailable();
  const connector = await registry.connectorFor(PLAID_PROVIDER, userId);
  if (!(connector instanceof PlaidConnector)) throw plaidUnavailable();
  return connector;
}

const linkTokenResponse = z
  .object({
    linkToken: z.string(),
    expiresAt: isoInstant,
  })
  .meta({ id: 'PlaidLinkToken' });

const exchangeBody = z.object({
  publicToken: z.string().min(1).describe("Plaid Link's onSuccess callback argument."),
  institutionName: z
    .string()
    .min(1)
    .nullish()
    .describe("From Link's own metadata; falls back to /item/get when omitted."),
});

const updateLinkTokenBody = z.object({
  accountSelectionEnabled: z
    .boolean()
    .optional()
    .describe(
      '01 §1.7: any de-selected account stops being shared. Off by default so a routine ' +
        'reauth cannot silently drop an account.',
    ),
});

export const plaidRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  return async (app) => {
    app.post(
      '/connections/plaid/link-token',
      {
        schema: {
          operationId: 'createPlaidLinkToken',
          summary: 'A Plaid Link token for a new connection',
          description:
            "Step one of a provider-hosted link (08 §3.6): the pins are `PlaidConnector`'s own " +
            '(products transactions+investments+liabilities, 730 days, PFC v2, the configured ' +
            'redirect_uri) — see wp1.3-plaid.md §1. Read-only: nothing in this application changes ' +
            'as a result of calling it.',
          tags: ['connections'],
          response: { 200: linkTokenResponse, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const connector = await requirePlaidConnector(deps, session.userId);
        const token = await mapDomainErrors(() =>
          connector.createLinkToken({ clientUserId: session.userId }),
        );
        return { linkToken: token.linkToken, expiresAt: token.expiresAt.toISOString() };
      },
    );

    app.post(
      '/connections/plaid/exchange',
      {
        schema: {
          operationId: 'exchangePlaidPublicToken',
          summary: 'Finish a Plaid Link flow and create the connection',
          description:
            'Needs a step-up assertion (D21) — this is the moment a real credential is stored, ' +
            'exactly like `POST /connections`. Exchanges the public token, creates (or re-links) ' +
            'the connection, and schedules the first sync through the orchestrator. Refuses an ' +
            `eleventh Plaid connection (D16: Trial's ${String(PLAID_ITEM_LIMIT)}-Item cap; ` +
            '`/item/remove` does not free a slot, so this counts every Plaid row ever created, ' +
            'including a disconnected one).',
          tags: ['connections'],
          body: exchangeBody,
          response: { 201: linkResultSchema, ...problems(400, 401, 403, 409, 502, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        await requirePlaidConnector(deps, session.userId);

        // The ratchet itself lives in `linkConnection` now (R-7, C-3) — see the
        // file comment. Duplicating the count-and-refuse here would be a second
        // copy that could drift, and it already did once: this route's own
        // check counted only `session.userId`'s rows against a per-deployment
        // cap.
        const result = await linkConnection(
          deps,
          session.userId,
          String(request.id),
          {
            provider: PLAID_PROVIDER,
            input: {
              publicToken: request.body.publicToken,
              institutionName: request.body.institutionName ?? null,
            },
          },
          null,
        );
        return reply.code(201).send(result);
      },
    );

    app.post(
      '/connections/:connectionId/plaid/update-link-token',
      {
        schema: {
          operationId: 'createPlaidUpdateLinkToken',
          summary: 'A Plaid Link token in update mode, for reconnect',
          description:
            "Needs a step-up assertion: it opens the connection's sealed credential to build the " +
            'request. 01 §1.7: "the access_token does not change when using Link in update mode" — ' +
            'no `products` on the wire (a `products` array in update mode re-initialises the ' +
            "Item's product set and can re-bill it — wp1.3-plaid.md §1), and nothing here needs " +
            're-sealing. Completing the reauth still goes through the existing ' +
            '`POST /connections/{id}/reconnect`.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          body: updateLinkTokenBody,
          response: { 200: linkTokenResponse, ...problems(400, 401, 403, 404, 502, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { secretBox } = deps.connections();
        const connector = await requirePlaidConnector(deps, session.userId);
        const row = await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.params.connectionId),
        );
        if (row.provider !== PLAID_PROVIDER) throw notAPlaidConnection();

        const handle = await openHandle(row, secretBox, session.userId);
        const token = await mapDomainErrors(() =>
          connector.createUpdateLinkToken(handle, {
            ...(request.body.accountSelectionEnabled === undefined
              ? {}
              : { accountSelectionEnabled: request.body.accountSelectionEnabled }),
          }),
        );
        return { linkToken: token.linkToken, expiresAt: token.expiresAt.toISOString() };
      },
    );
  };
};
