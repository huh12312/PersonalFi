// SPDX-License-Identifier: MIT
/**
 * `/budgets/*` — the envelope budget, as HTTP.
 *
 * WP 2.1 shipped `@ctx/budgeting` with no REST surface (02-phase-2-dispatch.md
 * §3, WP 2.9's "routes consumed"); this file is that surface, built for the
 * budget screen and reports drill-through the same way `rules.ts` closed the
 * equivalent gap for the categorisation rule language.
 *
 * Session-only, like `rules.ts` and the transaction overlay: every write here
 * edits the user's own plan (an assignment, a goal, a rollover policy), never a
 * credential, so decision D21's step-up gate does not apply.
 *
 * ## Two things `@ctx/budgeting`'s public surface does not export
 *
 * `upsertLine` (create/update a `budget_lines` row) and a general "patch this
 * line's goal and policy" helper live in `packages/contexts/budgeting/src/budget.ts`
 * but are not part of `src/index.ts` — only `createBudget` is. `POST
 * /budgets/lines` and the goal/policy half of `PATCH /budgets/lines/{id}`
 * therefore read and write `@ctx/budgeting`'s own `budget_lines` table directly
 * through its published `./schema` subpath, mirroring `upsertLine`'s exact
 * logic. `scripts/check-schema-ownership.ts` exempts `apps/` from the
 * table-ownership check by design (`apps/api/src/reports/budget-vs-actual.ts`'s
 * header explains why), and every write below is followed by `recomputeDirty`
 * so the cached `available`/`activity` columns this route also reads never go
 * stale. **Recommended context change**: export `upsertLine`/`UpsertLineInput`
 * from `@ctx/budgeting`'s `src/index.ts` so a future caller does not have to
 * repeat this.
 *
 * The `assigned` half of a line edit *is* exported (`assign`) and is used
 * as-is — it is the one write with its own dirty cascade and event.
 */
import { Money, newId, todayIn } from '@core/kernel';
import {
  assign,
  createBudget,
  getPeriod,
  isBudgetingError,
  listBudgets,
  listPeriods,
  markDirtyFrom,
  openPeriod,
  recomputeDirty,
  rollPeriod,
  type BudgetingContext,
  type BudgetLineView,
  type BudgetPeriodView,
} from '@ctx/budgeting';
import {
  budgetLines,
  BUDGET_CLASSES,
  GOAL_TYPES,
  ROLLOVER_POLICIES,
  type BudgetLineRow,
} from '@ctx/budgeting/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createBudgetingLedgerPort } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { dateOnly, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** `BudgetingError` → RFC 9457. Local to this file — see the module header. */
function mapBudgetingErrors<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (!isBudgetingError(error)) throw error;
    const status =
      error.code === 'budgeting.budget_not_found' ||
      error.code === 'budgeting.period_not_found' ||
      error.code === 'budgeting.line_not_found'
        ? 404
        : error.code === 'budgeting.currency_mismatch'
          ? 422
          : 409; // period_closed, balance_unreported, identity_violation, card_identity_violation
    throw new AppError({
      status,
      code: error.code,
      title: status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Content' : 'Conflict',
      detail: error.message,
      family: status === 404 ? 'user' : 'domain',
    });
  });
}

/** D6: one account holder. Read once per request rather than threaded through `RouteDeps`. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

const budgetLineSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['category', 'credit_card_payment']),
    categoryId: z.uuid().nullable(),
    creditAccountId: z.uuid().nullable(),
    name: z.string().nullable(),
    carryover: moneySchema,
    assigned: moneySchema,
    activity: moneySchema,
    available: moneySchema,
    cashOverspend: moneySchema,
    creditOverspend: moneySchema,
    rolloverPolicy: z.enum(ROLLOVER_POLICIES),
    goalType: z.enum(GOAL_TYPES),
    neededThisPeriod: moneySchema,
    underfunded: moneySchema,
    priority: z.int(),
    class: z.enum(BUDGET_CLASSES).nullable(),
    transferExcludedCount: z.int().nonnegative(),
    refundNettedCount: z.int().nonnegative(),
  })
  .meta({ id: 'BudgetLine' });

function serialiseLine(line: BudgetLineView): z.infer<typeof budgetLineSchema> {
  return {
    id: line.id,
    kind: line.kind,
    categoryId: line.categoryId,
    creditAccountId: line.creditAccountId,
    name: line.name,
    carryover: money(line.carryover),
    assigned: money(line.assigned),
    activity: money(line.activity),
    available: money(line.available),
    cashOverspend: money(line.cashOverspend),
    creditOverspend: money(line.creditOverspend),
    rolloverPolicy: line.rolloverPolicy,
    goalType: line.goalType,
    neededThisPeriod: money(line.neededThisPeriod),
    underfunded: money(line.underfunded),
    priority: line.priority,
    class: line.class,
    transferExcludedCount: line.transferExcludedCount,
    refundNettedCount: line.refundNettedCount,
  };
}

const budgetPeriodSchema = z
  .object({
    id: z.uuid(),
    budgetId: z.uuid(),
    kind: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    sequence: z.int(),
    status: z.enum(['open', 'closed']),
    readyToAssign: moneySchema,
    income: moneySchema,
    dirty: z.boolean(),
    toStayOnTrack: moneySchema,
    totalCategoryAvailable: moneySchema,
    totalCreditCardPaymentAvailable: moneySchema,
    lines: z.array(budgetLineSchema),
  })
  .meta({ id: 'BudgetPeriod' });

function serialisePeriod(period: BudgetPeriodView): z.infer<typeof budgetPeriodSchema> {
  return {
    id: period.id,
    budgetId: period.budgetId,
    kind: period.kind,
    startDate: period.startDate,
    endDate: period.endDate,
    sequence: period.sequence,
    status: period.status,
    readyToAssign: money(period.readyToAssign),
    income: money(period.income),
    dirty: period.dirty,
    toStayOnTrack: money(period.toStayOnTrack),
    totalCategoryAvailable: money(period.totalCategoryAvailable),
    totalCreditCardPaymentAvailable: money(period.totalCreditCardPaymentAvailable),
    lines: period.lines.map(serialiseLine),
  };
}

const periodSummarySchema = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    sequence: z.int(),
    status: z.enum(['open', 'closed']),
    readyToAssign: moneySchema,
    dirty: z.boolean(),
  })
  .meta({ id: 'BudgetPeriodSummary' });

async function requireOwnLine(
  deps: RouteDeps,
  userId: string,
  lineId: string,
): Promise<BudgetLineRow> {
  const rows = await deps.database
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.id, lineId), eq(budgetLines.userId, userId)));
  const row = rows[0];
  if (row === undefined) {
    throw new AppError({
      status: 404,
      code: 'budgeting.line_not_found',
      title: 'Not Found',
      detail: `no budget line ${lineId}`,
      family: 'user',
    });
  }
  return row;
}

/** Find this user's one budget, creating the WP 2.1 §6 default if none exists yet. */
async function requireOrCreateBudget(
  deps: RouteDeps,
  context: BudgetingContext,
  timezone: string,
): Promise<{ readonly id: string; readonly currency: string }> {
  const existing = await listBudgets(deps.database, { userId: context.userId });
  const budget = existing[0];
  if (budget !== undefined) return budget;
  return createBudget(deps.database, context, { name: 'My Budget', currency: 'USD', timezone });
}

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): BudgetingContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

export const budgetRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const port = () => createBudgetingLedgerPort(database);

  async function currentPeriodOf(
    context: BudgetingContext,
    timezone: string,
  ): Promise<{ readonly budgetId: string; readonly period: BudgetPeriodView }> {
    const budget = await requireOrCreateBudget(deps, context, timezone);
    const today = todayIn(clock, timezone);
    const opened = await mapBudgetingErrors(() =>
      openPeriod(database, context, { budgetId: budget.id, on: today }),
    );
    await mapBudgetingErrors(() => recomputeDirty(database, context, { port: port() }, budget.id));
    const view = await getPeriod(database, { userId: context.userId, periodId: opened.id });
    if (view === null) {
      throw new AppError({
        status: 404,
        code: 'budgeting.period_not_found',
        title: 'Not Found',
        detail: `no budget period ${opened.id}`,
        family: 'user',
      });
    }
    return { budgetId: budget.id, period: view };
  }

  return async (app) => {
    app.get(
      '/budgets/current',
      {
        schema: {
          operationId: 'getCurrentBudgetPeriod',
          summary: "Today's budget period, with every envelope line",
          description:
            'Lazily creates the WP 2.1 §6 default budget and opens the containing period if ' +
            "neither exists yet — the same 'opened by whoever first needs it' rule " +
            '`apps/api/src/modules.ts` documents for `module.budgeting`.',
          tags: ['budgets'],
          response: {
            200: z.object({
              budgetId: z.uuid(),
              currency: z.string().length(3),
              period: budgetPeriodSchema,
            }),
            ...problems(401, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(deps);
        const context = contextOf(deps, session.userId, request);
        const { budgetId, period } = await currentPeriodOf(context, timezone);
        const budgets = await listBudgets(database, { userId: session.userId });
        const currency = budgets.find((b) => b.id === budgetId)?.currency ?? 'USD';
        return { budgetId, currency, period: serialisePeriod(period) };
      },
    );

    app.get(
      '/budgets/periods',
      {
        schema: {
          operationId: 'listBudgetPeriods',
          summary: 'Every period of this budget, oldest first — the period picker',
          tags: ['budgets'],
          querystring: z.object({ budgetId: z.uuid() }),
          response: {
            200: z.object({ periods: z.array(periodSummarySchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const periods = await listPeriods(database, {
          userId: session.userId,
          budgetId: request.query.budgetId,
        });
        return {
          periods: periods.map((p) => ({
            id: p.id,
            kind: p.kind,
            startDate: p.startDate,
            endDate: p.endDate,
            sequence: p.sequence,
            status: p.status,
            readyToAssign: money(p.readyToAssign),
            dirty: p.dirty,
          })),
        };
      },
    );

    app.post(
      '/budgets/lines',
      {
        schema: {
          operationId: 'createBudgetLine',
          summary: 'Create (or re-open) the envelope for one category in one period',
          description:
            "Upsert on `(periodId, categoryId)`, matching `@ctx/budgeting`'s own `upsertLine` " +
            "(see this file's module comment: not on the context's public surface, " +
            're-implemented here against its published `./schema`).',
          tags: ['budgets'],
          body: z.object({
            periodId: z.uuid(),
            categoryId: z.uuid(),
            rolloverPolicy: z.enum(ROLLOVER_POLICIES).optional(),
            goalType: z.enum(GOAL_TYPES).optional(),
            goalAmount: moneySchema.nullable().optional(),
            goalTargetDate: dateOnly.nullable().optional(),
            goalPercent: z.string().nullable().optional(),
            priority: z.int().optional(),
            class: z.enum(BUDGET_CLASSES).nullable().optional(),
          }),
          response: {
            201: z.object({ line: budgetLineSchema }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const context = contextOf(deps, session.userId, request);

        const period = await getPeriod(database, {
          userId: session.userId,
          periodId: request.body.periodId,
        });
        if (period === null) {
          throw new AppError({
            status: 404,
            code: 'budgeting.period_not_found',
            title: 'Not Found',
            detail: `no budget period ${request.body.periodId}`,
            family: 'user',
          });
        }

        const budgets = await listBudgets(database, { userId: session.userId });
        const budget = budgets.find((b) => b.id === period.budgetId);
        if (budget === undefined) {
          throw new AppError({
            status: 404,
            code: 'budgeting.budget_not_found',
            title: 'Not Found',
            detail: `no budget ${period.budgetId}`,
            family: 'user',
          });
        }

        const existing = await database
          .select()
          .from(budgetLines)
          .where(
            and(
              eq(budgetLines.budgetPeriodId, period.id),
              eq(budgetLines.categoryId, request.body.categoryId),
              eq(budgetLines.userId, session.userId),
            ),
          );

        const patch = {
          rolloverPolicy: request.body.rolloverPolicy ?? 'ROLLOVER',
          goalType: request.body.goalType ?? 'NONE',
          goalAmountMinor:
            request.body.goalAmount === undefined || request.body.goalAmount === null
              ? null
              : Money.fromJSON(request.body.goalAmount).minor,
          goalTargetDate: request.body.goalTargetDate ?? null,
          goalPercent: request.body.goalPercent ?? null,
          priority: request.body.priority ?? 100,
          class: request.body.class ?? null,
          dirty: true,
          updatedAt: clock.now(),
        };

        const found = existing[0];
        const row =
          found === undefined
            ? (
                await database
                  .insert(budgetLines)
                  .values({
                    id: newId(),
                    userId: session.userId,
                    budgetId: budget.id,
                    budgetPeriodId: period.id,
                    kind: 'category',
                    categoryId: request.body.categoryId,
                    creditAccountId: null,
                    currency: budget.currency,
                    ...patch,
                  })
                  .returning()
              )[0]
            : (
                await database
                  .update(budgetLines)
                  .set(patch)
                  .where(eq(budgetLines.id, found.id))
                  .returning()
              )[0];
        if (row === undefined) throw new Error('budget_lines write returned no row');

        // Condition C-5 (docs/evidence/phase-2/gate-security-review.md §5,
        // G2-3): a line created (or re-opened) mid-period must mark its own
        // period dirty *before* the recompute below, not merely mark the
        // line's own `dirty` column (schema default `true`, set again in
        // `patch` above for clarity). `recomputeDirty` only ever walks
        // `budgetPeriods.dirty = true` rows (`dirtyPeriods`) — a line-level
        // flag with no period-level one is invisible to it. Without this
        // call, a period the ledger consumer had already cleaned (the common
        // case: transactions synced, then a category budgeted afterwards)
        // stays clean, `recomputeDirty` finds nothing to do, and the new
        // envelope's `available`/`activity` never reflect transactions that
        // posted before the line existed — exactly what the gate's reviewer
        // observed by hand and had to force a recompute to fix.
        await mapBudgetingErrors(() =>
          markDirtyFrom(database, context, { budgetId: budget.id, date: period.startDate }),
        );
        await mapBudgetingErrors(() =>
          recomputeDirty(database, context, { port: port() }, budget.id),
        );
        const refreshed = await getPeriod(database, {
          userId: session.userId,
          periodId: period.id,
        });
        const line = refreshed?.lines.find((candidate) => candidate.id === row.id);
        if (line === undefined) throw new Error('budget line vanished after recompute');
        return reply.code(201).send({ line: serialiseLine(line) });
      },
    );

    app.patch(
      '/budgets/lines/:lineId',
      {
        schema: {
          operationId: 'updateBudgetLine',
          summary: 'Assign money to an envelope, or change its goal / rollover policy',
          tags: ['budgets'],
          params: z.object({ lineId: z.uuid() }),
          body: z
            .object({
              assigned: moneySchema.optional(),
              rolloverPolicy: z.enum(ROLLOVER_POLICIES).optional(),
              goalType: z.enum(GOAL_TYPES).optional(),
              goalAmount: moneySchema.nullable().optional(),
              goalTargetDate: dateOnly.nullable().optional(),
              goalPercent: z.string().nullable().optional(),
              priority: z.int().optional(),
              class: z.enum(BUDGET_CLASSES).nullable().optional(),
            })
            .refine(
              (body) => Object.values(body).some((value) => value !== undefined),
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ line: budgetLineSchema }),
            ...problems(400, 401, 404, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const context = contextOf(deps, session.userId, request);
        const row = await requireOwnLine(deps, session.userId, request.params.lineId);

        const assignedBody = request.body.assigned;
        if (assignedBody !== undefined) {
          await mapBudgetingErrors(() =>
            assign(database, context, {
              budgetId: row.budgetId,
              periodId: row.budgetPeriodId,
              lineId: row.id,
              assigned: Money.fromJSON(assignedBody),
            }),
          );
        }

        const hasGoalOrPolicy =
          request.body.rolloverPolicy !== undefined ||
          request.body.goalType !== undefined ||
          request.body.goalAmount !== undefined ||
          request.body.goalTargetDate !== undefined ||
          request.body.goalPercent !== undefined ||
          request.body.priority !== undefined ||
          request.body.class !== undefined;
        if (hasGoalOrPolicy) {
          await database
            .update(budgetLines)
            .set({
              ...(request.body.rolloverPolicy === undefined
                ? {}
                : { rolloverPolicy: request.body.rolloverPolicy }),
              ...(request.body.goalType === undefined ? {} : { goalType: request.body.goalType }),
              ...(request.body.goalAmount === undefined
                ? {}
                : {
                    goalAmountMinor:
                      request.body.goalAmount === null
                        ? null
                        : Money.fromJSON(request.body.goalAmount).minor,
                  }),
              ...(request.body.goalTargetDate === undefined
                ? {}
                : { goalTargetDate: request.body.goalTargetDate }),
              ...(request.body.goalPercent === undefined
                ? {}
                : { goalPercent: request.body.goalPercent }),
              ...(request.body.priority === undefined ? {} : { priority: request.body.priority }),
              ...(request.body.class === undefined ? {} : { class: request.body.class }),
              dirty: true,
              updatedAt: clock.now(),
            })
            .where(eq(budgetLines.id, row.id));
        }

        await mapBudgetingErrors(() =>
          recomputeDirty(database, context, { port: port() }, row.budgetId),
        );
        const refreshed = await getPeriod(database, {
          userId: session.userId,
          periodId: row.budgetPeriodId,
        });
        const line = refreshed?.lines.find((candidate) => candidate.id === row.id);
        if (line === undefined) throw new Error('budget line vanished after recompute');
        return { line: serialiseLine(line) };
      },
    );

    app.post(
      '/budgets/periods/roll',
      {
        schema: {
          operationId: 'rollBudgetPeriod',
          summary: 'Close a period and open the next one, carrying over and auto-assigning',
          tags: ['budgets'],
          body: z.object({ budgetId: z.uuid(), periodId: z.uuid() }),
          response: {
            200: z.object({
              fromPeriodId: z.uuid(),
              toPeriodId: z.uuid(),
              lineCount: z.int().nonnegative(),
              rolledOut: moneySchema,
              absorbedByRta: moneySchema,
              autoAssigned: moneySchema,
            }),
            ...problems(400, 401, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const context = contextOf(deps, session.userId, request);
        const result = await mapBudgetingErrors(() =>
          rollPeriod(database, context, { port: port() }, request.body),
        );
        return {
          fromPeriodId: result.fromPeriodId,
          toPeriodId: result.toPeriodId,
          lineCount: result.lineCount,
          rolledOut: money(result.rolledOut),
          absorbedByRta: money(result.absorbedByRta),
          autoAssigned: money(result.autoAssigned),
        };
      },
    );
  };
};
