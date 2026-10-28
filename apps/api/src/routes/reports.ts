// SPDX-License-Identifier: MIT
/**
 * `GET /reports/{spending,income,sankey,spending-pace,cash-flow,category-history,budget-vs-actual}` — read models only.
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
import { DateOnly, hueForId, todayIn } from '@core/kernel';
import { listCategories } from '@ctx/categorization';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { blockDocument, blockDocumentSchema } from '../blocks/schema.ts';
import {
  budgetVsActualBlocks,
  categoryMonthBlocks,
  type CategoryLookup,
} from '../blocks/reports.ts';
import { loadBudgetVsActual } from '../reports/budget-vs-actual.ts';
import { drillThroughForMonth, drillThroughForWindow } from '../reports/drill-through.ts';
import {
  computeCategoryMonthActivity,
  incomeRowsOf,
  spendingRowsOf,
  transferCategoryIdsOf,
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
import {
  computeCategoryHistory,
  HISTORY_MONTHS,
  type CategoryHistoryResult,
} from '../reports/category-history.ts';
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

const budgetVsActualQuery = z
  .object({ periodId: z.uuid().optional(), budgetId: z.uuid().optional() })
  .refine(
    (query) => query.periodId !== undefined || query.budgetId !== undefined,
    'pass periodId or budgetId',
  );

const budgetVsActualSchema = z.object({
  periodId: z.uuid(),
  startDate: z.string(),
  endDate: z.string(),
  readyToAssign: moneySchema,
  income: moneySchema,
  lines: z.array(budgetVsActualLineSchema),
});

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

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/u);
const historyWithheldSchema = z
  .enum(['insufficient_history', 'no_data'])
  .nullable()
  .describe(
    'Why a figure is withheld: fewer than two complete months in history (`insufficient_history`), or no ledger ' +
      'row at all (`no_data`). null when shown.',
  );

const categoryHistoryMonthSchema = z
  .object({
    month: yearMonth,
    start: z.string(),
    end: z.string(),
    amountMinor: minorString.describe(
      "This side's amount in minor units of `currency`: money out as a positive amount for spending (a " +
        "refund-heavy month can be negative), money in for income. Exactly the Cash Flow hub's category " +
        'breakdown for the month (the heading: its group row). "0" with `hasActivity: false` is a real zero.',
    ),
    transactionCount: z.int().nonnegative(),
    hasActivity: z
      .boolean()
      .describe('Any report cell for the category (or its children) this month.'),
    complete: z.boolean().describe('False only for the current month, whose amount is so far.'),
    isCurrent: z.boolean(),
    inHistory: z
      .boolean()
      .describe(
        "On or after the month of the holder's first ledger row (any category, any currency). A month " +
          'before it is not a zero and is never averaged.',
      ),
  })
  .meta({ id: 'CategoryHistoryMonth' });

const categoryHistoryAverageSchema = z
  .object({
    available: z.boolean(),
    withheld: historyWithheldSchema,
    amountMinor: minorString
      .nullable()
      .describe(
        'Σ amount ÷ months averaged, rounded half-even. Over every complete month in history — a zero month ' +
          'counts as a zero, never dropped — and never the current month. null when withheld.',
      ),
    monthsAveraged: z.int().nonnegative(),
    months: z.array(yearMonth).describe('The months averaged, oldest first.'),
  })
  .meta({ id: 'CategoryHistoryAverage' });

const categoryHistoryComparisonSchema = z
  .object({
    available: z.boolean(),
    withheld: historyWithheldSchema,
    thisMonthMinor: minorString.describe('The current month so far. Always present.'),
    averageMinor: minorString.nullable(),
    differenceMinor: minorString
      .nullable()
      .describe('thisMonth − average, signed; null when the average is withheld.'),
    direction: z.enum(['more', 'less', 'same']).nullable(),
  })
  .meta({ id: 'CategoryHistoryComparison' });

const categoryHistorySchema = z
  .object({
    categoryId: z.uuid(),
    side: z
      .enum(['spending', 'income'])
      .describe('`income` for an income category, else `spending` (as Reports splits them).'),
    includesChildren: z
      .boolean()
      .describe('True for a heading: every figure sums it and its children, archived included.'),
    currency: z.string().length(3).nullable(),
    otherCurrencies: z
      .array(z.string())
      .describe('Currencies also present, never converted or summed (decision D4).'),
    currentMonth: yearMonth,
    through: z.string().describe("Today, in the holder's zone: the current month is so far."),
    historyStart: yearMonth
      .nullable()
      .describe(
        "The first window month in history: the month of the holder's first ledger row, or the window's first " +
          'month when the ledger reaches back before it. null when there is no row at all.',
      ),
    months: z
      .array(categoryHistoryMonthSchema)
      .length(HISTORY_MONTHS)
      .describe(
        'Exactly thirteen: the twelve complete months before the current one, then it. Oldest first.',
      ),
    average: categoryHistoryAverageSchema,
    comparison: categoryHistoryComparisonSchema,
    drillThrough: drillThroughSchema,
  })
  .meta({
    id: 'CategoryHistory',
    description:
      "One category's last thirteen months, its average and this month against it. Every month's amount is the " +
      "Cash Flow hub's for that category and month (transfers out, refunds netted into the purchase's category, " +
      "excluded rows dropped, pending counted). Nothing is invented: a month before the holder's first ledger row " +
      'is not in history; the average is withheld below two complete months in history; the current month is ' +
      'never averaged.',
  });

function categoryHistoryWire(result: CategoryHistoryResult): z.infer<typeof categoryHistorySchema> {
  return {
    categoryId: result.categoryId,
    side: result.side,
    includesChildren: result.includesChildren,
    currency: result.currency,
    otherCurrencies: [...result.otherCurrencies],
    currentMonth: result.currentMonth,
    through: result.through,
    historyStart: result.historyStart,
    months: result.months.map((month) => ({
      month: month.month,
      start: month.start,
      end: month.end,
      amountMinor: month.amount.toString(),
      transactionCount: month.transactionCount,
      hasActivity: month.hasActivity,
      complete: month.complete,
      isCurrent: month.isCurrent,
      inHistory: month.inHistory,
    })),
    average: {
      available: result.average.available,
      withheld: result.average.withheld,
      amountMinor: result.average.amount?.toString() ?? null,
      monthsAveraged: result.average.monthsAveraged,
      months: [...result.average.months],
    },
    comparison: {
      available: result.comparison.available,
      withheld: result.comparison.withheld,
      thisMonthMinor: result.comparison.thisMonth.toString(),
      averageMinor: result.comparison.average?.toString() ?? null,
      differenceMinor: result.comparison.difference?.toString() ?? null,
      direction: result.comparison.direction,
    },
    drillThrough: {
      ...result.drillThrough,
      ...(result.drillThrough.categoryIds === undefined
        ? {}
        : { categoryIds: [...result.drillThrough.categoryIds] }),
    },
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

  /**
   * `GET /reports/spending|income`'s cells — one function, so the block routes below are built from exactly the
   * figures the report routes return (`blocks/reports.ts`; `test/report-blocks.test.ts`).
   */
  async function categoryMonthCells(
    userId: string,
    query: z.infer<typeof reportWindowQuery>,
    side: 'spending' | 'income',
  ): Promise<z.infer<typeof categoryMonthCellSchema>[]> {
    const categories = await listCategories(database, userId, {});
    const incomeIds = new Set(
      categories.filter((category) => category.kind === 'income').map((category) => category.id),
    );
    const cells = await computeCategoryMonthActivity(database, {
      userId,
      dateFrom: DateOnly.parse(query.from),
      dateTo: DateOnly.parse(query.to),
      ...(query.categoryIds === undefined ? {} : { categoryIds: query.categoryIds }),
      ...(query.accountIds === undefined ? {} : { accountIds: query.accountIds }),
    });
    const transferIds = transferCategoryIdsOf(categories);
    const rows =
      side === 'spending'
        ? spendingRowsOf(cells, incomeIds, transferIds)
        : incomeRowsOf(cells, incomeIds, transferIds);
    return rows.map((cell) => ({
      month: cell.month,
      categoryId: cell.categoryId,
      amount: money(cell.amount),
      transactionCount: cell.transactionCount,
      transferExcludedCount: cell.transferExcludedCount,
      refundNettedCount: cell.refundNettedCount,
      drillThrough: drillThroughForMonth(cell.month, cell.categoryId),
    }));
  }

  /** A category's label and persisted hue (archived included: a past month may name one); Uncategorised is neutral. */
  async function categoryLookupFor(userId: string): Promise<CategoryLookup> {
    const categories = await listCategories(database, userId, { includeArchived: true });
    const byId = new Map(categories.map((category) => [category.id, category]));
    return (categoryId) => {
      if (categoryId === null) return { label: 'Uncategorised', hue: 'neutral' };
      const category = byId.get(categoryId);
      return category === undefined
        ? { label: 'Category', hue: hueForId(categoryId) }
        : { label: category.label, hue: category.hue };
    };
  }

  /** `GET /reports/budget-vs-actual`'s body — shared with its block route for the reason above. */
  async function budgetVsActualOf(
    userId: string,
    query: z.infer<typeof budgetVsActualQuery>,
  ): Promise<z.infer<typeof budgetVsActualSchema>> {
    const period = await loadBudgetVsActual(pool, {
      userId,
      ...(query.periodId === undefined ? {} : { periodId: query.periodId }),
      ...(query.budgetId === undefined ? {} : { budgetId: query.budgetId }),
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
        return { cells: await categoryMonthCells(session.userId, request.query, 'spending') };
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
        return { cells: await categoryMonthCells(session.userId, request.query, 'income') };
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
            transferCategoryIds: transferCategoryIdsOf(categories),
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
      '/reports/category-history',
      {
        schema: {
          operationId: 'getCategoryHistory',
          summary: "One category's last thirteen months, its average and this month against it",
          description:
            "The category detail screen's figures (WP 10.14). The window is the twelve complete months before the " +
            "current one (the holder's zone) plus the current one. A heading sums its children. Each month's " +
            "amount is the Cash Flow hub's category breakdown for that month. History starts at the holder's first " +
            'ledger row: a month before it is not in history, a month in history with no spend is a zero. The ' +
            'average is over the complete months in history (zeros included, the current month never), withheld ' +
            'below two; the comparison is this month so far against it. One currency, the one the ' +
            "category's rows are mostly in; others are named, never summed (decision D4).",
          tags: ['reports'],
          querystring: z.object({ categoryId: z.uuid() }),
          response: {
            200: categoryHistorySchema,
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const categories = listCategories(database, session.userId, { includeArchived: true });
        const timezone = await timezoneOf(session.userId);
        const today = todayIn(clock, timezone);
        const result = await computeCategoryHistory(database, {
          userId: session.userId,
          categoryId: request.query.categoryId,
          today,
          categories: (await categories).map((category) => ({
            id: category.id,
            label: category.label,
            parentId: category.parentId,
            hue: category.hue,
            kind: category.kind,
          })),
        });
        if (result === null) {
          // Scoped to the session's user: another holder's category is indistinguishable from none at all.
          throw new AppError({
            status: 404,
            code: 'categorization.category_not_found',
            title: 'Not Found',
            detail: 'No such category.',
            family: 'user',
          });
        }
        return categoryHistoryWire(result);
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
          querystring: budgetVsActualQuery,
          response: {
            200: budgetVsActualSchema,
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return budgetVsActualOf(session.userId, request.query);
      },
    );

    // ---------------------------------------------------------------------------------------------------------
    // WP 10.15 (V8): the same three reports as blocks, built from the routes' own wire output above
    // (`blocks/reports.ts`). The Sankey has no block.
    // ---------------------------------------------------------------------------------------------------------

    app.get(
      '/reports/blocks/spending',
      {
        schema: {
          operationId: 'getSpendingReportBlocks',
          summary: 'Spending by category and month, as blocks',
          description:
            'The `GET /reports/spending` cells for the same window, as `stacked-bars` blocks (one per currency): a ' +
            'bar per month, a segment per category in its hue, drill-through hrefs. No figure is added; a bar total ' +
            'is the sum of its own segments (refused otherwise).',
          tags: ['reports'],
          querystring: reportWindowQuery,
          response: { 200: blockDocumentSchema, ...problems(400, 401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const [cells, lookup] = await Promise.all([
          categoryMonthCells(session.userId, request.query, 'spending'),
          categoryLookupFor(session.userId),
        ]);
        return blockDocument(categoryMonthBlocks(cells, lookup, 'Spending by category and month'));
      },
    );

    app.get(
      '/reports/blocks/income',
      {
        schema: {
          operationId: 'getIncomeReportBlocks',
          summary: 'Income by category and month, as blocks',
          description: 'The mirror of `GET /reports/blocks/spending` over `GET /reports/income`.',
          tags: ['reports'],
          querystring: reportWindowQuery,
          response: { 200: blockDocumentSchema, ...problems(400, 401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const [cells, lookup] = await Promise.all([
          categoryMonthCells(session.userId, request.query, 'income'),
          categoryLookupFor(session.userId),
        ]);
        return blockDocument(categoryMonthBlocks(cells, lookup, 'Income by category and month'));
      },
    );

    app.get(
      '/reports/blocks/budget-vs-actual',
      {
        schema: {
          operationId: 'getBudgetVsActualReportBlocks',
          summary: 'Budget vs. actual for one period, as a table block',
          description:
            'The `GET /reports/budget-vs-actual` lines for the same period as one `table` block: the name linking ' +
            'to its category screen, Assigned / Activity / Available as the route returns them, Cash/Credit ' +
            'overspend badges and a transactions link.',
          tags: ['reports'],
          querystring: budgetVsActualQuery,
          response: { 200: blockDocumentSchema, ...problems(400, 401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const period = await budgetVsActualOf(session.userId, request.query);
        return blockDocument(budgetVsActualBlocks(period.lines));
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
