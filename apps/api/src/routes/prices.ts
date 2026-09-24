// SPDX-License-Identifier: MIT
/**
 * `/prices/{securityId}` — 07 §6.1's ladder, as HTTP, and the rung-1 override.
 *
 * WP 3.9. The `GET` answers *"what is this worth, how do we know, and how old is
 * that?"* in one payload, because those three questions are never asked
 * separately and a client that had to join them would join them differently on
 * each screen:
 *
 *   * **`rung`** — which of `user_override → exchange_fill → provider →
 *     last_known` answered.
 *   * **`carriedForward`** — no observation existed for the date asked for, so
 *     an earlier one was used. `last_known` is a *label*, never a stored row
 *     (`prices_source_is_an_observation`), and this field is where it surfaces.
 *   * **`staleness`** — 07 §6.1's 24-hour rule, computed against the clock at
 *     read time. It is a **field**, so `'a stale price is labeled in the
 *     response rather than silently fresh'` is an assertion about the payload
 *     rather than about a date arithmetic a client was trusted to do.
 *
 * ## The `PUT` needs a step-up assertion
 *
 * A user price override is **rung 1**: it outranks the exchange fill, every
 * provider and the carry-forward, and the migration pins that rung with a CHECK
 * rather than trusting a seed. A write that can silently restate what a
 * portfolio is worth — and therefore what the net-worth series, the allocation
 * and every advisor reading them will say — is closer to
 * `connections.ts`'s "attach or destroy" than to a category edit. So
 * `requireFreshSession`, the same guard `POST /connections` carries.
 *
 * Nothing here recomputes history from today's price (07 §6.1). The override is
 * written **for the date the user names**, with `observed_at = now` — because
 * the 24-hour rule asks how old the *information* is, and a number typed thirty
 * seconds ago about last Tuesday's close is thirty seconds old.
 */
import type { Database } from '@core/db';
import { currency as toCurrency } from '@core/kernel';
import { recordUserPriceOverride, type PricePoint } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { dateOnly } from '../wire.ts';
import type { RouteDeps } from './deps.ts';
import { BASE_CURRENCY, priceReaderFor, todayFor } from './investments.ts';

/** The security, or `null` — scoped by `user_id`, which is the whole check. */
async function securityKindOf(
  database: Database,
  userId: string,
  securityId: string,
): Promise<{ readonly type: string; readonly ticker: string | null } | null> {
  const result = await database.execute<{ type: string; ticker: string | null }>(sql`
    SELECT type, ticker FROM securities
     WHERE id = ${securityId}::uuid AND user_id = ${userId}::uuid
     LIMIT 1
  `);
  return result.rows[0] ?? null;
}

interface ObservationRow extends Record<string, unknown> {
  price_date: string;
  close: string;
  currency: string;
  source: string;
  stale: boolean;
  observed_at: Date | string;
}

const priceWire = z.object({
  securityId: z.uuid(),
  /** The observation used. Not necessarily `asOf`. */
  priceDate: dateOnly,
  close: z.string(),
  currency: z.string().length(3),
  rung: z.string(),
  source: z.string().nullable(),
  carriedForward: z.boolean(),
  providerCarriedForward: z.boolean(),
  observedAt: z.string(),
  /** 07 §6.1's 24-hour verdict, computed at read time. A field, never inferred. */
  staleness: z.enum(['FRESH', 'STALE']),
  includeInAsOfNowDeltas: z.boolean(),
});

function pointWireOf(point: PricePoint): z.infer<typeof priceWire> {
  return {
    securityId: point.securityId,
    priceDate: point.priceDate,
    close: point.close,
    currency: point.currency,
    rung: point.rung,
    source: point.source,
    carriedForward: point.carriedForward,
    providerCarriedForward: point.providerCarriedForward,
    observedAt: point.observedAt.toISOString(),
    staleness: point.staleness,
    includeInAsOfNowDeltas: point.includeInAsOfNowDeltas,
  };
}

/** How many raw observations the `GET` shows beside the ladder's answer. */
const OBSERVATION_LIMIT = 20;

export const priceRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  const requireSecurity = async (
    userId: string,
    securityId: string,
  ): Promise<{ readonly type: string; readonly ticker: string | null }> => {
    const found = await securityKindOf(database, userId, securityId);
    if (found === null) {
      throw new AppError({
        status: 404,
        code: 'investments.security_not_found',
        title: 'Not Found',
        detail: `no security ${securityId}`,
        family: 'user',
      });
    }
    return found;
  };

  return async (app) => {
    app.get(
      '/prices/:securityId',
      {
        schema: {
          operationId: 'getPrice',
          summary: 'The best price for one security on one date, and which rung answered',
          description:
            'The ladder’s answer plus the raw observations behind it. `staleness` is a field: ' +
            '07 §6.1’s 24-hour rule is a statement about the clock at read time, and a client ' +
            'deriving it from `observedAt` would derive it against a different clock.',
          tags: ['investments'],
          params: z.object({ securityId: z.uuid() }),
          querystring: z.object({
            asOf: dateOnly.optional(),
            currency: z.string().length(3).optional(),
          }),
          response: {
            200: z.object({
              securityId: z.uuid(),
              asOf: dateOnly,
              currency: z.string().length(3),
              /** `null` when no rung can answer at all — an ordinary state, not an error. */
              price: priceWire.nullable(),
              observations: z.array(
                z.object({
                  priceDate: dateOnly,
                  close: z.string(),
                  currency: z.string().length(3),
                  source: z.string(),
                  /** The *provider* served a carry-forward. Not the clock rule. */
                  providerCarriedForward: z.boolean(),
                  observedAt: z.string(),
                }),
              ),
            }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const security = await requireSecurity(session.userId, request.params.securityId);
        const asOf = request.query.asOf ?? (await todayFor(deps));
        const quote = toCurrency((request.query.currency ?? BASE_CURRENCY).toUpperCase());

        const reader = priceReaderFor(
          database,
          session.userId,
          clock,
          new Map([[request.params.securityId, security.type]]),
        );
        const point = await reader.price(request.params.securityId, asOf, quote);

        const rows = await database.execute<ObservationRow>(sql`
          SELECT to_char(price_date, 'YYYY-MM-DD') AS price_date,
                 close, currency, source, stale, observed_at
            FROM prices
           WHERE user_id = ${session.userId}::uuid
             AND security_id = ${request.params.securityId}::uuid
             AND currency = ${quote}
             AND price_date <= ${asOf}::date
           ORDER BY price_date DESC, observed_at DESC
           LIMIT ${OBSERVATION_LIMIT}
        `);

        return {
          securityId: request.params.securityId,
          asOf,
          currency: quote,
          price: point === null ? null : pointWireOf(point),
          observations: rows.rows.map((row) => ({
            priceDate: String(row.price_date).slice(0, 10),
            close: String(row.close),
            currency: row.currency,
            source: row.source,
            providerCarriedForward: row.stale,
            observedAt: new Date(row.observed_at).toISOString(),
          })),
        };
      },
    );

    app.put(
      '/prices/:securityId',
      {
        schema: {
          operationId: 'putPriceOverride',
          summary: 'Write the rung-1 user price override for one security and date',
          description:
            'Needs a step-up assertion: this is rung 1 of 07 §6.1’s ladder and outranks every ' +
            'provider, so it silently restates what the portfolio is worth. `close` is a ' +
            'decimal string — never a JSON number (D3). The write is an upsert on ' +
            '`(user, security, date, source, currency)`, so correcting a typo produces one row ' +
            'rather than two the ladder then has to choose between.',
          tags: ['investments'],
          params: z.object({ securityId: z.uuid() }),
          body: z.object({
            priceDate: dateOnly,
            close: z
              .string()
              .regex(/^\d*\.?\d+$/u, 'a price is a non-negative plain decimal string'),
            currency: z.string().length(3).optional(),
          }),
          response: {
            200: z.object({
              securityId: z.uuid(),
              priceDate: dateOnly,
              currency: z.string().length(3),
              /** Read back through the ladder, so the caller sees what it will now answer. */
              price: priceWire.nullable(),
            }),
            ...problems(400, 401, 403, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const security = await requireSecurity(session.userId, request.params.securityId);
        const quote = toCurrency((request.body.currency ?? BASE_CURRENCY).toUpperCase());

        await recordUserPriceOverride(
          database,
          session.userId,
          {
            securityId: request.params.securityId,
            priceDate: request.body.priceDate,
            close: request.body.close,
            currency: quote,
          },
          clock,
        );

        const reader = priceReaderFor(
          database,
          session.userId,
          clock,
          new Map([[request.params.securityId, security.type]]),
        );
        const point = await reader.price(request.params.securityId, request.body.priceDate, quote);

        return {
          securityId: request.params.securityId,
          priceDate: request.body.priceDate,
          currency: quote,
          price: point === null ? null : pointWireOf(point),
        };
      },
    );
  };
};
