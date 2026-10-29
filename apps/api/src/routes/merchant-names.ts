// SPDX-License-Identifier: MIT
/**
 * `/merchants/name-suggestions` — WP 11.6's merchant display-name suggestions,
 * as HTTP: the holder's open suggestions (with whether any could be asked for
 * now, and why not), and their Accept and Dismiss.
 *
 * **This process never calls a model.** Its `merchant.name` runtime is the
 * preview-mode one (`createMerchantNameRuntime({ mode: 'preview' })`): it
 * resolves the holder's local model only to read its template hash, which keys
 * the approval the availability reports. The worker's nightly job asks.
 *
 * **Accept is the manual rename.** It writes `user_merchant_name` through
 * `setTransactionOverlay` on every transaction of the merchant the holder has
 * not renamed (`@ctx/ledger`'s `acceptMerchantNameSuggestion`), and needs what
 * the manual rename needs — a session (`PATCH /transactions/{id}` asks no
 * step-up), with the CSRF check every unsafe method carries. Nothing is
 * applied without it.
 */
import {
  MERCHANT_NAME_LIST_MAX,
  acceptMerchantNameSuggestion,
  dismissMerchantNameSuggestion,
  listMerchantNameCandidates,
  listMerchantNameSuggestions,
  type MerchantNameSuggestionView,
} from '@ctx/ledger';
import { merchantNameUnavailable, type RunSwitches } from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { MerchantNameRuntime } from '../merchant-names.ts';
import { problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

export const MERCHANT_NAME_UNAVAILABLE_REASONS = [
  'off',
  'not_configured',
  'hosted_narrator',
  'key_unopenable',
  'endpoint_refused',
  'advisors_disabled',
  'module_disabled',
  'kind_disabled',
  'advisor_disabled',
  'advisor_quarantined',
  'payload_not_approved',
] as const;

const suggestionSchema = z
  .object({
    id: z.uuid(),
    merchantId: z
      .uuid()
      .nullable()
      .describe(
        'The merchant the key names now; the rows whose `merchantId` this is carry the chip.',
      ),
    descriptor: z
      .string()
      .describe('The bank’s text as the app cleaned it: exactly what the model saw.'),
    strippedPrefix: z.string().nullable(),
    status: z.enum(['suggested', 'accepted']),
    displayName: z
      .string()
      .describe(
        'Validated: made only of words of `descriptor`, in its order; at most 40 characters.',
      ),
    provider: z
      .literal('ollama')
      .describe('Always the local model: this query type has no hosted path.'),
    model: z.string(),
    suggestedAt: isoInstant,
    decidedAt: isoInstant.nullable(),
  })
  .meta({ id: 'MerchantNameSuggestion' });

const availabilitySchema = z
  .object({
    available: z.boolean().describe('A suggestion could be asked for tonight.'),
    reason: z
      .enum(MERCHANT_NAME_UNAVAILABLE_REASONS)
      .nullable()
      .describe(
        'Why not: the narrator is Off, no local model, a hosted narrator (merchant names stay on ' +
          'this machine), a switch, or `payload_not_approved` until the shape is approved in Advisors.',
      ),
    provider: z.literal('ollama').nullable(),
    model: z.string().nullable(),
  })
  .meta({ id: 'MerchantNameAvailability' });

function serialise(row: MerchantNameSuggestionView): z.infer<typeof suggestionSchema> | null {
  if ((row.status !== 'suggested' && row.status !== 'accepted') || row.displayName === null) {
    return null;
  }
  return {
    id: row.id,
    merchantId: row.merchantId,
    descriptor: row.descriptor,
    strippedPrefix: row.strippedPrefix,
    status: row.status,
    displayName: row.displayName,
    provider: 'ollama',
    model: row.llmModel,
    suggestedAt: row.suggestedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
  };
}

export interface MerchantNameRouteOptions {
  /** The api's preview-mode runtime: resolves and renders, never calls a model. */
  readonly runtime: MerchantNameRuntime;
  readonly switches: RunSwitches;
}

export const merchantNameRoutes = (
  deps: RouteDeps,
  options: MerchantNameRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  return async (app) => {
    app.get(
      '/merchants/name-suggestions',
      {
        schema: {
          operationId: 'listMerchantNameSuggestions',
          summary: 'Merchant name suggestions: the open ones, and whether more can be asked for',
          description:
            'WP 11.6. `items`: this holder’s suggested and accepted names, each shown beside the ' +
            'bank’s text on the rows of its merchant. `pending`: noise merchants not asked about ' +
            'yet. `availability`: whether the nightly pass could ask now, and why not. Reads only.',
          tags: ['transactions'],
          response: {
            200: z.object({
              availability: availabilitySchema,
              items: z.array(suggestionSchema),
              pending: z.array(
                z.object({ merchantId: z.uuid(), descriptor: z.string() }).meta({
                  id: 'MerchantNamePending',
                }),
              ),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const resolution = await options.runtime.resolve(session.userId);
        const gated =
          resolution.adapter === null
            ? null
            : await merchantNameUnavailable(database, options.switches, {
                userId: session.userId,
                templateHash: resolution.adapter.templateHash,
              });
        const reason = resolution.reason ?? gated;
        const rows = await listMerchantNameSuggestions(database, session.userId, {
          statuses: ['suggested', 'accepted'],
        });
        const pending = await listMerchantNameCandidates(database, session.userId, {
          limit: MERCHANT_NAME_LIST_MAX,
        });
        return {
          availability: {
            available: reason === null,
            reason: reason as (typeof MERCHANT_NAME_UNAVAILABLE_REASONS)[number] | null,
            provider: resolution.adapter === null ? null : ('ollama' as const),
            model: resolution.adapter?.label ?? null,
          },
          items: rows.flatMap((row) => {
            const item = serialise(row);
            return item === null ? [] : [item];
          }),
          pending: pending.candidates.map((candidate) => ({
            merchantId: candidate.merchantId,
            descriptor: candidate.descriptor,
          })),
        };
      },
    );

    app.post(
      '/merchants/name-suggestions/:suggestionId/accept',
      {
        schema: {
          operationId: 'acceptMerchantNameSuggestion',
          summary: 'Accept a merchant name: rename the merchant’s transactions to it',
          description:
            'Writes the holder’s payee name (`user_merchant_name`, the overlay `PATCH ' +
            '/transactions/{id}` writes) on every transaction of the merchant the holder has not ' +
            'renamed, in one transaction; a name the holder typed is kept. Re-runnable on an ' +
            'accepted suggestion, for rows that arrived since. 409 ' +
            '`ledger.merchant_name_suggestion_closed` when dismissed or refused.',
          tags: ['transactions'],
          params: z.object({ suggestionId: z.uuid() }),
          response: {
            200: z.object({ suggestion: suggestionSchema, renamed: z.int().nonnegative() }),
            ...problems(400, 401, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const accepted = await mapDomainErrors(() =>
          acceptMerchantNameSuggestion(
            database,
            { userId: session.userId, suggestionId: request.params.suggestionId },
            { clock, correlationId: String(request.id) },
          ),
        );
        const suggestion = serialise(accepted.suggestion);
        if (suggestion === null) throw new Error('an accepted suggestion always carries its name');
        return { suggestion, renamed: accepted.renamed };
      },
    );

    app.post(
      '/merchants/name-suggestions/:suggestionId/dismiss',
      {
        schema: {
          operationId: 'dismissMerchantNameSuggestion',
          summary:
            'Dismiss a merchant name: it is not shown again, and the merchant is not asked about again',
          description:
            'Records the dismissal. A rename an earlier Accept made stays (it is the holder’s ' +
            'overlay now). 409 `ledger.merchant_name_suggestion_closed` when already dismissed or refused.',
          tags: ['transactions'],
          params: z.object({ suggestionId: z.uuid() }),
          response: {
            200: z.object({ outcome: z.literal('dismissed'), suggestionId: z.uuid() }),
            ...problems(400, 401, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const dismissed = await mapDomainErrors(() =>
          dismissMerchantNameSuggestion(
            database,
            { userId: session.userId, suggestionId: request.params.suggestionId },
            { clock, correlationId: String(request.id) },
          ),
        );
        return { outcome: 'dismissed' as const, suggestionId: dismissed.id };
      },
    );
  };
};
