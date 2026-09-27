// SPDX-License-Identifier: MIT
/**
 * `/plan/scenarios`, `/plan/scenarios/{id}/projections`, `/plan/projections/{id}`,
 * `/plan/required-savings`, `/plan/life-events` and `/plan/compare` — WP
 * 4.4/4.5/4.6's engine and store, as HTTP.
 *
 * ## Wire shapes are the domain's rich types, not the stored JSON documents
 *
 * `@ctx/planning`'s `BaselineProfile` and `ScenarioLevers` are the types
 * `saveBaseline`/`createScenario` actually take; `profileToJson`/`leversToJson`
 * (the *stored-document* codec, snake_case levers, string-encoded ages and
 * glidepaths) are `scenarios.ts`'s own internal concern and are not part of
 * `@ctx/planning`'s public surface. This file's wire shapes mirror the rich
 * types directly — `retirementAge` a JSON number, `glidepath` a small tagged
 * object, `ssClaimAge` `{ years, months }` — so the whole surface stays
 * camelCase and consistent with every other route in this application, and so
 * there is exactly one place (this file's `toBaselineProfile`/`fromScenario`
 * pair) doing the JSON ↔ domain conversion rather than two.
 *
 * ## `successProbability` is a decimal string on the wire, never a JSON number
 *
 * `StoredRun.successProbability` already arrives as a `NUMERIC(7,6)` decimal
 * string from `@ctx/planning`; this file declares it `z.string()` and never
 * calls `Number()` on it anywhere between the store and the response body —
 * the dispatch's own exit test is a wire assertion of exactly that.
 *
 * ## `unreachable` is a shape, not a number
 *
 * `POST /plan/required-savings`'s response is a discriminated union
 * (`kind: 'already_met' | 'required' | 'unreachable'`); the `unreachable`
 * branch carries a `constraint` and **no `monthly` field at all** — not `null`,
 * absent — because `RequiredSavingsResult`'s own TypeScript union has no such
 * field on that branch and this file serialises each branch separately rather
 * than merging them into one object with optional keys.
 *
 * ## On-demand Monte Carlo reaches a runner through `deps.monteCarlo`
 *
 * `docs/evidence/phase-4/wp4.8-routes.md` records the choice: the worker
 * binds a `MonteCarloRunner` for the nightly refresh job; this process binds
 * its own (`app.ts`, `createMonteCarloRunnerFromCache`) for an interactive
 * request, mirroring the worker rather than adding an RPC to it. `null` (no
 * return series on disk) falls back to the deterministic engine exactly as
 * `refreshBaseline` does, and the response's `method` field says which ran.
 *
 * Session-only throughout — a projection is a forecast about the caller's own
 * plan, never a credential (D21 does not apply, the `goals.ts`/`budgets.ts`
 * reasoning again).
 */
import {
  compareScenarios,
  createLifeEvent,
  createProjectionInputsReader,
  createScenario,
  currentRegistry,
  deleteLifeEvent,
  getBaseline,
  listLifeEvents,
  listScenarios,
  LIFE_EVENT_KINDS,
  MAX_PLAN_AGE,
  PROJECTION_METHODS,
  ProjectionRefused,
  readProjection,
  resolveForUser,
  runProjection,
  saveBaseline,
  solveRequiredSavings,
  updateLifeEvent,
  assembleBaselinePlan,
  lifeEventsForPlan,
  getGoal,
  type BaselineProfile,
  type ClaimAge,
  type GlidepathChoice,
  type LifeEvent,
  type PensionColaChoice,
  type PensionPlan,
  type ProjectionMethod,
  type ProjectionOutcome,
  type ProjectionServiceDependencies,
  type RequiredSavingsRequest,
  type Scenario,
  type ScenarioComparison,
  type ScenarioLevers,
  type Staleness,
  type StoredPercentile,
  type StoredRun,
} from '@ctx/planning';
import { DateOnly, Money, type Money as MoneyType } from '@core/kernel';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { planningRevealedPortsFor } from '../domain.ts';
import { mapDomainErrors } from './domain-errors.ts';
import { problems } from '../problem.ts';
import { booleanQuery, dateOnly, dateOnlyQuery, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder, and their zone is what a local calendar day means. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

/** Monte Carlo when a runner is bound, deterministic otherwise — `refreshBaseline`'s own rule. */
function defaultMethodFor(deps: RouteDeps): ProjectionMethod {
  return deps.monteCarlo === null ? 'deterministic' : 'monte_carlo';
}

// ---------------------------------------------------------------------------
// Wire ↔ domain: the baseline profile
// ---------------------------------------------------------------------------

const glidepathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('age_based') }),
  z.object({ kind: z.literal('target_date') }),
  z.object({ kind: z.literal('rising_equity') }),
  z.object({ kind: z.literal('static'), equityShare: z.string() }),
]);

function glidepathOf(choice: GlidepathChoice): z.infer<typeof glidepathSchema> {
  return choice.kind === 'static' ? { kind: 'static', equityShare: choice.equityShare } : choice;
}

const claimAgeSchema = z.object({ years: z.int().min(0).max(200), months: z.int().min(0).max(11) });

function claimAgeOf(claim: ClaimAge): z.infer<typeof claimAgeSchema> {
  return { years: claim.years, months: claim.months };
}

const colaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('cpi') }),
  z.object({ kind: z.literal('fixed'), rate: z.string() }),
]);

function colaOf(cola: PensionColaChoice): z.infer<typeof colaSchema> {
  return cola.kind === 'fixed' ? { kind: 'fixed', rate: cola.rate } : cola;
}

const pensionSchema = z.object({
  name: z.string().min(1).max(96),
  startAge: z.int().min(0).max(MAX_PLAN_AGE),
  annualBenefit: moneySchema,
  cola: colaSchema,
});

function pensionOf(pension: PensionPlan): z.infer<typeof pensionSchema> {
  return {
    name: pension.name,
    startAge: pension.startAge,
    annualBenefit: money(pension.annualBenefit),
    cola: colaOf(pension.cola),
  };
}

const bucketKeys = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const;

const bucketAmountsSchema = z
  .object({
    TAXABLE: moneySchema.optional(),
    TAX_DEFERRED: moneySchema.optional(),
    ROTH: moneySchema.optional(),
    HSA: moneySchema.optional(),
  })
  .nullable();

const baselineProfileSchema = z.object({
  birthDate: dateOnlyQuery,
  retirementAge: z.int().min(0).max(MAX_PLAN_AGE),
  planEndAge: z.int().min(0).max(MAX_PLAN_AGE),
  currency: z.string().length(3),
  glidepath: glidepathSchema,
  contributionGrowth: z.enum(['wage', 'flat']),
  annualSpending: moneySchema.nullable(),
  withdrawalPolicy: z.enum(['constant_real', 'guardrails']),
  spendingFloor: z.union([z.enum(['essential_spend', 'none']), moneySchema]),
  cumulativeCutCap: z.string().nullable().optional(),
  taxDeferredRate: z.string(),
  socialSecurity: z
    .object({ monthlyPia: moneySchema, claimAge: claimAgeSchema, stressAfter2034: z.boolean() })
    .nullable(),
  pensions: z.array(pensionSchema).max(8),
  contributions: bucketAmountsSchema,
});

function toBaselineProfile(body: z.infer<typeof baselineProfileSchema>): BaselineProfile {
  const given = body.contributions;
  const contributions: Partial<Record<(typeof bucketKeys)[number], MoneyType>> | null =
    given === null || given === undefined
      ? null
      : bucketKeys.reduce<Partial<Record<(typeof bucketKeys)[number], MoneyType>>>(
          (acc, bucket) => {
            const amount = given[bucket];
            if (amount !== undefined) acc[bucket] = Money.fromJSON(amount);
            return acc;
          },
          {},
        );
  return {
    birthDate: DateOnly.parse(body.birthDate),
    retirementAge: body.retirementAge,
    planEndAge: body.planEndAge,
    currency: body.currency,
    glidepath: body.glidepath,
    contributionGrowth: body.contributionGrowth,
    annualSpending: body.annualSpending === null ? null : Money.fromJSON(body.annualSpending),
    withdrawalPolicy: body.withdrawalPolicy,
    spendingFloor:
      typeof body.spendingFloor === 'string'
        ? body.spendingFloor
        : Money.fromJSON(body.spendingFloor),
    ...(body.cumulativeCutCap === undefined ? {} : { cumulativeCutCap: body.cumulativeCutCap }),
    taxDeferredRate: body.taxDeferredRate,
    socialSecurity:
      body.socialSecurity === null
        ? null
        : {
            monthlyPia: Money.fromJSON(body.socialSecurity.monthlyPia),
            claimAge: body.socialSecurity.claimAge,
            stressAfter2034: body.socialSecurity.stressAfter2034,
          },
    pensions: body.pensions.map((pension) => ({
      name: pension.name,
      startAge: pension.startAge,
      annualBenefit: Money.fromJSON(pension.annualBenefit),
      cola: pension.cola,
    })),
    contributions,
  };
}

function fromBaselineProfile(profile: BaselineProfile): z.infer<typeof baselineProfileSchema> {
  const given = profile.contributions;
  const contributions =
    given === null
      ? null
      : bucketKeys.reduce<Record<string, z.infer<typeof moneySchema>>>((acc, bucket) => {
          const amount = given[bucket];
          if (amount !== undefined) acc[bucket] = money(amount);
          return acc;
        }, {});
  return {
    birthDate: profile.birthDate,
    retirementAge: profile.retirementAge,
    planEndAge: profile.planEndAge,
    currency: profile.currency,
    glidepath: glidepathOf(profile.glidepath),
    contributionGrowth: profile.contributionGrowth,
    annualSpending: profile.annualSpending === null ? null : money(profile.annualSpending),
    withdrawalPolicy: profile.withdrawalPolicy,
    spendingFloor:
      typeof profile.spendingFloor === 'string'
        ? profile.spendingFloor
        : money(profile.spendingFloor),
    ...(profile.cumulativeCutCap === undefined
      ? {}
      : { cumulativeCutCap: profile.cumulativeCutCap }),
    taxDeferredRate: profile.taxDeferredRate,
    socialSecurity:
      profile.socialSecurity === null
        ? null
        : {
            monthlyPia: money(profile.socialSecurity.monthlyPia),
            claimAge: claimAgeOf(profile.socialSecurity.claimAge),
            stressAfter2034: profile.socialSecurity.stressAfter2034,
          },
    pensions: profile.pensions.map(pensionOf),
    contributions,
  };
}

// ---------------------------------------------------------------------------
// Wire ↔ domain: scenario levers
// ---------------------------------------------------------------------------

const scenarioLeversSchema = z.object({
  retireAge: z.int().min(0).max(MAX_PLAN_AGE).optional(),
  savingsRate: z.string().optional(),
  annualSpending: moneySchema.optional(),
  expectedReturnShift: z.string().optional(),
  ssClaimAge: claimAgeSchema.optional(),
  partTimeIncome: z.object({ annual: moneySchema, years: z.int().min(0).max(40) }).optional(),
  oneTimeWindfall: z.object({ amount: moneySchema, on: dateOnlyQuery }).optional(),
  glidepath: glidepathSchema.optional(),
});

function toScenarioLevers(body: z.infer<typeof scenarioLeversSchema>): ScenarioLevers {
  return {
    ...(body.retireAge === undefined ? {} : { retireAge: body.retireAge }),
    ...(body.savingsRate === undefined ? {} : { savingsRate: body.savingsRate }),
    ...(body.annualSpending === undefined
      ? {}
      : { annualSpending: Money.fromJSON(body.annualSpending) }),
    ...(body.expectedReturnShift === undefined
      ? {}
      : { expectedReturnShift: body.expectedReturnShift }),
    ...(body.ssClaimAge === undefined ? {} : { ssClaimAge: body.ssClaimAge }),
    ...(body.partTimeIncome === undefined
      ? {}
      : {
          partTimeIncome: {
            annual: Money.fromJSON(body.partTimeIncome.annual),
            years: body.partTimeIncome.years,
          },
        }),
    ...(body.oneTimeWindfall === undefined
      ? {}
      : {
          oneTimeWindfall: {
            amount: Money.fromJSON(body.oneTimeWindfall.amount),
            on: DateOnly.parse(body.oneTimeWindfall.on),
          },
        }),
    ...(body.glidepath === undefined ? {} : { glidepath: body.glidepath }),
  };
}

function fromScenarioLevers(levers: ScenarioLevers): z.infer<typeof scenarioLeversSchema> {
  return {
    ...(levers.retireAge === undefined ? {} : { retireAge: levers.retireAge }),
    ...(levers.savingsRate === undefined ? {} : { savingsRate: levers.savingsRate }),
    ...(levers.annualSpending === undefined
      ? {}
      : { annualSpending: money(levers.annualSpending) }),
    ...(levers.expectedReturnShift === undefined
      ? {}
      : { expectedReturnShift: levers.expectedReturnShift }),
    ...(levers.ssClaimAge === undefined ? {} : { ssClaimAge: claimAgeOf(levers.ssClaimAge) }),
    ...(levers.partTimeIncome === undefined
      ? {}
      : {
          partTimeIncome: {
            annual: money(levers.partTimeIncome.annual),
            years: levers.partTimeIncome.years,
          },
        }),
    ...(levers.oneTimeWindfall === undefined
      ? {}
      : {
          oneTimeWindfall: {
            amount: money(levers.oneTimeWindfall.amount),
            on: levers.oneTimeWindfall.on,
          },
        }),
    ...(levers.glidepath === undefined ? {} : { glidepath: glidepathOf(levers.glidepath) }),
  };
}

// ---------------------------------------------------------------------------
// Wire: scenarios
// ---------------------------------------------------------------------------

const scenarioSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('baseline'),
      id: z.uuid(),
      name: z.string(),
      profile: baselineProfileSchema,
      /** Unsigned 64-bit, as a decimal string — never a JSON number (04 §5.6). */
      seed: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .meta({ id: 'BaselineScenario' }),
  z
    .object({
      kind: z.literal('fork'),
      id: z.uuid(),
      baselineId: z.uuid(),
      name: z.string(),
      levers: scenarioLeversSchema,
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .meta({ id: 'ForkScenario' }),
]);

function serialiseScenario(scenario: Scenario): z.infer<typeof scenarioSchema> {
  if (scenario.kind === 'baseline') {
    return {
      kind: 'baseline',
      id: scenario.id,
      name: scenario.name,
      profile: fromBaselineProfile(scenario.profile),
      seed: scenario.seed.toString(),
      createdAt: scenario.createdAt.toISOString(),
      updatedAt: scenario.updatedAt.toISOString(),
    };
  }
  return {
    kind: 'fork',
    id: scenario.id,
    baselineId: scenario.baselineId,
    name: scenario.name,
    levers: fromScenarioLevers(scenario.levers),
    createdAt: scenario.createdAt.toISOString(),
    updatedAt: scenario.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Wire: a run and its bands
// ---------------------------------------------------------------------------

const percentileSchema = z.object({
  index: z.int(),
  age: z.int(),
  calendarYear: z.int(),
  p5: moneySchema.nullable(),
  p10: moneySchema.nullable(),
  p25: moneySchema.nullable(),
  p50: moneySchema,
  p75: moneySchema.nullable(),
  p90: moneySchema.nullable(),
  p95: moneySchema.nullable(),
});

function serialisePercentile(row: StoredPercentile): z.infer<typeof percentileSchema> {
  return {
    index: row.index,
    age: row.age,
    calendarYear: row.calendarYear,
    p5: row.p5 === null ? null : money(row.p5),
    p10: row.p10 === null ? null : money(row.p10),
    p25: row.p25 === null ? null : money(row.p25),
    p50: money(row.p50),
    p75: row.p75 === null ? null : money(row.p75),
    p90: row.p90 === null ? null : money(row.p90),
    p95: row.p95 === null ? null : money(row.p95),
  };
}

const runSchema = z
  .object({
    id: z.uuid(),
    scenarioId: z.uuid(),
    scenarioKind: z.enum(['baseline', 'fork']),
    method: z.enum(PROJECTION_METHODS),
    seed: z.string(),
    paths: z.int(),
    engineVersion: z.string(),
    assumptionsVersion: z.string(),
    asOfDate: dateOnly,
    balancesSealed: z.boolean(),
    currency: z.string().length(3),
    /** A decimal string in [0, 1] — never a JSON number (the dispatch's own exit test). */
    successProbability: z.string(),
    durationMs: z.int(),
    createdAt: z.string(),
  })
  .meta({ id: 'ProjectionRun' });

function serialiseRun(run: StoredRun): z.infer<typeof runSchema> {
  return {
    id: run.id,
    scenarioId: run.scenarioId,
    scenarioKind: run.scenarioKind,
    method: run.method,
    seed: run.seed.toString(),
    paths: run.paths,
    engineVersion: run.engineVersion,
    assumptionsVersion: run.assumptionsVersion,
    asOfDate: run.asOfDate,
    balancesSealed: run.balancesSealed,
    currency: run.currency,
    successProbability: run.successProbability,
    durationMs: run.durationMs,
    createdAt: run.createdAt.toISOString(),
  };
}

const stalenessSchema = z
  .discriminatedUnion('reason', [
    z.object({
      reason: z.literal('assumptions_version_retired'),
      assumptionsVersion: z.string(),
      known: z.array(z.string()),
    }),
    z.object({
      reason: z.literal('assumptions_changed'),
      assumptionsVersion: z.string(),
      currentVersion: z.string(),
    }),
  ])
  .meta({ id: 'ProjectionStaleness' });

function serialiseStaleness(staleness: Staleness): z.infer<typeof stalenessSchema> {
  return staleness.reason === 'assumptions_version_retired'
    ? {
        reason: 'assumptions_version_retired',
        assumptionsVersion: staleness.assumptionsVersion,
        known: [...staleness.known],
      }
    : {
        reason: 'assumptions_changed',
        assumptionsVersion: staleness.assumptionsVersion,
        currentVersion: staleness.currentVersion,
      };
}

const projectionOutcomeSchema = z.object({
  status: z.enum(['computed', 'cached', 'stale']),
  run: runSchema.nullable(),
  percentiles: z.array(percentileSchema),
  staleness: stalenessSchema.nullable(),
});

function serialiseOutcome(outcome: ProjectionOutcome): z.infer<typeof projectionOutcomeSchema> {
  return {
    status: outcome.status,
    run: outcome.run === null ? null : serialiseRun(outcome.run),
    percentiles: outcome.percentiles.map(serialisePercentile),
    staleness: outcome.status === 'stale' ? serialiseStaleness(outcome.staleness) : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const planRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  function dependenciesFor(
    tx: Parameters<typeof planningRevealedPortsFor>[0],
    userId: string,
    timeZone: string,
  ): ProjectionServiceDependencies {
    return {
      inputs: createProjectionInputsReader(
        tx,
        planningRevealedPortsFor(tx, { userId, timeZone, clock }),
      ),
      monteCarlo: deps.monteCarlo,
      clock,
      timeZone,
      registry: currentRegistry(),
    };
  }

  return async (app) => {
    // -------------------------------------------------------------------
    // Scenarios
    // -------------------------------------------------------------------

    app.get(
      '/plan/scenarios',
      {
        schema: {
          operationId: 'listPlanScenarios',
          summary: 'The baseline (if stated) first, then its forks oldest first',
          tags: ['planning'],
          response: {
            200: z.object({ scenarios: z.array(scenarioSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const scenarios = await listScenarios(database, session.userId);
        return { scenarios: scenarios.map(serialiseScenario) };
      },
    );

    app.post(
      '/plan/scenarios',
      {
        schema: {
          operationId: 'createPlanScenario',
          summary: 'State (or restate) the baseline, or fork it',
          description:
            'A `"baseline"` body upserts the one baseline scenario: a second call replaces the ' +
            'profile and keeps the id and seed, so every fork and every stored run still points ' +
            'at it. A `"fork"` body stores only the levers that differ from the baseline — a ' +
            'fork that restates every lever is refused (`planning.scenario_levers_empty`, 422).',
          tags: ['planning'],
          body: z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('baseline'),
              name: z.string().min(1).max(96),
              profile: baselineProfileSchema,
              seed: z.string().regex(/^\d+$/).optional(),
            }),
            z.object({
              kind: z.literal('fork'),
              name: z.string().min(1).max(96),
              levers: scenarioLeversSchema,
              baselineId: z.uuid().optional(),
            }),
          ]),
          response: { 201: scenarioSchema, ...problems(400, 401, 404, 409, 422, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const body = request.body;
        if (body.kind === 'baseline') {
          const scenario = await mapDomainErrors(() =>
            saveBaseline(database, {
              userId: session.userId,
              name: body.name,
              profile: toBaselineProfile(body.profile),
              ...(body.seed === undefined ? {} : { seed: BigInt(body.seed) }),
              clock,
            }),
          );
          return reply.code(201).send(serialiseScenario(scenario));
        }
        const scenario = await mapDomainErrors(() =>
          createScenario(database, {
            userId: session.userId,
            name: body.name,
            levers: toScenarioLevers(body.levers),
            ...(body.baselineId === undefined ? {} : { baselineId: body.baselineId }),
            clock,
          }),
        );
        return reply.code(201).send(serialiseScenario(scenario));
      },
    );

    // -------------------------------------------------------------------
    // Projections
    // -------------------------------------------------------------------

    app.post(
      '/plan/scenarios/:scenarioId/projections',
      {
        schema: {
          operationId: 'runPlanProjection',
          summary: 'Serve a scenario’s projection from the cache, or run it',
          description:
            'An identical request (same assumptions, seed, engine version and input) is served ' +
            'from `projection_runs` without running the engine again. `method` defaults to ' +
            '`monte_carlo` when a Monte Carlo engine is bound in this process, `deterministic` ' +
            'otherwise; the response says which ran. `successProbability` is a decimal string, ' +
            'never a JSON number.',
          tags: ['planning'],
          params: z.object({ scenarioId: z.uuid() }),
          body: z.object({
            method: z.enum(PROJECTION_METHODS).optional(),
            paths: z.int().min(2).max(1_000_000).optional(),
            asOf: dateOnlyQuery.nullable().optional(),
            allowOpenDay: z.boolean().optional(),
          }),
          response: {
            200: projectionOutcomeSchema,
            ...problems(400, 401, 404, 409, 422, 500, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const outcome = await mapDomainErrors(() =>
          database.transaction((tx) =>
            runProjection(tx, dependenciesFor(tx, session.userId, timeZone), {
              userId: session.userId,
              scenarioId: request.params.scenarioId,
              method: request.body.method ?? defaultMethodFor(deps),
              ...(request.body.paths === undefined ? {} : { paths: request.body.paths }),
              asOf:
                request.body.asOf === undefined || request.body.asOf === null
                  ? null
                  : DateOnly.parse(request.body.asOf),
              allowOpenDay: request.body.allowOpenDay ?? false,
              correlationId: String(request.id),
            }),
          ),
        );
        return serialiseOutcome(outcome);
      },
    );

    app.get(
      '/plan/projections/:runId',
      {
        schema: {
          operationId: 'getPlanProjection',
          summary: 'A stored run, exactly as stored, with its staleness named',
          description:
            'Never recomputes. A run whose assumptions version this build no longer holds reads ' +
            'back `assumptions_version_retired`; one whose version resolves but whose current ' +
            'assumptions differ from the run’s reads back `assumptions_changed`.',
          tags: ['planning'],
          params: z.object({ runId: z.uuid() }),
          response: { 200: projectionOutcomeSchema, ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const { run, percentiles, staleness } = await mapDomainErrors(() =>
          readProjection(database, {
            userId: session.userId,
            runId: request.params.runId,
            timeZone,
            registry: currentRegistry(),
          }),
        );
        return {
          status: staleness === null ? ('computed' as const) : ('stale' as const),
          run: serialiseRun(run),
          percentiles: percentiles.map(serialisePercentile),
          staleness: staleness === null ? null : serialiseStaleness(staleness),
        };
      },
    );

    // -------------------------------------------------------------------
    // Required savings (09 GOAL-7's dotted gap line)
    // -------------------------------------------------------------------

    app.post(
      '/plan/required-savings',
      {
        schema: {
          operationId: 'solveRequiredSavings',
          summary: 'The additional monthly contribution that closes a gap by a target date',
          description:
            'A gap no contribution can close returns `"unreachable"` with the binding constraint ' +
            '— never a number that implies a solution. Name a `goalId` to solve for that goal’s ' +
            'own target and date, or state `objective` directly for an arbitrary date/amount or ' +
            'for "sustain the plan to its end".',
          tags: ['planning'],
          body: z
            .object({
              goalId: z.uuid().optional(),
              objective: z
                .discriminatedUnion('kind', [
                  z.object({
                    kind: z.literal('wealth_at'),
                    targetDate: dateOnlyQuery,
                    target: moneySchema,
                    basis: z.enum(['real', 'nominal']),
                  }),
                  z.object({ kind: z.literal('sustain_to_plan_end') }),
                ])
                .optional(),
              maxMonthly: moneySchema,
              asOf: dateOnlyQuery.nullable().optional(),
              allowOpenDay: z.boolean().optional(),
            })
            .refine(
              (body) => body.goalId !== undefined || body.objective !== undefined,
              'name a goalId or state an objective',
            ),
          response: {
            200: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('already_met'), monthly: moneySchema }),
              z.object({
                kind: z.literal('required'),
                monthly: moneySchema,
                iterations: z.int(),
                verified: z.literal(true),
              }),
              z.object({
                kind: z.literal('unreachable'),
                constraint: z.discriminatedUnion('name', [
                  z.object({
                    name: z.literal('no_contribution_window'),
                    detail: z.string(),
                    contributionsEndAge: z.int(),
                  }),
                  z.object({
                    name: z.literal('monthly_ceiling'),
                    detail: z.string(),
                    ceiling: moneySchema,
                    gapAtCeiling: moneySchema,
                  }),
                ]),
              }),
            ]),
            ...problems(400, 401, 404, 409, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const result = await mapDomainErrors(async () => {
          // Resolve the objective — and, when a `goalId` is named, the
          // ownership check that goes with it — *before* checking the
          // baseline exists. Ownership must refuse a foreign goal with a 404
          // regardless of the caller's own baseline state; checking the
          // baseline first would let an unrelated `planning.scenario_no
          // _baseline` 409 mask "that is not your goal" for a caller with no
          // baseline of their own.
          let objective: RequiredSavingsRequest['objective'];
          if (request.body.objective !== undefined) {
            const stated = request.body.objective;
            objective =
              stated.kind === 'sustain_to_plan_end'
                ? { kind: 'sustain_to_plan_end' }
                : {
                    kind: 'wealth_at',
                    targetDate: DateOnly.parse(stated.targetDate),
                    target: Money.fromJSON(stated.target),
                    basis: stated.basis,
                  };
          } else {
            // The body's own `.refine` guarantees one of the two is present.
            const goalId = request.body.goalId;
            if (goalId === undefined)
              throw new Error('refined body guarantees goalId or objective');
            const goal = await getGoal(database, session.userId, goalId);
            objective = {
              kind: 'wealth_at',
              targetDate: goal.targetDate,
              target: goal.target,
              basis: 'real',
            };
          }

          const baseline = await getBaseline(database, session.userId);
          if (baseline === null) {
            throw new ProjectionRefused(
              'planning.scenario_no_baseline',
              'state a baseline plan before solving for required savings',
            );
          }

          const resolved = await resolveForUser(
            database,
            { userId: session.userId, timeZone },
            currentRegistry(),
          );
          const inputs = createProjectionInputsReader(
            database,
            planningRevealedPortsFor(database, { userId: session.userId, timeZone, clock }),
          );
          const derived = await inputs.derivedInputs({
            userId: session.userId,
            asOf:
              request.body.asOf === undefined || request.body.asOf === null
                ? null
                : DateOnly.parse(request.body.asOf),
            allowOpenDay: request.body.allowOpenDay ?? false,
          });
          const assembled = assembleBaselinePlan(baseline.profile, derived);
          const events = lifeEventsForPlan(
            await listLifeEvents(database, session.userId),
            assembled.plan,
          );
          const plan = {
            ...assembled.plan,
            otherIncome: [...assembled.plan.otherIncome, ...events.income],
          };
          return solveRequiredSavings(plan, resolved, {
            objective,
            maxMonthly: Money.fromJSON(request.body.maxMonthly),
          });
        });
        switch (result.kind) {
          case 'already_met':
            return { kind: 'already_met' as const, monthly: money(result.monthly) };
          case 'required':
            return {
              kind: 'required' as const,
              monthly: money(result.monthly),
              iterations: result.iterations,
              verified: true as const,
            };
          case 'unreachable':
            return {
              kind: 'unreachable' as const,
              constraint:
                result.constraint.name === 'no_contribution_window'
                  ? {
                      name: 'no_contribution_window' as const,
                      detail: result.constraint.detail,
                      contributionsEndAge: result.constraint.contributionsEndAge,
                    }
                  : {
                      name: 'monthly_ceiling' as const,
                      detail: result.constraint.detail,
                      ceiling: money(result.constraint.ceiling),
                      gapAtCeiling: money(result.constraint.gapAtCeiling),
                    },
            };
        }
      },
    );

    // -------------------------------------------------------------------
    // Life events
    // -------------------------------------------------------------------

    const lifeEventSchema = z
      .object({
        id: z.uuid(),
        kind: z.enum(LIFE_EVENT_KINDS),
        name: z.string(),
        occursOn: dateOnly,
        amount: moneySchema,
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .meta({ id: 'PlanLifeEvent' });

    function serialiseLifeEvent(event: LifeEvent): z.infer<typeof lifeEventSchema> {
      return {
        id: event.id,
        kind: event.kind,
        name: event.name,
        occursOn: event.occursOn,
        amount: money(event.amount),
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
      };
    }

    app.get(
      '/plan/life-events',
      {
        schema: {
          operationId: 'listPlanLifeEvents',
          summary: "The caller's life events, in date order",
          tags: ['planning'],
          response: {
            200: z.object({ lifeEvents: z.array(lifeEventSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const events = await listLifeEvents(database, session.userId);
        return { lifeEvents: events.map(serialiseLifeEvent) };
      },
    );

    app.post(
      '/plan/life-events',
      {
        schema: {
          operationId: 'createPlanLifeEvent',
          summary: 'Add a dated, signed life event to the plan timeline',
          description:
            'The sign is the direction: an inheritance or windfall must be positive, a home ' +
            'purchase, college or sabbatical must be negative — a mismatch is a 422 refusal, ' +
            'never a silently flipped sign.',
          tags: ['planning'],
          body: z.object({
            kind: z.enum(LIFE_EVENT_KINDS),
            name: z.string().min(1).max(96),
            occursOn: dateOnly,
            amount: moneySchema,
          }),
          response: { 201: lifeEventSchema, ...problems(400, 401, 422, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const event = await mapDomainErrors(() =>
          createLifeEvent(database, {
            userId: session.userId,
            event: {
              kind: request.body.kind,
              name: request.body.name,
              occursOn: request.body.occursOn,
              amount: Money.fromJSON(request.body.amount),
            },
            clock,
          }),
        );
        return reply.code(201).send(serialiseLifeEvent(event));
      },
    );

    app.patch(
      '/plan/life-events/:lifeEventId',
      {
        schema: {
          operationId: 'updatePlanLifeEvent',
          summary: 'Move a life event on the timeline, or restate its name or amount',
          description:
            'Not in the dispatch’s literal route list (`GET/POST/DELETE /plan/life-events`), ' +
            'added because `@ctx/planning`’s `updateLifeEvent` exists for exactly this — WP ' +
            '4.10’s own dispatch text names "draggable life events" as a WP 4.8 contract ' +
            'dependency, and there is no way to drag one without a route that moves it. Recorded ' +
            'as an addition, not hidden as an implicit part of the literal list ' +
            '(`docs/evidence/phase-4/wp4.8-routes.md`).',
          tags: ['planning'],
          params: z.object({ lifeEventId: z.uuid() }),
          body: z
            .object({
              name: z.string().min(1).max(96).optional(),
              occursOn: dateOnly.optional(),
              amount: moneySchema.optional(),
            })
            .refine(
              (body) => Object.values(body).some((value) => value !== undefined),
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: { 200: lifeEventSchema, ...problems(400, 401, 404, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const event = await mapDomainErrors(() =>
          updateLifeEvent(database, {
            userId: session.userId,
            lifeEventId: request.params.lifeEventId,
            patch: {
              ...(request.body.name === undefined ? {} : { name: request.body.name }),
              ...(request.body.occursOn === undefined ? {} : { occursOn: request.body.occursOn }),
              ...(request.body.amount === undefined
                ? {}
                : { amount: Money.fromJSON(request.body.amount) }),
            },
            clock,
          }),
        );
        return serialiseLifeEvent(event);
      },
    );

    app.delete(
      '/plan/life-events/:lifeEventId',
      {
        schema: {
          operationId: 'deletePlanLifeEvent',
          summary: 'Remove a life event',
          tags: ['planning'],
          params: z.object({ lifeEventId: z.uuid() }),
          response: { 200: z.object({ deleted: z.boolean() }), ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        await mapDomainErrors(() =>
          deleteLifeEvent(database, {
            userId: session.userId,
            lifeEventId: request.params.lifeEventId,
          }),
        );
        return { deleted: true };
      },
    );

    // -------------------------------------------------------------------
    // Compare (D20: server-authoritative, common random numbers)
    // -------------------------------------------------------------------

    app.get(
      '/plan/compare',
      {
        schema: {
          operationId: 'comparePlanScenarios',
          summary: 'Two scenarios, run under common random numbers, and their deltas',
          description:
            'Both runs use the baseline’s seed — a fork has none of its own (0022) — so the ' +
            'comparison isolates the levers’ effect from Monte Carlo noise by construction, ' +
            'not by the caller remembering to pass the same seed twice.',
          tags: ['planning'],
          querystring: z.object({
            a: z.uuid(),
            b: z.uuid(),
            method: z.enum(PROJECTION_METHODS).optional(),
            paths: z.coerce.number().int().min(2).max(1_000_000).optional(),
            asOf: dateOnlyQuery.optional(),
            allowOpenDay: booleanQuery,
          }),
          response: {
            200: z.object({
              a: projectionOutcomeSchema,
              b: projectionOutcomeSchema,
              seed: z.string(),
              /** b − a, a signed decimal string of probability — never a float. */
              successProbabilityDelta: z.string(),
              retirementDate: z.object({ a: dateOnly, b: dateOnly }),
              retirementDeltaMonths: z.int(),
            }),
            ...problems(400, 401, 404, 409, 422, 500, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const comparison: ScenarioComparison = await mapDomainErrors(() =>
          database.transaction((tx) =>
            compareScenarios(tx, dependenciesFor(tx, session.userId, timeZone), {
              scenarioA: request.query.a,
              scenarioB: request.query.b,
              userId: session.userId,
              method: request.query.method ?? defaultMethodFor(deps),
              ...(request.query.paths === undefined ? {} : { paths: request.query.paths }),
              asOf: request.query.asOf === undefined ? null : DateOnly.parse(request.query.asOf),
              allowOpenDay: request.query.allowOpenDay ?? false,
              correlationId: String(request.id),
            }),
          ),
        );
        return {
          a: serialiseOutcome(comparison.a),
          b: serialiseOutcome(comparison.b),
          seed: comparison.seed.toString(),
          successProbabilityDelta: comparison.successProbabilityDelta,
          retirementDate: { a: comparison.retirementDate.a, b: comparison.retirementDate.b },
          retirementDeltaMonths: comparison.retirementDeltaMonths,
        };
      },
    );
  };
};
