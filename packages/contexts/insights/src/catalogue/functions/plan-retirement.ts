// SPDX-License-Identifier: MIT
/**
 * `goal.required_savings`, `plan.project`, `plan.compare`, `plan.levers` and
 * the three retirement functions (WP 11.5b).
 *
 * The plan functions answer through `CataloguePlanningPort` — WP 4.6's
 * projection service and WP 4.6's required-savings solver, read-only — and
 * apply `plan.projection`'s own minimisation to what they return: money rounded
 * to the scope row's step ($1,000), years rather than dates, no scenario or run
 * id beyond the argument the caller named. Their figures cite the run's
 * identity (method, paths, seed, engine and assumptions versions, input
 * digest) — what reproduces them — which the result's inputs carry.
 */
import { z } from 'zod';
import { scopeDefinition } from '../../contract/scopes.ts';
import { MoneyJsonSchema, type MoneyJson } from '../../contract/snapshot.ts';
import { goalRef } from '../../snapshot/builder.ts';
import * as decimal from '../../validate/decimal.ts';
import { defineFunction, notAvailable, ok } from '../definition.ts';
import {
  DecimalFigureSchema,
  MoneyFigureSchema,
  dateFigure,
  DateFigureSchema,
  decimalFigure,
  decimalText,
  moneyFigure,
  parseDecimalOrThrow,
  ref,
  snapshotInputs,
} from '../figures.ts';
import { CatalogueRefusal, type PortProjection, type PortProjectionYear } from '../ports.ts';
import { FindingSchema, findingsOf, scopesOfRules } from './shared.ts';

const scenarioArg = z
  .union([z.literal('baseline'), z.uuid()])
  .describe('`baseline`, or the id of one of the holder’s scenarios.');

/** `plan.projection`'s own rounding step (08 §4.2): money in a projection crosses to the nearest $1,000. */
function projectionStepMinor(): bigint {
  return BigInt(scopeDefinition('plan.projection').minimisation.roundMonetaryToMinor);
}

/** Round to the scope's step, half-even. */
export function roundToStep(money: MoneyJson, step: bigint): MoneyJson {
  const minor = BigInt(money.minor);
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  let quotient = magnitude / step;
  const twice = (magnitude % step) * 2n;
  if (twice > step || (twice === step && quotient % 2n === 1n)) quotient += 1n;
  const rounded = quotient * step;
  return { minor: (negative ? -rounded : rounded).toString(), currency: money.currency };
}

function identityOf(projection: PortProjection): Record<string, unknown> {
  return {
    scenario_kind: projection.scenarioKind,
    method: projection.method,
    paths: projection.paths,
    seed: projection.seed,
    engine_version: projection.engineVersion,
    assumptions_version: projection.assumptionsVersion,
    input_digest: projection.inputDigest,
    as_of_year: projection.asOfYear,
    balances_sealed: projection.balancesSealed,
  };
}

function identityRefs(root: string): string[] {
  return [
    ref(`${root}.input_digest`),
    ref(`${root}.seed`),
    ref(`${root}.method`),
    ref(`${root}.paths`),
    ref(`${root}.engine_version`),
    ref(`${root}.assumptions_version`),
  ];
}

const yearFigureSchema = z.strictObject({
  age: DecimalFigureSchema,
  calendar_year: DecimalFigureSchema,
  p5: MoneyFigureSchema.nullable(),
  p50: MoneyFigureSchema,
  p95: MoneyFigureSchema.nullable(),
});

const projectionFiguresSchema = z.strictObject({
  scenario: z.string(),
  scenario_kind: z.enum(['baseline', 'fork']),
  method: z.enum(['monte_carlo', 'deterministic']),
  success_probability: DecimalFigureSchema,
  retirement_age: DecimalFigureSchema,
  retirement_year: DecimalFigureSchema,
  plan_end_age: DecimalFigureSchema,
  /** The median path, with the p5–p95 band (none for a deterministic run), rounded to $1,000. */
  median_path: z.array(yearFigureSchema),
});

function projectionFigures(scenario: string, projection: PortProjection, root: string) {
  const refs = identityRefs(root);
  const step = projectionStepMinor();
  const year = (row: PortProjectionYear) => ({
    age: decimalFigure(String(row.age), 'age', refs),
    calendar_year: decimalFigure(String(row.calendarYear), 'year', refs),
    p5: row.p5 === null ? null : moneyFigure(roundToStep(row.p5, step), refs),
    p50: moneyFigure(roundToStep(row.p50, step), refs),
    p95: row.p95 === null ? null : moneyFigure(roundToStep(row.p95, step), refs),
  });
  return {
    scenario,
    scenario_kind: projection.scenarioKind,
    method: projection.method,
    success_probability: decimalFigure(projection.successProbability, 'probability', refs),
    retirement_age: decimalFigure(String(projection.retirementAge), 'age', refs),
    retirement_year: decimalFigure(String(projection.retirementYear), 'year', refs),
    plan_end_age: decimalFigure(String(projection.planEndAge), 'age', refs),
    median_path: projection.years.map(year),
  };
}

// ---------------------------------------------------------------------------
// plan.project
// ---------------------------------------------------------------------------

export const planProject = defineFunction({
  name: 'plan.project',
  summary:
    'A scenario’s success probability and median path, served from a stored run or computed.',
  description:
    'Runs (or serves from the projection cache) one scenario of the holder’s plan: Monte Carlo ' +
    'when the engine is bound, deterministic otherwise, and the result says which. Nothing is ' +
    'stored. Money is rounded to $1,000 and years replace dates, as the plan.projection scope ' +
    'requires. A scenario whose assumptions no longer resolve answers not_available.',
  backing:
    'The projection service (WP 4.6, @ctx/planning projectScenarioFigures): prepareProjection ' +
    'and computeProjection, the phases POST /plan/scenarios/{id}/projections runs, without the store',
  scopes: ['plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({ scenario: scenarioArg.default('baseline') }),
  result: projectionFiguresSchema,
  async run(context, args) {
    const inputs: Record<string, unknown> = { args: { scenario: args.scenario } };
    const projection = await context.ports.planning.project({
      userId: context.userId,
      scenario: args.scenario,
      correlationId: context.correlationId,
    });
    if (projection.status === 'not_available') {
      return notAvailable(inputs, projection.code, projection.reason);
    }
    inputs['projection'] = identityOf(projection);
    return ok(inputs, projectionFigures(args.scenario, projection, 'projection'));
  },
});

// ---------------------------------------------------------------------------
// plan.compare
// ---------------------------------------------------------------------------

export const planCompare = defineFunction({
  name: 'plan.compare',
  summary:
    'Two scenarios under common random numbers, and the difference in success and retirement date.',
  description:
    'Both scenarios run on the baseline’s seed, so the difference is the levers’ effect and not ' +
    'Monte Carlo noise. The success-probability delta is b − a, exactly, as a decimal; the ' +
    'retirement delta is in whole months, positive when b retires later. Nothing is stored.',
  backing:
    'The projection service’s compare (WP 4.6/4.8, GET /plan/compare), read-only: ' +
    '@ctx/planning compareScenarioFigures',
  scopes: ['plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({ a: scenarioArg, b: scenarioArg }),
  result: z.strictObject({
    a: projectionFiguresSchema,
    b: projectionFiguresSchema,
    success_probability_delta: DecimalFigureSchema,
    retirement_delta_months: DecimalFigureSchema,
  }),
  async run(context, args) {
    const inputs: Record<string, unknown> = { args: { a: args.a, b: args.b } };
    const comparison = await context.ports.planning.compare({
      userId: context.userId,
      a: args.a,
      b: args.b,
      correlationId: context.correlationId,
    });
    if (comparison.status === 'not_available') {
      return notAvailable(inputs, comparison.code, comparison.reason);
    }
    inputs['comparison'] = {
      seed: comparison.seed,
      a: identityOf(comparison.a),
      b: identityOf(comparison.b),
    };
    const both = [
      ...identityRefs('comparison.a'),
      ...identityRefs('comparison.b'),
      ref('comparison.seed'),
    ];
    return ok(inputs, {
      a: projectionFigures(args.a, comparison.a, 'comparison.a'),
      b: projectionFigures(args.b, comparison.b, 'comparison.b'),
      success_probability_delta: decimalFigure(
        comparison.successProbabilityDelta,
        'probability',
        both,
      ),
      retirement_delta_months: decimalFigure(
        String(comparison.retirementDeltaMonths),
        'months',
        both,
      ),
    });
  },
});

// ---------------------------------------------------------------------------
// plan.levers
// ---------------------------------------------------------------------------

export const planLevers = defineFunction({
  name: 'plan.levers',
  summary:
    'The tornado: how much each plan lever moves the success probability, one declared step each, ' +
    'largest first.',
  description:
    'Re-runs the baseline once per lever step under common random numbers (the baseline’s seed) ' +
    'at the compare’s path count: retire a year later, save 2% more, spend 10% less in retirement, ' +
    'returns a point lower, claim Social Security a year later, $10,000 a year of part-time ' +
    'income for three years, a $10,000 windfall. Glidepath is not a magnitude and is reported ' +
    'skipped. A lever not reached before the deadline is reported skipped with reason deadline.',
  backing:
    '07 §5.10 over ScenarioLevers: @ctx/planning leverSensitivity (new in WP 11.5b), on the ' +
    'projection service’s computeProjection; bounded by LEVER_SENSITIVITY_DEADLINE_MS',
  scopes: ['plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    method: z.enum(['monte_carlo', 'deterministic']),
    deadline_ms: z.int(),
    base_success_probability: DecimalFigureSchema,
    levers: z.array(
      z.strictObject({
        lever: z.string(),
        step: z.string(),
        status: z.enum(['computed', 'skipped']),
        success_probability: DecimalFigureSchema.nullable(),
        delta: DecimalFigureSchema.nullable(),
        skip_reason: z.string().nullable(),
        skip_detail: z.string().nullable(),
      }),
    ),
  }),
  async run(context) {
    const inputs: Record<string, unknown> = { args: {} };
    const levers = await context.ports.planning.levers({
      userId: context.userId,
      correlationId: context.correlationId,
    });
    if (levers.status === 'not_available') {
      return notAvailable(inputs, levers.code, levers.reason);
    }
    inputs['tornado'] = {
      method: levers.method,
      paths: levers.paths,
      seed: levers.seed,
      engine_version: levers.engineVersion,
      assumptions_version: levers.assumptionsVersion,
      input_digest: levers.inputDigest,
      as_of_year: levers.asOfYear,
      deadline_ms: levers.deadlineMs,
      steps: levers.levers.map((lever) => ({
        lever: lever.lever,
        step: lever.step,
        ...(lever.status === 'computed' ? { levers: lever.levers } : {}),
      })),
    };
    const base = identityRefs('tornado');
    return ok(inputs, {
      method: levers.method,
      deadline_ms: levers.deadlineMs,
      base_success_probability: decimalFigure(levers.baseSuccessProbability, 'probability', base),
      levers: levers.levers.map((lever, index) => {
        const refs = [...base, ref(`tornado.steps[${String(index)}].step`)];
        return lever.status === 'computed'
          ? {
              lever: lever.lever,
              step: lever.step,
              status: 'computed' as const,
              success_probability: decimalFigure(lever.successProbability, 'probability', [
                ...refs,
                ref(`tornado.steps[${String(index)}].levers`),
              ]),
              delta: decimalFigure(lever.delta, 'probability', [
                ...refs,
                ref(`tornado.steps[${String(index)}].levers`),
              ]),
              skip_reason: null,
              skip_detail: null,
            }
          : {
              lever: lever.lever,
              step: lever.step,
              status: 'skipped' as const,
              success_probability: null,
              delta: null,
              skip_reason: lever.reason,
              skip_detail: lever.detail,
            };
      }),
    });
  },
});

// ---------------------------------------------------------------------------
// goal.required_savings
// ---------------------------------------------------------------------------

/** The solver's monthly ceiling when the caller names none: generous, and echoed in the inputs. */
export const REQUIRED_SAVINGS_DEFAULT_CEILING_MINOR = 5_000_000n;

export const goalRequiredSavings = defineFunction({
  name: 'goal.required_savings',
  summary: 'The additional monthly contribution that reaches a goal’s target by its date.',
  description:
    'Solves for the extra monthly saving that closes the goal’s gap by its target date (or the ' +
    'date given), verified by running the plan with it. A gap no contribution under the ceiling ' +
    'can close answers unreachable with the binding constraint, never a number that implies a ' +
    'solution. The goal is named by its goal_ref from the snapshot; its id never crosses.',
  backing:
    'WP 4.6’s required-savings solver (solveRequiredSavings), as POST /plan/required-savings runs it',
  scopes: ['goals.list', 'plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({
    goal_ref: z.string().regex(/^GOAL_[0-9a-f]{12}$/),
    target_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    max_monthly: MoneyJsonSchema.optional(),
  }),
  result: z.strictObject({
    goal_ref: z.string(),
    name: z.string(),
    kind: z.enum(['already_met', 'required', 'unreachable']),
    monthly: MoneyFigureSchema.nullable(),
    target: MoneyFigureSchema,
    target_date: DateFigureSchema.nullable(),
    horizon_months: DecimalFigureSchema.nullable(),
    planned_monthly: MoneyFigureSchema.nullable(),
    constraint: z
      .strictObject({
        name: z.enum(['no_contribution_window', 'monthly_ceiling']),
        detail: z.string(),
        contributions_end_age: DecimalFigureSchema.nullable(),
        ceiling: MoneyFigureSchema.nullable(),
        gap_at_ceiling: MoneyFigureSchema.nullable(),
      })
      .nullable(),
  }),
  async run(context, args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const maxMonthly = args.max_monthly ?? {
      minor: REQUIRED_SAVINGS_DEFAULT_CEILING_MINOR.toString(),
      currency: context.baseCurrency,
    };
    const inputs: Record<string, unknown> = {
      ...snapshotInputs(snapshot),
      args: {
        goal_ref: args.goal_ref,
        ...(args.target_date === undefined ? {} : { target_date: args.target_date }),
        max_monthly: maxMonthly,
      },
    };
    const goals = snapshot.goals_list?.goals ?? [];
    const index = goals.findIndex((goal) => goal.goal_ref === args.goal_ref);
    const goal = goals[index];
    if (goal === undefined) {
      throw new CatalogueRefusal('catalogue.goal_unknown', 404, `no goal ${args.goal_ref}`);
    }
    const ids = await context.ports.planning.goalIds(context.userId);
    const goalId = ids.find((id) => goalRef(context.tokenKey, id) === args.goal_ref);
    if (goalId === undefined) {
      throw new CatalogueRefusal('catalogue.goal_unknown', 404, `no goal ${args.goal_ref}`);
    }
    const solved = await context.ports.planning.requiredSavings({
      userId: context.userId,
      goalId,
      targetDate: args.target_date ?? null,
      maxMonthly,
    });
    if (solved.status === 'not_available') {
      return notAvailable(inputs, solved.code, solved.reason);
    }
    const base = `goals_list.goals[${String(index)}]`;
    const whenRef =
      args.target_date === undefined ? ref(`${base}.horizon_months`) : ref('args.target_date');
    const refs = [
      ref(`${base}.target`),
      whenRef,
      ref('args.max_monthly'),
      ...(snapshot.plan_projection === undefined
        ? []
        : [ref('plan_projection.assumptions_version')]),
    ];
    return ok(inputs, {
      goal_ref: args.goal_ref,
      name: goal.name,
      kind: solved.kind,
      monthly: solved.kind === 'unreachable' ? null : moneyFigure(solved.monthly, refs),
      target: moneyFigure(goal.target, [ref(`${base}.target`)]),
      target_date:
        args.target_date === undefined
          ? null
          : dateFigure(args.target_date, [ref('args.target_date')]),
      horizon_months:
        args.target_date === undefined
          ? decimalFigure(String(goal.horizon_months), 'months', [ref(`${base}.horizon_months`)])
          : null,
      planned_monthly:
        goal.pace === undefined
          ? null
          : moneyFigure(goal.pace.planned_monthly, [ref(`${base}.pace.planned_monthly`)]),
      constraint:
        solved.kind !== 'unreachable'
          ? null
          : solved.constraint.name === 'no_contribution_window'
            ? {
                name: 'no_contribution_window' as const,
                detail: solved.constraint.detail,
                contributions_end_age: decimalFigure(
                  String(solved.constraint.contributionsEndAge),
                  'age',
                  refs,
                ),
                ceiling: null,
                gap_at_ceiling: null,
              }
            : {
                name: 'monthly_ceiling' as const,
                detail: solved.constraint.detail,
                contributions_end_age: null,
                ceiling: moneyFigure(solved.constraint.ceiling, [ref('args.max_monthly')]),
                gap_at_ceiling: moneyFigure(solved.constraint.gapAtCeiling, refs),
              },
    });
  },
});

// ---------------------------------------------------------------------------
// retirement.claiming / retirement.guardrail / retirement.rmd_window
// ---------------------------------------------------------------------------

export const retirementClaiming = defineFunction({
  name: 'retirement.claiming',
  summary:
    'The Social Security benefit multiplier at each claiming age asked, beside the plan’s own.',
  description:
    'The statutory claim factor (early reduction before full retirement age, delayed credits to ' +
    '70) at each age, from the projection engine over the holder’s own plan, and the change ' +
    'against the factor at the plan’s claiming age. A multiplier, never a benefit amount: no ' +
    'benefit figure crosses the plan.projection scope. Ages 62 to 70.',
  backing:
    'R4 (builtin.retirement.claiming_age) and the engine’s Social Security module ' +
    '(engine/social-security.ts), the computation createInsightsPlanningPort runs for the snapshot',
  scopes: ['plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({
    ages: z.array(z.int().min(62).max(70)).min(1).max(9),
  }),
  result: z.strictObject({
    planned_claim_age: DecimalFigureSchema,
    planned_factor: DecimalFigureSchema,
    ages: z.array(
      z.strictObject({
        age: DecimalFigureSchema,
        factor: DecimalFigureSchema,
        change_vs_planned: DecimalFigureSchema,
      }),
    ),
    findings: z.array(FindingSchema),
  }),
  async run(context, args, scopes) {
    const ages = [...new Set(args.ages)].sort((a, b) => a - b);
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: { ages } };
    if (snapshot.plan_projection?.social_security === undefined) {
      return notAvailable(
        inputs,
        'no_social_security',
        'The plan has no Social Security, or no baseline projection has run.',
      );
    }
    const factors = await context.ports.planning.claimFactors({ userId: context.userId, ages });
    if (factors.status === 'not_available') {
      return notAvailable(inputs, factors.code, factors.reason);
    }
    inputs['claiming'] = {
      engine: 'projectDeterministic (engine/social-security.ts)',
      planned_claim_age: factors.plannedClaimAge,
      planned_factor: factors.plannedFactor,
      factors: factors.factors.map((row) => ({ age: row.age, factor: row.factor })),
    };
    const assumptionsRef = ref('plan_projection.assumptions_version');
    const plannedRefs = [
      ref('claiming.planned_factor'),
      ref('plan_projection.social_security.claim_factor'),
    ];
    const planned = parseDecimalOrThrow(factors.plannedFactor);
    return ok(inputs, {
      planned_claim_age: decimalFigure(String(factors.plannedClaimAge.years), 'age', [
        ref('plan_projection.social_security.claim_age_years'),
      ]),
      planned_factor: decimalFigure(factors.plannedFactor, 'factor', plannedRefs),
      ages: factors.factors.map((row, index) => {
        const factorRefs = [
          ref(`claiming.factors[${String(index)}].factor`),
          ref(`args.ages[${String(ages.indexOf(row.age))}]`),
          assumptionsRef,
        ];
        const quotient = decimal.divide(parseDecimalOrThrow(row.factor), planned);
        const change = quotient === null ? null : decimal.subtract(quotient, 1_000_000n);
        return {
          age: decimalFigure(String(row.age), 'age', [
            ref(`args.ages[${String(ages.indexOf(row.age))}]`),
          ]),
          factor: decimalFigure(row.factor, 'factor', factorRefs),
          change_vs_planned: decimalFigure(
            change === null ? '0' : decimalText(change, 4),
            'ratio',
            [...factorRefs, ...plannedRefs],
          ),
        };
      }),
      findings: findingsOf(['R4'], snapshot, context),
    });
  },
});

export const retirementGuardrail = defineFunction({
  name: 'retirement.guardrail',
  summary: 'This year’s withdrawal rate against the Guyton-Klinger band around the reference rate.',
  description:
    'In retirement, the portfolio withdrawal rate ((spending − income) ÷ portfolio) for the plan’s ' +
    'first year, the band drawn around 07 §5.6’s reference rate, and where the rate sits. Not ' +
    'available before retirement or when income covers spending.',
  backing: 'R7 (builtin.retirement.withdrawal_guardrail) over plan.projection’s guardrail block',
  scopes: ['plan.projection'],
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    withdrawal_rate: DecimalFigureSchema,
    reference_rate: DecimalFigureSchema,
    lower: DecimalFigureSchema,
    upper: DecimalFigureSchema,
    position: z.enum(['below', 'within', 'above']),
    stale: z.boolean(),
    findings: z.array(FindingSchema),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    const projection = snapshot.plan_projection;
    if (projection?.guardrail === undefined) {
      return notAvailable(
        inputs,
        'not_in_decumulation',
        'No guardrail applies: the plan is not yet in retirement, its income covers its spending, ' +
          'or no baseline projection has run.',
      );
    }
    const field = (name: string) => ref(`plan_projection.guardrail.${name}`);
    const guardrail = projection.guardrail;
    return ok(inputs, {
      withdrawal_rate: decimalFigure(guardrail.withdrawal_rate, 'ratio', [
        field('withdrawal_rate'),
      ]),
      reference_rate: decimalFigure(guardrail.reference_rate, 'ratio', [field('reference_rate')]),
      lower: decimalFigure(guardrail.lower, 'ratio', [field('lower')]),
      upper: decimalFigure(guardrail.upper, 'ratio', [field('upper')]),
      position: guardrail.position,
      stale: projection.stale,
      findings: findingsOf(['R7'], snapshot, context),
    });
  },
});

export const retirementRmdWindow = defineFunction({
  name: 'retirement.rmd_window',
  summary:
    'When required minimum distributions start, the years until then, and the years between ' +
    'retirement and that start.',
  description:
    'SECURE 2.0’s start age for the holder’s birth year (from the parameter store, through the ' +
    'snapshot), the start year, the years until it and the years between retiring (or today, ' +
    'if later) and that start — the span R3 calls the widest Roth-conversion window — and the ' +
    'tax-deferred share of what the plan starts from. Not available when the store does not ' +
    'cover the birth year.',
  backing: 'R3 (builtin.retirement.rmd_window) over plan.projection’s rmd and ages blocks',
  scopes: scopesOfRules(['R3']),
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    start_age: DecimalFigureSchema,
    start_year: DecimalFigureSchema,
    current_age: DecimalFigureSchema,
    retirement_age: DecimalFigureSchema,
    years_until_start: DecimalFigureSchema,
    window_years: DecimalFigureSchema,
    tax_deferred_share: DecimalFigureSchema,
    findings: z.array(FindingSchema),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    const projection = snapshot.plan_projection;
    if (projection?.rmd === undefined) {
      return notAvailable(
        inputs,
        'no_rmd_schedule',
        'No RMD start age is known: no baseline projection has run, or the parameter store does ' +
          'not cover the birth year.',
      );
    }
    const { rmd, ages } = projection;
    const startRef = ref('plan_projection.rmd.start_age');
    const currentRef = ref('plan_projection.ages.current');
    const retirementRef = ref('plan_projection.ages.retirement');
    const untilStart = Math.max(0, rmd.start_age - ages.current);
    const window = Math.max(0, rmd.start_age - Math.max(ages.retirement, ages.current));
    return ok(inputs, {
      start_age: decimalFigure(String(rmd.start_age), 'age', [startRef]),
      start_year: decimalFigure(String(rmd.start_year), 'year', [
        ref('plan_projection.rmd.start_year'),
      ]),
      current_age: decimalFigure(String(ages.current), 'age', [currentRef]),
      retirement_age: decimalFigure(String(ages.retirement), 'age', [retirementRef]),
      years_until_start: decimalFigure(String(untilStart), 'years', [startRef, currentRef]),
      window_years: decimalFigure(String(window), 'years', [startRef, currentRef, retirementRef]),
      tax_deferred_share: decimalFigure(rmd.tax_deferred_share, 'ratio', [
        ref('plan_projection.rmd.tax_deferred_share'),
      ]),
      findings: findingsOf(['R3'], snapshot, context),
    });
  },
});
