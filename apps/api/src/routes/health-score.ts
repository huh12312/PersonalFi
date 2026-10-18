// SPDX-License-Identifier: MIT
/**
 * `GET /insights/health` — the Health screen's one read (WP 10.12, V5 of the visual programme).
 *
 * Today's daily health snapshot (migration 0048) with its six pillars, the last 90 days of snapshots for
 * the history sparklines, and each component's band ladder exactly as `@ctx/insights`' `thresholds.ts`
 * states it — so the zone charts' edges come from the scoring rules over the wire and are never re-typed
 * in the web.
 *
 * **On demand.** When today's row (today in the holder's display time zone) is missing — the 04:10 job has
 * not run yet today, or the worker was down — this request computes it once through the same
 * `ensureHealthSnapshotForToday` the job calls, and says so (`writtenNow`). It never backfills a missing
 * day. With no `advisor_token_secret` (no snapshot can be built) it serves the latest stored row, if any,
 * and its own `asOfDate` says how old it is; with none at all it is 404 `insights.health_not_computed`.
 *
 * The score is `computeHealthScore`, unchanged since WP 5.8; `GET /insights/health-score` (the weekly row)
 * is untouched.
 */
import { DateOnly, todayIn } from '@core/kernel';
import {
  HEALTH_BAND_THRESHOLDS,
  HEALTH_BANDS,
  HEALTH_COMPONENT_IDS,
  ensureHealthSnapshotForToday,
  listHealthSnapshots,
  type HealthPillar,
  type StoredHealthSnapshot,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
} from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { createLivingExpensesPort } from '../reports/living-expenses.ts';
import { dateOnly, isoInstant, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** The history the screen draws: today and the 89 days before it. */
export const HEALTH_HISTORY_DAYS = 90;

const componentEnum = z.enum(HEALTH_COMPONENT_IDS);
const bandEnum = z.enum(HEALTH_BANDS);
const valueSchema = z.union([z.string(), moneySchema]);

const pillarInputSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['money', 'months', 'ratio', 'count', 'text']),
    value: valueSchema,
  })
  .meta({ id: 'HealthPillarDatum' });

const monthWindowSchema = z.object({ from: z.string(), to: z.string() });

const livingCoverSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('computed'),
      months: z.string().describe('Cash ÷ living expenses per month, one decimal.'),
      band: bandEnum,
      livingExpenses: z.object({
        status: z.literal('computed'),
        monthly: moneySchema,
        fixedMonthlyAverage: moneySchema,
        nonMonthlyMonthlyShare: moneySchema,
        fixedCategoryCount: z.int(),
        nonMonthlyCategoryCount: z.int(),
        fixedWindow: monthWindowSchema,
        nonMonthlyWindow: monthWindowSchema,
      }),
    }),
    z.object({ status: z.literal('withheld'), reason: z.string(), unlock: z.string() }),
  ])
  .meta({ id: 'HealthLivingCover' });

const pillarSchema = z
  .discriminatedUnion('status', [
    z.object({
      component: componentEnum,
      status: z.literal('scored'),
      value: valueSchema,
      band: bandEnum,
      weight: z.string(),
      score: z.number(),
      inputs: z.array(pillarInputSchema),
      livingCover: livingCoverSchema.optional(),
    }),
    z.object({
      component: componentEnum,
      status: z.literal('withheld'),
      reason: z.string(),
      unlock: z.string(),
      inputs: z.array(pillarInputSchema),
      livingCover: livingCoverSchema.optional(),
    }),
  ])
  .meta({ id: 'HealthPillar' });

const historyEntrySchema = z
  .object({
    asOfDate: dateOnly,
    score: z.number().nullable(),
    pillars: z.array(
      z.object({
        component: componentEnum,
        /** `null` when the pillar was withheld that day. */
        score: z.number().nullable(),
        value: valueSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'HealthHistoryEntry' });

const thresholdSchema = z
  .object({
    component: componentEnum,
    unit: z.enum(['months', 'ratio', 'usd_per_year']),
    higherIsBetter: z.boolean(),
    /** Ascending, three decimal strings: the band edges `classifyDecimal` compares against. */
    boundaries: z.array(z.string()).length(3),
  })
  .meta({ id: 'HealthThreshold' });

const healthOverviewSchema = z
  .object({
    asOfDate: dateOnly,
    /** The holder's today; differs from `asOfDate` only when today's row could not be computed. */
    today: dateOnly,
    computedAt: isoInstant,
    score: z.number().nullable(),
    pillars: z.array(pillarSchema),
    history: z.array(historyEntrySchema),
    thresholds: z.array(thresholdSchema),
    writtenNow: z.boolean(),
  })
  .meta({ id: 'HealthOverview' });

function notComputed(): AppError {
  return new AppError({
    status: 404,
    code: 'insights.health_not_computed',
    title: 'Not Found',
    detail:
      'No health snapshot exists for this holder, and none can be computed here: no ' +
      'advisor_token_secret is configured.',
    family: 'user',
  });
}

async function timezoneOf(deps: RouteDeps, userId: string): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    'SELECT display_timezone FROM users WHERE id = $1',
    [userId],
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

function historyEntryOf(snapshot: StoredHealthSnapshot): z.infer<typeof historyEntrySchema> {
  return {
    asOfDate: snapshot.asOfDate,
    score: snapshot.score,
    pillars: snapshot.pillars.map((pillar: HealthPillar) => ({
      component: pillar.component,
      score: pillar.status === 'scored' ? pillar.score : null,
      value: pillar.status === 'scored' ? pillar.value : null,
    })),
  };
}

export const healthScoreRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  return async (app) => {
    app.get(
      '/insights/health',
      {
        schema: {
          operationId: 'getHealthOverview',
          summary: 'The financial health score today, as pillars, with 90 days of history',
          description:
            "Today's daily health snapshot (computed once on demand when the 04:10 job has not " +
            'written it yet), its six pillars — each scored with the inputs it was built from, or ' +
            'withheld with the reason and what would unlock it, never a zero — the last 90 days of ' +
            "snapshots, and each component's band ladder from the scoring rules.",
          tags: ['insights'],
          response: {
            200: z.object({ health: healthOverviewSchema }),
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await deps.guards.requireSession(request);
        const userId = session.userId;
        const timeZone = await timezoneOf(deps, userId);
        const today = todayIn(deps.clock, timeZone);
        const tokenSecret = deps.config.secrets.advisor_token_secret;

        let current: StoredHealthSnapshot | null = null;
        let writtenNow = false;
        if (tokenSecret !== undefined) {
          const ensured = await ensureHealthSnapshotForToday(
            {
              database: deps.database,
              snapshotPorts: {
                ledger: createInsightsLedgerPort(deps.database, deps.clock),
                budget: createInsightsBudgetPort(deps.database),
                recurring: createInsightsRecurringPort(deps.database),
                investments: createInsightsInvestmentsPort(deps.database, deps.clock),
                planning: createInsightsPlanningPort(deps.database, deps.clock, { timeZone }),
                marketData: createInsightsMarketDataPort({ source: undefined }),
              },
              tokenSecret: tokenSecret.reveal(),
              currencyCode: 'USD',
              livingExpenses: createLivingExpensesPort(deps.database),
              clock: deps.clock,
            },
            { userId, timeZone },
          );
          current = ensured.snapshot;
          writtenNow = ensured.written;
        }

        const from = DateOnly.addDays(today, -(HEALTH_HISTORY_DAYS - 1));
        const history = await listHealthSnapshots(deps.database, userId, { from, to: today });
        current ??= history[history.length - 1] ?? null;
        if (current === null) throw notComputed();

        return {
          health: {
            asOfDate: current.asOfDate,
            today,
            computedAt: current.computedAt.toISOString(),
            score: current.score,
            pillars: current.pillars.map((pillar) => ({
              ...pillar,
              inputs: pillar.inputs.map((input) => ({ ...input })),
            })),
            history: history.map(historyEntryOf),
            thresholds: HEALTH_COMPONENT_IDS.map((component) => {
              const definition = HEALTH_BAND_THRESHOLDS[component];
              return {
                component,
                unit: definition.unit,
                higherIsBetter: definition.higherIsBetter,
                boundaries: definition.boundaries.map((boundary) => boundary.value),
              };
            }),
            writtenNow,
          },
        };
      },
    );
  };
};
