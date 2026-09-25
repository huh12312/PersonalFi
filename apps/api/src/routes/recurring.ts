// SPDX-License-Identifier: MIT
/**
 * `/recurring/*` — subscriptions and bills, as HTTP.
 *
 * WP 2.3 shipped `@ctx/recurring`'s candidate pipeline, forecast and lifecycle
 * with no REST surface (02-phase-2-dispatch.md §3, WP 2.10's "routes consumed");
 * this file is that surface.
 *
 * Session-only: confirming, rejecting and merging are the user answering a
 * question about their own transaction history, the same shape of write as the
 * categorisation rule language `rules.ts` already treats this way — never a
 * credential, so decision D21's step-up gate does not apply.
 */
import { DateOnly, Money, todayIn } from '@core/kernel';
import {
  confirmCandidate,
  forwardCashFlow,
  listCandidates,
  listPriceChangeEventsBySeries,
  listSeries,
  mergeSeries,
  rejectCandidate,
  safeToSpend,
  upcomingCalendar,
  type PriceChangeEventView,
  type ProjectedCharge,
  type RecurringContext,
} from '@ctx/recurring';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createBudgetingLedgerPort } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { dateOnlyQuery, idList, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

/**
 * The cash on hand a safe-to-spend figure is measured against: the sum of
 * every on-budget CASH account's latest balance, through `@ctx/budgeting`'s
 * own ledger port (the same reader the budget screen uses), rather than a
 * second read of `@ctx/ledger`. A client that wants a different figure — a
 * specific account, a manual override — passes `availableCash` explicitly.
 */
async function defaultAvailableCash(deps: RouteDeps, userId: string) {
  const accounts = await createBudgetingLedgerPort(deps.database).listBudgetAccounts({ userId });
  const cash = accounts.filter(
    (account) => account.role === 'CASH' && !account.closed && account.workingBalance !== null,
  );
  const balances = cash
    .map((account) => account.workingBalance)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const currency = balances[0]?.currency ?? 'USD';
  return Money.sum(balances, currency);
}

const projectedChargeSchema = z
  .object({
    seriesId: z.uuid(),
    streamKey: z.string(),
    merchantId: z.string(),
    type: z.string(),
    cadence: z.string(),
    sign: z.enum(['OUTFLOW', 'INFLOW']),
    status: z.string(),
    userConfirmed: z.boolean(),
    confidence: z.number(),
    slot: z.int(),
    date: z.string(),
    earliest: z.string(),
    latest: z.string(),
    uncertaintyDays: z.int(),
    expected: moneySchema,
    low: moneySchema,
    high: moneySchema,
  })
  .meta({ id: 'RecurringProjectedCharge' });

/**
 * `wp3.14-carryovers.md` item 4 (`wp3.13-carryovers.md` §1 row 8b): a
 * `price_change_events` row, on the wire. `fromAmount`/`toAmount` are the two
 * observed prices; `deltaAmount` and `annualImpact` are magnitudes, matching
 * the schema column comment ("Magnitudes, not signed amounts") — `direction`
 * is what carries the sign.
 */
const priceChangeEventSchema = z
  .object({
    id: z.uuid(),
    direction: z.enum(['INCREASE', 'DECREASE']),
    effectiveDate: z.string(),
    fromAmount: moneySchema,
    toAmount: moneySchema,
    deltaAmount: moneySchema,
    annualImpact: moneySchema,
    confirmed: z.boolean(),
  })
  .meta({ id: 'RecurringPriceChangeEvent' });

const seriesSchema = z
  .object({
    id: z.uuid(),
    streamKey: z.string(),
    merchantId: z.string(),
    state: z.string(),
    status: z.string(),
    userConfirmed: z.boolean(),
    cadence: z.string(),
    type: z.string(),
    sign: z.enum(['OUTFLOW', 'INFLOW']),
    confidence: z.number(),
    typicalAmount: moneySchema,
    observedMin: moneySchema,
    observedMax: moneySchema,
    nextDueDate: z.string().nullable(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    duplicateNode: z.string().nullable(),
    /**
     * Newest-first, every recorded change — not only the latest — so a
     * screen can show a history rather than a single fact it must then
     * re-derive. `[]` for a series that has never had one, never `null`.
     */
    priceChangeEvents: z.array(priceChangeEventSchema),
  })
  .meta({ id: 'RecurringSeries' });

function priceChangeEventOf(row: PriceChangeEventView): z.infer<typeof priceChangeEventSchema> {
  return {
    id: row.id,
    direction: row.direction,
    effectiveDate: row.effectiveDate,
    fromAmount: money(row.fromAmount),
    toAmount: money(row.toAmount),
    deltaAmount: money(row.deltaAmount),
    annualImpact: money(row.annualImpact),
    confirmed: row.confirmed,
  };
}

const candidateSchema = z
  .object({
    candidateId: z.uuid(),
    seriesId: z.uuid().nullable(),
    merchantId: z.string(),
    streamKey: z.string(),
    cadence: z.string(),
    type: z.string(),
    confidence: z.number(),
    amount: moneySchema,
    proposedAt: z.string(),
  })
  .meta({ id: 'RecurringCandidate' });

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): RecurringContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

export const recurringRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  return async (app) => {
    app.get(
      '/recurring/series',
      {
        schema: {
          operationId: 'listRecurringSeries',
          summary: 'Every stream this user has, confirmed or not',
          tags: ['recurring'],
          querystring: z.object({ states: idList, types: idList, merchantIds: idList }),
          response: {
            200: z.object({ series: z.array(seriesSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await listSeries(database, {
          userId: session.userId,
          ...(request.query.states === undefined ? {} : { states: request.query.states }),
          ...(request.query.types === undefined ? {} : { types: request.query.types }),
          ...(request.query.merchantIds === undefined
            ? {}
            : { merchantIds: request.query.merchantIds }),
        });
        const priceChangesBySeries = await listPriceChangeEventsBySeries(
          database,
          session.userId,
          rows.map((row) => row.id),
        );
        return {
          series: rows.map((row) => ({
            id: row.id,
            streamKey: row.streamKey,
            merchantId: row.merchantId,
            state: row.state,
            status: row.status,
            userConfirmed: row.userConfirmed,
            cadence: row.cadence,
            type: row.type,
            sign: row.sign,
            confidence: Number(row.confidence),
            typicalAmount: money(Money.of(row.typicalAmountMinor, row.typicalAmountCurrency)),
            observedMin: money(Money.of(row.observedMinMinor, row.typicalAmountCurrency)),
            observedMax: money(Money.of(row.observedMaxMinor, row.typicalAmountCurrency)),
            nextDueDate: row.nextDueDate,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
            duplicateNode: row.duplicateNode,
            priceChangeEvents: (priceChangesBySeries.get(row.id) ?? []).map(priceChangeEventOf),
          })),
        };
      },
    );

    app.get(
      '/recurring/candidates',
      {
        schema: {
          operationId: 'listRecurringCandidates',
          summary: 'The open questions: streams nobody has confirmed or rejected yet',
          tags: ['recurring'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
          response: {
            200: z.object({ candidates: z.array(candidateSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await listCandidates(database, {
          userId: session.userId,
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return {
          candidates: rows.map((row) => ({
            candidateId: row.candidateId,
            seriesId: row.seriesId,
            merchantId: row.merchantId,
            streamKey: row.streamKey,
            cadence: row.cadence,
            type: row.type,
            confidence: row.confidence,
            amount: money(row.amount),
            proposedAt: row.proposedAt.toISOString(),
          })),
        };
      },
    );

    app.post(
      '/recurring/candidates/:candidateId/confirm',
      {
        schema: {
          operationId: 'confirmRecurringCandidate',
          summary: 'Confirm a candidate: pin its series against the detector, permanently',
          tags: ['recurring'],
          params: z.object({ candidateId: z.uuid() }),
          body: z.object({ reason: z.string().nullable().optional() }),
          response: {
            200: z.object({ seriesId: z.uuid() }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const series = await confirmCandidate(database, contextOf(deps, session.userId, request), {
          candidateId: request.params.candidateId,
          reason: request.body.reason ?? null,
        });
        if (series === null) {
          throw new AppError({
            status: 404,
            code: 'recurring.candidate_not_found',
            title: 'Not Found',
            detail: `no open candidate ${request.params.candidateId}`,
            family: 'user',
          });
        }
        return { seriesId: series.id };
      },
    );

    app.post(
      '/recurring/candidates/:candidateId/reject',
      {
        schema: {
          operationId: 'rejectRecurringCandidate',
          summary: 'Reject a candidate, permanently — never proposed again at this scope',
          tags: ['recurring'],
          params: z.object({ candidateId: z.uuid() }),
          body: z.object({
            scope: z.enum(['MERCHANT', 'STREAM']).optional(),
            reason: z.string().nullable().optional(),
          }),
          response: {
            200: z.object({
              candidateId: z.uuid(),
              merchantId: z.string(),
              scope: z.string(),
              archivedSeriesId: z.uuid().nullable(),
            }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await rejectCandidate(database, contextOf(deps, session.userId, request), {
          candidateId: request.params.candidateId,
          ...(request.body.scope === undefined ? {} : { scope: request.body.scope }),
          reason: request.body.reason ?? null,
        });
        if (result === null) {
          throw new AppError({
            status: 404,
            code: 'recurring.candidate_not_found',
            title: 'Not Found',
            detail: `no candidate ${request.params.candidateId}`,
            family: 'user',
          });
        }
        return result;
      },
    );

    app.post(
      '/recurring/series/:seriesId/merge',
      {
        schema: {
          operationId: 'mergeRecurringSeries',
          summary: 'Merge this series into another — card migration, confirmed by a human',
          description: '`:seriesId` is the source; it is archived. `targetSeriesId` survives.',
          tags: ['recurring'],
          params: z.object({ seriesId: z.uuid() }),
          body: z.object({ targetSeriesId: z.uuid(), reason: z.string().nullable().optional() }),
          response: {
            200: z.object({ targetSeriesId: z.uuid() }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const target = await mergeSeries(database, contextOf(deps, session.userId, request), {
          sourceSeriesId: request.params.seriesId,
          targetSeriesId: request.body.targetSeriesId,
          reason: request.body.reason ?? null,
        });
        if (target === null) {
          throw new AppError({
            status: 404,
            code: 'recurring.series_not_found',
            title: 'Not Found',
            detail: 'source or target series not found, or they are the same series',
            family: 'user',
          });
        }
        return { targetSeriesId: target.id };
      },
    );

    app.get(
      '/recurring/upcoming',
      {
        schema: {
          operationId: 'getRecurringUpcoming',
          summary: 'The calendar of charges expected in the next window',
          tags: ['recurring'],
          querystring: z.object({
            from: dateOnlyQuery.optional(),
            days: z.coerce.number().int().min(1).max(365).optional(),
          }),
          response: {
            200: z.object({
              from: z.string(),
              to: z.string(),
              currency: z.string(),
              chargeCount: z.int().nonnegative(),
              days: z.array(
                z.object({
                  date: z.string(),
                  outflow: moneySchema,
                  inflow: moneySchema,
                  charges: z.array(projectedChargeSchema),
                }),
              ),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(deps);
        const from = request.query.from ?? todayIn(deps.clock, timezone);
        const calendar = await upcomingCalendar(database, {
          userId: session.userId,
          from: DateOnly.parse(from),
          ...(request.query.days === undefined ? {} : { days: request.query.days }),
        });
        return {
          from: calendar.from,
          to: calendar.to,
          currency: calendar.currency,
          chargeCount: calendar.chargeCount,
          days: calendar.days.map((day) => ({
            date: day.date,
            outflow: money(day.outflow),
            inflow: money(day.inflow),
            charges: day.charges.map(serialiseCharge),
          })),
        };
      },
    );

    app.get(
      '/recurring/forecast',
      {
        schema: {
          operationId: 'getRecurringForecast',
          summary: 'The forward cash-flow forecast — a 30-day band by default',
          tags: ['recurring'],
          querystring: z.object({
            from: dateOnlyQuery.optional(),
            days: z.coerce.number().int().min(1).max(365).optional(),
          }),
          response: {
            200: z.object({
              from: z.string(),
              to: z.string(),
              currency: z.string(),
              outflow: moneySchema,
              inflow: moneySchema,
              net: moneySchema,
              netLow: moneySchema,
              netHigh: moneySchema,
              chargeCount: z.int().nonnegative(),
              charges: z.array(projectedChargeSchema),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(deps);
        const from = request.query.from ?? todayIn(deps.clock, timezone);
        const forecast = await forwardCashFlow(database, {
          userId: session.userId,
          from: DateOnly.parse(from),
          ...(request.query.days === undefined ? {} : { days: request.query.days }),
        });
        return {
          from: forecast.from,
          to: forecast.to,
          currency: forecast.currency,
          outflow: money(forecast.outflow),
          inflow: money(forecast.inflow),
          net: money(forecast.net),
          netLow: money(forecast.netLow),
          netHigh: money(forecast.netHigh),
          chargeCount: forecast.chargeCount,
          charges: forecast.charges.map(serialiseCharge),
        };
      },
    );

    app.get(
      '/recurring/safe-to-spend',
      {
        schema: {
          operationId: 'getSafeToSpend',
          summary: 'Cash on hand, minus the worst case of what recurring commitments will take',
          description:
            'Defaults `availableCash` to the sum of on-budget CASH accounts (the same reader ' +
            "`@ctx/budgeting`'s screen uses); pass it explicitly to price a hypothetical.",
          tags: ['recurring'],
          querystring: z.object({
            from: dateOnlyQuery.optional(),
            days: z.coerce.number().int().min(1).max(365).optional(),
            availableCashMinor: z
              .string()
              .regex(/^-?\d+$/u)
              .optional(),
            currency: z.string().length(3).optional(),
            countExpectedIncome: z.enum(['true', 'false']).optional(),
          }),
          response: {
            200: z.object({
              from: z.string(),
              to: z.string(),
              currency: z.string(),
              availableCash: moneySchema,
              committed: moneySchema,
              committedWorstCase: moneySchema,
              expectedIncome: moneySchema,
              safe: moneySchema,
              committedCount: z.int().nonnegative(),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(deps);
        const from = request.query.from ?? todayIn(deps.clock, timezone);
        const availableCash =
          request.query.availableCashMinor === undefined
            ? await defaultAvailableCash(deps, session.userId)
            : Money.of(BigInt(request.query.availableCashMinor), request.query.currency ?? 'USD');
        const result = await safeToSpend(database, {
          userId: session.userId,
          from: DateOnly.parse(from),
          availableCash,
          ...(request.query.days === undefined ? {} : { days: request.query.days }),
          countExpectedIncome: request.query.countExpectedIncome === 'true',
        });
        return {
          from: result.from,
          to: result.to,
          currency: result.currency,
          availableCash: money(result.availableCash),
          committed: money(result.committed),
          committedWorstCase: money(result.committedWorstCase),
          expectedIncome: money(result.expectedIncome),
          safe: money(result.safe),
          committedCount: result.committedCount,
        };
      },
    );
  };
};

function serialiseCharge(charge: ProjectedCharge): z.infer<typeof projectedChargeSchema> {
  return {
    seriesId: charge.seriesId,
    streamKey: charge.streamKey,
    merchantId: charge.merchantId,
    type: charge.type,
    cadence: charge.cadence,
    sign: charge.sign,
    status: charge.status,
    userConfirmed: charge.userConfirmed,
    confidence: charge.confidence,
    slot: charge.slot,
    date: charge.date,
    earliest: charge.earliest,
    latest: charge.latest,
    uncertaintyDays: charge.uncertaintyDays,
    expected: money(charge.expected),
    low: money(charge.low),
    high: money(charge.high),
  };
}
