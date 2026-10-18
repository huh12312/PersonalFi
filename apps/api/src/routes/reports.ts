// SPDX-License-Identifier: MIT
/**
 * `GET /reports/{spending,income,sankey,budget-vs-actual}` — read models only.
 *
 * Every number here is aggregated server-side in `apps/api/src/reports/**`;
 * this file's only job is querystring → aggregator input, and aggregator
 * output → wire shape. No route here needs step-up (decision D21's gate is for
 * credential and export writes, and a report is a read); every route needs a
 * session.
 *
 * `drillThrough` on every cell/link is `GET /transactions`'s own
 * `categoryIds`/`from`/`to` (and, on a Sankey merchant link, `merchantIds`) —
 * see `reports/drill-through.ts`'s header for why this is a reuse, not a
 * second filter language.
 */
import { DateOnly, todayIn } from '@core/kernel';
import { listCategories } from '@ctx/categorization';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadBudgetVsActual } from '../reports/budget-vs-actual.ts';
import { drillThroughForMonth, drillThroughForWindow } from '../reports/drill-through.ts';
import {
  computeCategoryMonthActivity,
  incomeRowsOf,
  spendingRowsOf,
} from '../reports/spending-income.ts';
import { computeSankey } from '../reports/sankey.ts';
import { computeSpendingPace, parseMonth, type PaceDay } from '../reports/spending-pace.ts';
import { AppError, problems } from '../problem.ts';
import { booleanQuery, dateOnlyQuery, idList, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const drillThroughSchema = z
  .object({
    categoryIds: z.array(z.uuid()).optional(),
    merchantIds: z.array(z.uuid()).optional(),
    from: z.string(),
    to: z.string(),
  })
  .meta({ id: 'ReportDrillThrough', description: 'Pass straight through to `GET /transactions`.' });

const categoryMonthCellSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    categoryId: z.uuid().nullable(),
    amount: moneySchema,
    transactionCount: z.int().nonnegative(),
    transferExcludedCount: z.int().nonnegative(),
    refundNettedCount: z.int().nonnegative(),
    drillThrough: drillThroughSchema,
  })
  .meta({ id: 'ReportCategoryMonthCell' });

const reportWindowQuery = z.object({
  from: dateOnlyQuery,
  to: dateOnlyQuery,
  categoryIds: idList,
  accountIds: idList,
});

const sankeyNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['income', 'category', 'merchant', 'other']),
    refId: z.uuid().nullable(),
  })
  .meta({ id: 'SankeyNode' });

const sankeyLinkSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    amount: moneySchema,
    drillThrough: drillThroughSchema,
  })
  .meta({ id: 'SankeyLink' });

const budgetVsActualLineSchema = z
  .object({
    id: z.uuid(),
    categoryId: z.uuid().nullable(),
    name: z.string().nullable(),
    assigned: moneySchema,
    activity: moneySchema,
    available: moneySchema,
    cashOverspend: moneySchema,
    creditOverspend: moneySchema,
    drillThrough: drillThroughSchema,
  })
  .meta({ id: 'BudgetVsActualLine' });

const paceDaySchema = z
  .object({
    day: z.int().min(1).max(31),
    cumulativeMinor: z
      .string()
      .regex(/^-?\d+$/u)
      .describe('Spent from the 1st through this day, minor units, as a positive amount.'),
  })
  .meta({ id: 'SpendingPaceDay' });

function paceDays(days: readonly PaceDay[]): z.infer<typeof paceDaySchema>[] {
  return days.map((point) => ({
    day: point.day,
    cumulativeMinor: point.cumulative.minor.toString(),
  }));
}

export const reportRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, pool, clock } = deps;

  async function timezoneOf(userId: string): Promise<string> {
    const rows = await pool.query<{ display_timezone: string }>(
      'SELECT display_timezone FROM users WHERE id = $1',
      [userId],
    );
    return rows.rows[0]?.display_timezone ?? 'UTC';
  }

  return async (app) => {
    app.get(
      '/reports/spending',
      {
        schema: {
          operationId: 'getSpendingReport',
          summary: 'Spending by category and month',
          description:
            "Transfers excluded and refunds netted against their original (`@ctx/budgeting`'s " +
            'rule, reused unmodified). One cell per `(month, category)`; `categoryId: null` is ' +
            'the uncategorised envelope, present only for a month it was net negative.',
          tags: ['reports'],
          querystring: reportWindowQuery,
          response: {
            200: z.object({ cells: z.array(categoryMonthCellSchema) }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const categories = await listCategories(database, session.userId, {});
        const incomeIds = new Set(
          categories
            .filter((category) => category.kind === 'income')
            .map((category) => category.id),
        );
        const cells = await computeCategoryMonthActivity(database, {
          userId: session.userId,
          dateFrom: DateOnly.parse(request.query.from),
          dateTo: DateOnly.parse(request.query.to),
          ...(request.query.categoryIds === undefined
            ? {}
            : { categoryIds: request.query.categoryIds }),
          ...(request.query.accountIds === undefined
            ? {}
            : { accountIds: request.query.accountIds }),
        });
        return {
          cells: spendingRowsOf(cells, incomeIds).map((cell) => ({
            month: cell.month,
            categoryId: cell.categoryId,
            amount: money(cell.amount),
            transactionCount: cell.transactionCount,
            transferExcludedCount: cell.transferExcludedCount,
            refundNettedCount: cell.refundNettedCount,
            drillThrough: drillThroughForMonth(cell.month, cell.categoryId),
          })),
        };
      },
    );

    app.get(
      '/reports/income',
      {
        schema: {
          operationId: 'getIncomeReport',
          summary: 'Income by category and month',
          description:
            'The mirror of `GET /reports/spending`: categories of kind `income`, plus ' +
            'the uncategorised bucket for a month it was net positive.',
          tags: ['reports'],
          querystring: reportWindowQuery,
          response: {
            200: z.object({ cells: z.array(categoryMonthCellSchema) }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const categories = await listCategories(database, session.userId, {});
        const incomeIds = new Set(
          categories
            .filter((category) => category.kind === 'income')
            .map((category) => category.id),
        );
        const cells = await computeCategoryMonthActivity(database, {
          userId: session.userId,
          dateFrom: DateOnly.parse(request.query.from),
          dateTo: DateOnly.parse(request.query.to),
          ...(request.query.categoryIds === undefined
            ? {}
            : { categoryIds: request.query.categoryIds }),
          ...(request.query.accountIds === undefined
            ? {}
            : { accountIds: request.query.accountIds }),
        });
        return {
          cells: incomeRowsOf(cells, incomeIds).map((cell) => ({
            month: cell.month,
            categoryId: cell.categoryId,
            amount: money(cell.amount),
            transactionCount: cell.transactionCount,
            transferExcludedCount: cell.transferExcludedCount,
            refundNettedCount: cell.refundNettedCount,
            drillThrough: drillThroughForMonth(cell.month, cell.categoryId),
          })),
        };
      },
    );

    app.get(
      '/reports/sankey',
      {
        schema: {
          operationId: 'getSankeyReport',
          summary: 'Income → category → top merchants (+ other)',
          description:
            'One currency at a time (decision D4: no cross-currency conversion). Defaults to ' +
            'whichever currency has the most activity in the window.',
          tags: ['reports'],
          querystring: reportWindowQuery.extend({
            currency: z.string().length(3).optional(),
            topMerchants: z.coerce.number().int().min(1).max(50).optional(),
          }),
          response: {
            200: z.object({
              currency: z.string().length(3),
              nodes: z.array(sankeyNodeSchema),
              links: z.array(sankeyLinkSchema),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await computeSankey(
          database,
          {
            userId: session.userId,
            dateFrom: DateOnly.parse(request.query.from),
            dateTo: DateOnly.parse(request.query.to),
            ...(request.query.categoryIds === undefined
              ? {}
              : { categoryIds: request.query.categoryIds }),
            ...(request.query.accountIds === undefined
              ? {}
              : { accountIds: request.query.accountIds }),
          },
          {
            ...(request.query.currency === undefined ? {} : { currency: request.query.currency }),
            ...(request.query.topMerchants === undefined
              ? {}
              : { topMerchants: request.query.topMerchants }),
          },
        );
        return {
          currency: result.currency,
          nodes: result.nodes.map((node) => ({ ...node })),
          links: result.links.map((link) => {
            const categoryId = link.source === 'income' ? sourceCategoryOf(result, link) : null;
            const merchantNode = result.nodes.find((node) => node.id === link.target);
            return {
              source: link.source,
              target: link.target,
              amount: money(link.amount),
              drillThrough:
                merchantNode?.kind === 'merchant'
                  ? {
                      ...(categoryId === null ? {} : { categoryIds: [categoryId] }),
                      ...(merchantNode.refId === null ? {} : { merchantIds: [merchantNode.refId] }),
                      from: request.query.from,
                      to: request.query.to,
                    }
                  : drillThroughForWindow(request.query.from, request.query.to, categoryId),
            };
          }),
        };
      },
    );

    app.get(
      '/reports/spending-pace',
      {
        schema: {
          operationId: 'getSpendingPace',
          summary:
            "This month's cumulative spend by day, against last month and the 3-month average",
          description:
            "Every day present (a day with no spend repeats the day before). Spend is `GET /reports/spending`'s " +
            'own definition (transfers excluded, refunds netted, income categories and a net-positive ' +
            "uncategorised bucket left out): the last point of a month is that month's spending report total. " +
            'Pending rows are left out unless `includePending=true`; `pendingExcludedCount` says how many. A ' +
            'month with no ledger row at all is returned empty, never as zeros. One currency (the one with the ' +
            'most rows); the others are named in `otherCurrencies`, never summed.',
          tags: ['reports'],
          querystring: z.object({
            month: z
              .string()
              .regex(/^\d{4}-\d{2}$/u)
              .refine((value) => parseMonth(value) !== null, 'not a calendar month')
              .optional()
              .describe("`YYYY-MM`. Defaults to the current month in the holder's time zone."),
            includePending: booleanQuery,
          }),
          response: {
            200: z
              .object({
                month: z.string(),
                currency: z.string().length(3).nullable(),
                otherCurrencies: z.array(z.string()),
                daysInMonth: z.int().min(28).max(31),
                today: z
                  .int()
                  .min(1)
                  .max(31)
                  .nullable()
                  .describe('Day of month of today when `month` is the current month, else null.'),
                days: z.array(paceDaySchema),
                lastMonthKey: z.string(),
                lastMonth: z.array(paceDaySchema),
                trailingMonths: z.array(z.string()),
                trailingAverage: z.array(paceDaySchema),
                includePending: z.boolean(),
                pendingExcludedCount: z.int().nonnegative(),
                asOf: z.string().describe('When this was computed.'),
                lastSyncedAt: z
                  .string()
                  .nullable()
                  .describe('The most recent sync of any connection; null when none has synced.'),
              })
              .meta({ id: 'SpendingPace' }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(session.userId);
        const today = todayIn(clock, timezone);
        const categories = await listCategories(database, session.userId, {});
        const incomeIds = new Set(
          categories
            .filter((category) => category.kind === 'income')
            .map((category) => category.id),
        );
        const [pace, synced] = await Promise.all([
          computeSpendingPace(database, {
            userId: session.userId,
            month: request.query.month ?? today.slice(0, 7),
            today,
            includePending: request.query.includePending ?? false,
            incomeCategoryIds: incomeIds,
          }),
          pool.query<{ last: Date | null }>(
            'SELECT max(last_synced_at) AS last FROM connections WHERE user_id = $1',
            [session.userId],
          ),
        ]);
        const lastSynced = synced.rows[0]?.last ?? null;
        return {
          month: pace.month,
          currency: pace.currency,
          otherCurrencies: [...pace.otherCurrencies],
          daysInMonth: pace.daysInMonth,
          today: pace.today,
          days: paceDays(pace.days),
          lastMonthKey: pace.lastMonthKey,
          lastMonth: paceDays(pace.lastMonth),
          trailingMonths: [...pace.trailingMonths],
          trailingAverage: paceDays(pace.trailingAverage),
          includePending: pace.includePending,
          pendingExcludedCount: pace.pendingExcludedCount,
          asOf: clock.now().toISOString(),
          lastSyncedAt: lastSynced === null ? null : lastSynced.toISOString(),
        };
      },
    );

    app.get(
      '/reports/budget-vs-actual',
      {
        schema: {
          operationId: 'getBudgetVsActualReport',
          summary: 'One budget period: assigned vs. activity, per line',
          description:
            "A re-read of `@ctx/budgeting`'s own `getPeriod`, never a second computation of the " +
            'envelope math. Pass `periodId` directly, or `budgetId` for its most recent period.',
          tags: ['reports'],
          querystring: z
            .object({ periodId: z.uuid().optional(), budgetId: z.uuid().optional() })
            .refine(
              (query) => query.periodId !== undefined || query.budgetId !== undefined,
              'pass periodId or budgetId',
            ),
          response: {
            200: z.object({
              periodId: z.uuid(),
              startDate: z.string(),
              endDate: z.string(),
              readyToAssign: moneySchema,
              income: moneySchema,
              lines: z.array(budgetVsActualLineSchema),
            }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const period = await loadBudgetVsActual(pool, {
          userId: session.userId,
          ...(request.query.periodId === undefined ? {} : { periodId: request.query.periodId }),
          ...(request.query.budgetId === undefined ? {} : { budgetId: request.query.budgetId }),
        });
        if (period === null) {
          throw new AppError({
            status: 404,
            code: 'reports.budget_period_not_found',
            title: 'Not Found',
            detail: 'No matching budget period.',
            family: 'user',
          });
        }
        return {
          periodId: period.id,
          startDate: period.startDate,
          endDate: period.endDate,
          readyToAssign: money(period.readyToAssign),
          income: money(period.income),
          lines: period.lines.map((line) => ({
            id: line.id,
            categoryId: line.categoryId,
            name: line.name,
            assigned: money(line.assigned),
            activity: money(line.activity),
            available: money(line.available),
            cashOverspend: money(line.cashOverspend),
            creditOverspend: money(line.creditOverspend),
            drillThrough: drillThroughForWindow(period.startDate, period.endDate, line.categoryId),
          })),
        };
      },
    );
  };
};

function sourceCategoryOf(
  result: { readonly nodes: readonly { readonly id: string; readonly refId: string | null }[] },
  link: { readonly target: string },
): string | null {
  const node = result.nodes.find((candidate) => candidate.id === link.target);
  return node?.refId ?? null;
}
