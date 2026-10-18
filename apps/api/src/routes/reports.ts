// SPDX-License-Identifier: MIT
/**
 * `GET /reports/{spending,income,sankey,spending-pace,cash-flow,budget-vs-actual}` — read models only.
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
import {
  CASH_FLOW_TIMEFRAMES,
  computeCashFlow,
  parsePeriodKey,
  type BreakdownRow,
  type Breakdowns,
  type CashFlowComparison,
  type WindowFigures,
} from '../reports/cash-flow.ts';
import { merchantDisplayNames } from '@ctx/ledger';
import { computeSpendingPace, parseMonth, type PaceDay } from '../reports/spending-pace.ts';
import { AppError, problems } from '../problem.ts';
import { booleanQuery, dateOnlyQuery, idList, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const drillThroughSchema = z
  .object({
    categoryIds: z.array(z.uuid()).optional(),
    merchantIds: z.array(z.uuid()).optional(),
    uncategorized: z.boolean().optional(),
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

const minorString = z.string().regex(/^-?\d+$/u);

const cashFlowFiguresSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    hasData: z
      .boolean()
      .describe(
        'Any ledger row in the currency in the whole period. False is no data, never a zero.',
      ),
    incomeMinor: minorString,
    expensesMinor: minorString.describe(
      'Money out, as a positive amount (Reports spending, negated).',
    ),
    netMinor: minorString,
    transactionCount: z.int().nonnegative(),
  })
  .meta({ id: 'CashFlowFigures' });

const cashFlowBreakdownRowSchema = z
  .object({
    key: z.string().nullable(),
    label: z.string(),
    hue: z.string(),
    sumMinor: minorString,
    share: z.number().nullable(),
    count: z.int().nonnegative(),
    drillThrough: drillThroughSchema.nullable(),
  })
  .meta({ id: 'CashFlowBreakdownRow' });

const cashFlowBreakdownsSchema = z
  .object({
    category: z.array(cashFlowBreakdownRowSchema),
    group: z.array(cashFlowBreakdownRowSchema),
    merchant: z.array(cashFlowBreakdownRowSchema),
  })
  .meta({ id: 'CashFlowBreakdowns' });

const cashFlowComparisonSchema = z
  .object({
    kind: z.enum(['previous', 'average', 'year_ago']),
    periods: z.array(z.string()),
    available: z.boolean(),
    withheld: z.enum(['no_data', 'no_history']).nullable(),
    periodsAveraged: z.int().nonnegative(),
    throughOffsetDays: z
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'For the current period: each counterpart is read this many days past its start, capped at its end.',
      ),
    incomeMinor: minorString.nullable(),
    expensesMinor: minorString.nullable(),
    netMinor: minorString.nullable(),
  })
  .meta({ id: 'CashFlowComparison' });

function figuresWire(figures: WindowFigures): z.infer<typeof cashFlowFiguresSchema> {
  return {
    from: figures.from,
    to: figures.to,
    hasData: figures.hasData,
    incomeMinor: figures.income.toString(),
    expensesMinor: figures.expenses.toString(),
    netMinor: figures.net.toString(),
    transactionCount: figures.transactionCount,
  };
}

function breakdownRowWire(row: BreakdownRow): z.infer<typeof cashFlowBreakdownRowSchema> {
  return {
    key: row.key,
    label: row.label,
    hue: row.hue,
    sumMinor: row.sum.toString(),
    share: row.share,
    count: row.count,
    drillThrough:
      row.drillThrough === null
        ? null
        : {
            ...row.drillThrough,
            ...(row.drillThrough.categoryIds === undefined
              ? {}
              : { categoryIds: [...row.drillThrough.categoryIds] }),
            ...(row.drillThrough.merchantIds === undefined
              ? {}
              : { merchantIds: [...row.drillThrough.merchantIds] }),
          },
  };
}

function breakdownsWire(breakdowns: Breakdowns): z.infer<typeof cashFlowBreakdownsSchema> {
  return {
    category: breakdowns.category.map(breakdownRowWire),
    group: breakdowns.group.map(breakdownRowWire),
    merchant: breakdowns.merchant.map(breakdownRowWire),
  };
}

function comparisonWire(comparison: CashFlowComparison): z.infer<typeof cashFlowComparisonSchema> {
  return {
    kind: comparison.kind,
    periods: [...comparison.periods],
    available: comparison.available,
    withheld: comparison.withheld,
    periodsAveraged: comparison.periodsAveraged,
    throughOffsetDays: comparison.throughOffsetDays,
    incomeMinor: comparison.income?.toString() ?? null,
    expensesMinor: comparison.expenses?.toString() ?? null,
    netMinor: comparison.net?.toString() ?? null,
  };
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
      '/reports/cash-flow',
      {
        schema: {
          operationId: 'getCashFlow',
          summary:
            'One period of cash flow: income, expenses, net, savings rate, comparisons, bars, breakdowns',
          description:
            "Every figure is `GET /reports/spending` / `GET /reports/income` over that figure's own window (transfers " +
            'excluded, refunds netted, pending counted, income categories and a net-positive uncategorised bucket as ' +
            'income). `period` is `YYYY-MM`, `YYYY-Qn` or `YYYY` for the timeframe, defaulting to the one today is in ' +
            "(the holder's zone). The current period's figures are so far: its savings rate is withheld and each " +
            'comparison reads its counterpart through the same point. A comparison whose counterpart has no ledger row ' +
            'is withheld. `bars` are the twelve periods ending with the selected one. One currency (the one with the ' +
            'most rows); the others are named in `otherCurrencies`, never summed (decision D4).',
          tags: ['reports'],
          querystring: z
            .object({
              timeframe: z.enum(CASH_FLOW_TIMEFRAMES).default('month'),
              period: z.string().max(10).optional(),
            })
            .refine(
              (query) =>
                query.period === undefined ||
                parsePeriodKey(query.timeframe, query.period) !== null,
              {
                message: "period is not one of the timeframe's (YYYY-MM, YYYY-Qn or YYYY)",
                path: ['period'],
              },
            ),
          response: {
            200: z
              .object({
                timeframe: z.enum(CASH_FLOW_TIMEFRAMES),
                period: z.string(),
                start: z.string(),
                end: z.string(),
                currentPeriod: z.string(),
                isCurrent: z.boolean(),
                isFuture: z.boolean(),
                through: z
                  .string()
                  .nullable()
                  .describe('Today, when the period is the current one.'),
                currency: z.string().length(3).nullable(),
                otherCurrencies: z.array(z.string()),
                summary: cashFlowFiguresSchema.extend({
                  savingsRate: z.number().nullable().describe('net ÷ income; null when withheld.'),
                  savingsRateWithheld: z
                    .enum(['no_data', 'no_income', 'incomplete', 'not_started'])
                    .nullable(),
                }),
                comparisons: z.array(cashFlowComparisonSchema),
                bars: z.array(
                  cashFlowFiguresSchema.extend({ period: z.string(), complete: z.boolean() }),
                ),
                breakdowns: z.object({
                  income: cashFlowBreakdownsSchema,
                  expenses: cashFlowBreakdownsSchema,
                }),
                asOf: z.string(),
                lastSyncedAt: z.string().nullable(),
              })
              .meta({ id: 'CashFlow' }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        // Started before the time zone is known: it does not depend on it, and the ledger read does.
        const categories = listCategories(database, session.userId, { includeArchived: true });
        const timezone = await timezoneOf(session.userId);
        const today = todayIn(clock, timezone);
        const [result, synced] = await Promise.all([
          computeCashFlow(database, {
            userId: session.userId,
            timeframe: request.query.timeframe,
            periodKey: request.query.period ?? null,
            today,
            categories: categories.then((categories) =>
              categories.map((category) => ({
                id: category.id,
                label: category.label,
                parentId: category.parentId,
                hue: category.hue,
                kind: category.kind,
              })),
            ),
            merchantNames: (ids) => merchantDisplayNames(database, { userId: session.userId, ids }),
          }),
          pool.query<{ last: Date | null }>(
            'SELECT max(last_synced_at) AS last FROM connections WHERE user_id = $1',
            [session.userId],
          ),
        ]);
        const lastSynced = synced.rows[0]?.last ?? null;
        return {
          timeframe: result.timeframe,
          period: result.period.key,
          start: result.period.start,
          end: result.period.end,
          currentPeriod: result.currentPeriod,
          isCurrent: result.isCurrent,
          isFuture: result.isFuture,
          through: result.through,
          currency: result.currency,
          otherCurrencies: [...result.otherCurrencies],
          summary: {
            ...figuresWire(result.summary),
            savingsRate: result.summary.savingsRate,
            savingsRateWithheld: result.summary.savingsRateWithheld,
          },
          comparisons: result.comparisons.map(comparisonWire),
          bars: result.bars.map((bar) => ({
            ...figuresWire(bar),
            period: bar.period,
            complete: bar.complete,
          })),
          breakdowns: {
            income: breakdownsWire(result.breakdowns.income),
            expenses: breakdownsWire(result.breakdowns.expenses),
          },
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
