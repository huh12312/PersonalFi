// SPDX-License-Identifier: MIT
/**
 * The plan's figures for the advisor's catalogue (WP 11.5b; 12 §2.1's
 * `plan.project`, `plan.compare` and `plan.levers`).
 *
 * ## Read, compute, never store
 *
 * `runProjection` and `compareScenarios` serve a stored run or compute and
 * **store** one, announcing `planning.ProjectionCompleted` (which the goal-pace
 * consumer reacts to). That is right for the plan screen, where the holder
 * asked for a run. The catalogue is called by a compiler on the holder's
 * question, and a question must not write: so these functions run the same
 * three phases minus the third. `prepareProjection` reads and looks the answer
 * up — a stored run with the same cache key *is* the answer, because the key is
 * `sha256(assumptions + engine + seed + input)` — and when there is none,
 * `computeProjection` runs the engine. Nothing is inserted and nothing is
 * announced. Two calls over the same rows therefore return the same figures,
 * whichever of the two served them.
 *
 * ## The tornado (07 §5.10)
 *
 * `leverSensitivity` re-runs the baseline once per lever step under **common
 * random numbers** — the baseline's own seed for every run, so each delta is
 * the lever's effect and not Monte Carlo noise — at the path count the compare
 * already uses (`DEFAULT_MONTE_CARLO_PATHS` when a Monte Carlo engine is bound,
 * the one deterministic path otherwise). The steps are declared in
 * `leverStepsFor`, one per lever the plan model holds (`ScenarioLevers`); no
 * plan field is added. It is bounded three ways: one run per step (eight
 * levers, at most seven runs plus the base), the path count above, and a
 * deadline read through the injected clock before each run — a lever not
 * reached by then is reported `skipped` with reason `deadline`, never dropped.
 * The worst case is therefore the deadline plus one run.
 */
import {
  DateOnly,
  Money,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import {
  UnknownAssumptionsVersion,
  computableVersions,
  currentRegistry,
  isRetainedVersion,
  resolveForUser,
  type AssumptionsRegistry,
  type ResolvedAssumptions,
} from './assumptions.ts';
import type { ProjectionPlan } from './engine/boundary.ts';
import { ENGINE_VERSION } from './engine/deterministic.ts';
import { listLifeEvents, type LifeEvent } from './life-events.ts';
import {
  DEFAULT_MONTE_CARLO_PATHS,
  assembleBaselinePlan,
  assembleInput,
  computeProjection,
  overridesOf,
  prepareProjection,
  retiredStaleness,
  type DerivedInputs,
  type PreparedProjection,
  type ProjectionServiceDependencies,
  type Staleness,
} from './projection-service.ts';
import { ProjectionRefused, type StoredPercentile } from './projection-store.ts';
import {
  getBaseline,
  leversToJson,
  type BaselineScenario,
  type ForkScenario,
  type ScenarioLevers,
  type ScenarioLeversJson,
} from './scenarios.ts';
import type { PlanningExecutor } from './store.ts';
import type { ProjectionMethod } from '../schema/projections.ts';

// ---------------------------------------------------------------------------
// Exact probabilities: six places, as NUMERIC(7,6) stores them
// ---------------------------------------------------------------------------

const MICROS = 1_000_000n;

/** `'0.713'`, `'1'`, `'1.000000'` → micro-units. Throws on anything that is not a plain decimal. */
function probabilityMicros(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) throw new Error(`not a probability: ${JSON.stringify(text)}`);
  const [, sign = '', whole = '0', fraction = ''] = match;
  const magnitude = BigInt(whole) * MICROS + BigInt(fraction.padEnd(6, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** Micro-units → a signed six-place decimal string (`'-0.040000'`). */
function sixPlaces(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const text = `${(magnitude / MICROS).toString()}.${(magnitude % MICROS).toString().padStart(6, '0')}`;
  return negative ? `-${text}` : text;
}

/** A probability as six places, whatever form the engine or the store gave it in. */
export function canonicalProbability(text: string): string {
  return sixPlaces(probabilityMicros(text));
}

/** `b − a`, exactly, as six places. */
export function probabilityDelta(a: string, b: string): string {
  return sixPlaces(probabilityMicros(b) - probabilityMicros(a));
}

// ---------------------------------------------------------------------------
// One scenario's figures
// ---------------------------------------------------------------------------

/** One year of the band. `p5`/`p95` are `null` for a deterministic run (one path, no band). */
export interface ProjectionYearFigures {
  readonly age: number;
  readonly calendarYear: number;
  readonly p5: MoneyType | null;
  readonly p50: MoneyType;
  readonly p95: MoneyType | null;
}

/** What a served projection says, with the identity that reproduces it. */
export interface ScenarioFigures {
  readonly status: 'served';
  readonly scenarioId: string;
  readonly scenarioKind: 'baseline' | 'fork';
  readonly method: ProjectionMethod;
  readonly paths: number;
  readonly seed: bigint;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly inputDigest: string;
  readonly asOfDate: DateOnlyType;
  readonly balancesSealed: boolean;
  readonly retirementAge: number;
  readonly retirementDate: DateOnlyType;
  readonly planEndAge: number;
  /** Six places. A deterministic run is `1.000000` or `0.000000` and is not a probability. */
  readonly successProbability: string;
  /** The median path: p50 per year, with the p5/p95 band beside it. */
  readonly years: readonly ProjectionYearFigures[];
}

export type ScenarioFiguresOutcome =
  | ScenarioFigures
  | { readonly status: 'stale'; readonly scenarioId: string; readonly staleness: Staleness };

function planFieldOf(document: Readonly<Record<string, unknown>>, field: string): string {
  const plan = document['plan'];
  if (plan === null || typeof plan !== 'object') throw new Error('a run document with no plan');
  const value = (plan as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new Error(`a run document's plan has no ${field}`);
  return value;
}

function yearsOf(percentiles: readonly StoredPercentile[]): ProjectionYearFigures[] {
  return [...percentiles]
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      age: row.age,
      calendarYear: row.calendarYear,
      p5: row.p5,
      p50: row.p50,
      p95: row.p95,
    }));
}

function figuresOf(input: {
  readonly scenarioId: string;
  readonly scenarioKind: 'baseline' | 'fork';
  readonly method: ProjectionMethod;
  readonly paths: number;
  readonly seed: bigint;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly inputDigest: string;
  readonly asOfDate: DateOnlyType;
  readonly balancesSealed: boolean;
  readonly document: Readonly<Record<string, unknown>>;
  readonly successProbability: string;
  readonly percentiles: readonly StoredPercentile[];
}): ScenarioFigures {
  const retirementAge = Number.parseInt(planFieldOf(input.document, 'retirementAge'), 10);
  const birthDate = DateOnly.parse(planFieldOf(input.document, 'birthDate'));
  return Object.freeze({
    status: 'served',
    scenarioId: input.scenarioId,
    scenarioKind: input.scenarioKind,
    method: input.method,
    paths: input.paths,
    seed: input.seed,
    engineVersion: input.engineVersion,
    assumptionsVersion: input.assumptionsVersion,
    inputDigest: input.inputDigest,
    asOfDate: input.asOfDate,
    balancesSealed: input.balancesSealed,
    retirementAge,
    retirementDate: DateOnly.addYears(birthDate, retirementAge),
    planEndAge: Number.parseInt(planFieldOf(input.document, 'planEndAge'), 10),
    successProbability: canonicalProbability(input.successProbability),
    years: yearsOf(input.percentiles),
  });
}

/**
 * One scenario's projection, served from the store when the cache holds the
 * answer and computed (not stored) when it does not. A scenario whose
 * assumptions no longer resolve, or whose account overrides changed since its
 * newest run, answers `stale` and computes nothing — exactly as the plan
 * screen's route would.
 */
export async function projectScenarioFigures(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: {
    readonly userId: string;
    readonly scenarioId: string;
    readonly method: ProjectionMethod;
    readonly paths?: number;
    readonly correlationId: string;
  },
): Promise<ScenarioFiguresOutcome> {
  const prepared = await prepareProjection(executor, dependencies, request);
  if (prepared.status === 'stale') {
    return { status: 'stale', scenarioId: request.scenarioId, staleness: prepared.staleness };
  }
  if (prepared.status === 'cached' || prepared.status === 'computed') {
    const run = prepared.run;
    return figuresOf({
      scenarioId: run.scenarioId,
      scenarioKind: run.scenarioKind,
      method: run.method,
      paths: run.paths,
      seed: run.seed,
      engineVersion: run.engineVersion,
      assumptionsVersion: run.assumptionsVersion,
      inputDigest: run.inputDigest,
      asOfDate: run.asOfDate,
      balancesSealed: run.balancesSealed,
      document: run.input,
      successProbability: run.successProbability,
      percentiles: prepared.percentiles,
    });
  }
  const computed = await computeProjection(dependencies, prepared);
  return figuresOf({
    scenarioId: prepared.scenario.id,
    scenarioKind: prepared.scenario.kind,
    method: prepared.method,
    paths: prepared.paths,
    seed: prepared.seed,
    engineVersion: prepared.engineVersion,
    assumptionsVersion: prepared.resolved.version,
    inputDigest: prepared.assembled.digest,
    asOfDate: prepared.derived.balances.asOfDate,
    balancesSealed: prepared.derived.balances.sealed,
    document: prepared.assembled.document,
    successProbability: computed.successProbability,
    percentiles: computed.percentiles,
  });
}

export interface ScenarioComparisonFigures {
  readonly status: 'served';
  readonly a: ScenarioFigures;
  readonly b: ScenarioFigures;
  /** The one seed both runs used. */
  readonly seed: bigint;
  /** b − a, six places. */
  readonly successProbabilityDelta: string;
  /** b − a in whole months: positive means b retires later. */
  readonly retirementDeltaMonths: number;
}

/**
 * Two scenarios under common random numbers — the baseline's seed for both,
 * asserted — and the two deltas `/plan/compare` leads with. Read-only, like
 * `projectScenarioFigures`.
 */
export async function compareScenarioFigures(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: {
    readonly userId: string;
    readonly scenarioA: string;
    readonly scenarioB: string;
    readonly method: ProjectionMethod;
    readonly paths?: number;
    readonly correlationId: string;
  },
): Promise<
  | ScenarioComparisonFigures
  | { readonly status: 'stale'; readonly scenarioId: string; readonly staleness: Staleness }
> {
  const shared = {
    userId: request.userId,
    method: request.method,
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    correlationId: request.correlationId,
  };
  const a = await projectScenarioFigures(executor, dependencies, {
    ...shared,
    scenarioId: request.scenarioA,
  });
  if (a.status === 'stale') return a;
  const b = await projectScenarioFigures(executor, dependencies, {
    ...shared,
    scenarioId: request.scenarioB,
  });
  if (b.status === 'stale') return b;
  if (a.seed !== b.seed) {
    throw new Error(`common random numbers violated: ${a.seed.toString()} ≠ ${b.seed.toString()}`);
  }
  const months =
    (DateOnly.year(b.retirementDate) - DateOnly.year(a.retirementDate)) * 12 +
    (DateOnly.month(b.retirementDate) - DateOnly.month(a.retirementDate));
  return Object.freeze({
    status: 'served',
    a,
    b,
    seed: a.seed,
    successProbabilityDelta: probabilityDelta(a.successProbability, b.successProbability),
    retirementDeltaMonths: months,
  });
}

// ---------------------------------------------------------------------------
// The tornado
// ---------------------------------------------------------------------------

/** 07 §5.10's eight levers, in its order — the `ScenarioLevers` the plan model holds. */
export const TORNADO_LEVERS = [
  'retire_age',
  'savings_rate',
  'annual_spending',
  'expected_return_shift',
  'ss_claim_age',
  'part_time_income',
  'one_time_windfall',
  'glidepath',
] as const;
export type TornadoLever = (typeof TORNADO_LEVERS)[number];

/** The wall-clock budget for one tornado, read through the injected clock before each run. */
export const LEVER_SENSITIVITY_DEADLINE_MS = 20_000;

/** The declared steps: what each lever is moved by, and nothing a caller chooses. */
export const LEVER_STEP_DECLARATIONS: Readonly<Record<TornadoLever, string>> = Object.freeze({
  retire_age: 'retire one year later',
  savings_rate: 'save 2% more of income each year',
  annual_spending: 'spend 10% less a year in retirement',
  expected_return_shift: 'returns one percentage point lower than assumed',
  ss_claim_age: 'claim Social Security one year later (never past 70)',
  part_time_income: '$10,000 a year of part-time income for three years from retirement',
  one_time_windfall: 'a $10,000 one-time inflow on the plan’s first day',
  glidepath: 'not moved: a glidepath is a choice between schedules, not a magnitude',
});

const SAVINGS_RATE_STEP = '0.02';
const SPENDING_FACTOR = '0.9';
const RETURN_SHIFT_STEP_MICROS = -10_000n; // −0.01
const PART_TIME_ANNUAL_MINOR = 1_000_000n; // $10,000.00
const PART_TIME_YEARS = 3;
const WINDFALL_MINOR = 1_000_000n; // $10,000.00
const LATEST_CLAIM_AGE = 70;

export type LeverSkipReason = 'not_applicable' | 'refused' | 'deadline' | 'not_a_magnitude';

export interface LeverStep {
  readonly lever: TornadoLever;
  readonly step: string;
  readonly levers: ScenarioLevers | null;
  readonly skip: { readonly reason: LeverSkipReason; readonly detail: string } | null;
}

/** The step for each lever, from the baseline's own plan. Pure. */
export function leverStepsFor(plan: ProjectionPlan, derived: DerivedInputs): readonly LeverStep[] {
  const step = (lever: TornadoLever, levers: ScenarioLevers): LeverStep => ({
    lever,
    step: LEVER_STEP_DECLARATIONS[lever],
    levers,
    skip: null,
  });
  const skip = (lever: TornadoLever, reason: LeverSkipReason, detail: string): LeverStep => ({
    lever,
    step: LEVER_STEP_DECLARATIONS[lever],
    levers: null,
    skip: { reason, detail },
  });
  const out: LeverStep[] = [];

  out.push(
    plan.retirementAge + 1 < plan.planEndAge
      ? step('retire_age', { retireAge: plan.retirementAge + 1 })
      : skip('retire_age', 'not_applicable', 'one more working year reaches the plan’s end'),
  );
  out.push(
    derived.annualIncome === null
      ? skip('savings_rate', 'not_applicable', 'no income could be derived to take a share of')
      : step('savings_rate', { savingsRate: SAVINGS_RATE_STEP }),
  );
  out.push(
    Money.isPositive(plan.annualSpending)
      ? step('annual_spending', {
          annualSpending: Money.multiplyByDecimal(plan.annualSpending, SPENDING_FACTOR),
        })
      : skip('annual_spending', 'not_applicable', 'the plan spends nothing in retirement'),
  );
  out.push(
    step('expected_return_shift', {
      expectedReturnShift: decimalOfMicros(
        probabilityMicros(plan.returnShift ?? '0') + RETURN_SHIFT_STEP_MICROS,
      ),
    }),
  );
  const social = plan.socialSecurity;
  if (social === null) {
    out.push(skip('ss_claim_age', 'not_applicable', 'the plan has no Social Security'));
  } else if (social.claimAge.years >= LATEST_CLAIM_AGE) {
    out.push(skip('ss_claim_age', 'not_applicable', 'the plan already claims at 70'));
  } else {
    const years = social.claimAge.years + 1;
    out.push(
      step('ss_claim_age', {
        ssClaimAge:
          years >= LATEST_CLAIM_AGE
            ? { years: LATEST_CLAIM_AGE, months: 0 }
            : { years, months: social.claimAge.months },
      }),
    );
  }
  out.push(
    step('part_time_income', {
      partTimeIncome: {
        annual: Money.of(PART_TIME_ANNUAL_MINOR, plan.currency),
        years: PART_TIME_YEARS,
      },
    }),
  );
  out.push(
    step('one_time_windfall', {
      oneTimeWindfall: { amount: Money.of(WINDFALL_MINOR, plan.currency), on: plan.asOf },
    }),
  );
  out.push(
    skip(
      'glidepath',
      'not_a_magnitude',
      'a glidepath is a choice between schedules; there is no one step to take',
    ),
  );
  return out;
}

/** Micro-units as a canonical decimal (`-0.01`, `0`), the form `leversToJson` accepts. */
function decimalOfMicros(micros: bigint): string {
  const text = sixPlaces(micros).replace(/0+$/u, '').replace(/\.$/u, '');
  return text === '-0' ? '0' : text;
}

export type LeverOutcome =
  | {
      readonly lever: TornadoLever;
      readonly step: string;
      readonly status: 'computed';
      readonly levers: ScenarioLeversJson;
      readonly successProbability: string;
      /** This run − the base run, six places: ∂success for one declared step. */
      readonly delta: string;
    }
  | {
      readonly lever: TornadoLever;
      readonly step: string;
      readonly status: 'skipped';
      readonly reason: LeverSkipReason;
      readonly detail: string;
    };

export interface LeverSensitivity {
  readonly status: 'served';
  readonly method: ProjectionMethod;
  readonly paths: number;
  readonly seed: bigint;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  /** The baseline run's input digest: the base the deltas are measured from. */
  readonly inputDigest: string;
  readonly asOfDate: DateOnlyType;
  readonly deadlineMs: number;
  readonly base: { readonly successProbability: string };
  /** Computed levers by |delta|, largest first (declared order on a tie), then the skipped. */
  readonly levers: readonly LeverOutcome[];
}

export type LeverSensitivityOutcome =
  | LeverSensitivity
  | { readonly status: 'no_baseline' }
  | { readonly status: 'stale'; readonly staleness: Staleness };

/** Everything the tornado's runs share: read once, then pure. */
export interface SensitivityBase {
  readonly userId: string;
  readonly baseline: BaselineScenario;
  readonly derived: DerivedInputs;
  readonly lifeEvents: readonly LifeEvent[];
  readonly resolved: ResolvedAssumptions;
  readonly method: ProjectionMethod;
  readonly paths: number;
  readonly engineVersion: string;
  readonly correlationId: string;
}

function preparedFor(
  base: SensitivityBase,
  scenario: BaselineScenario | ForkScenario,
): PreparedProjection {
  const assembled = assembleInput({
    scenario,
    baseline: base.baseline,
    derived: base.derived,
    lifeEvents: base.lifeEvents,
    method: base.method,
    paths: base.paths,
  });
  return Object.freeze({
    status: 'ready',
    userId: base.userId,
    scenario,
    method: base.method,
    resolved: base.resolved,
    assumptionsOverrides: overridesOf(base.resolved),
    engineVersion: base.engineVersion,
    paths: base.paths,
    seed: base.baseline.seed,
    derived: base.derived,
    assembled,
    // Never looked up and never stored: the tornado writes nothing.
    cacheKey: '',
    correlationId: base.correlationId,
    causationId: null,
  });
}

function forkOf(base: SensitivityBase, lever: TornadoLever, levers: ScenarioLevers): ForkScenario {
  return Object.freeze({
    kind: 'fork',
    id: `${base.baseline.id}:lever:${lever}`,
    baselineId: base.baseline.id,
    name: `lever:${lever}`,
    levers,
    createdAt: base.baseline.createdAt,
    updatedAt: base.baseline.updatedAt,
  });
}

/**
 * The tornado over an already-read base. Pure apart from the engine and the
 * clock, so a unit test can drive it with the deterministic engine and a
 * clock it advances.
 */
export async function sensitivityOver(
  base: SensitivityBase,
  dependencies: Pick<ProjectionServiceDependencies, 'monteCarlo' | 'clock' | 'deterministic'>,
  options: { readonly deadlineMs?: number } = {},
): Promise<LeverSensitivity> {
  const deadlineMs = options.deadlineMs ?? LEVER_SENSITIVITY_DEADLINE_MS;
  const clock: Clock = dependencies.clock;
  const started = clock.now().getTime();
  const basePrepared = preparedFor(base, base.baseline);
  const baseRun = await computeProjection(dependencies, basePrepared);
  const baseProbability = canonicalProbability(baseRun.successProbability);

  const computed: (LeverOutcome & { readonly status: 'computed'; readonly order: number })[] = [];
  const skipped: LeverOutcome[] = [];
  const steps = leverStepsFor(basePrepared.assembled.plan, base.derived);
  for (const [order, entry] of steps.entries()) {
    if (entry.levers === null) {
      skipped.push({
        lever: entry.lever,
        step: entry.step,
        status: 'skipped',
        reason: entry.skip?.reason ?? 'not_applicable',
        detail: entry.skip?.detail ?? '',
      });
      continue;
    }
    if (clock.now().getTime() - started >= deadlineMs) {
      skipped.push({
        lever: entry.lever,
        step: entry.step,
        status: 'skipped',
        reason: 'deadline',
        detail: `not reached within the ${String(deadlineMs)} ms deadline`,
      });
      continue;
    }
    let run;
    try {
      run = await computeProjection(
        dependencies,
        preparedFor(base, forkOf(base, entry.lever, entry.levers)),
      );
    } catch (error) {
      if (!(error instanceof ProjectionRefused)) throw error;
      skipped.push({
        lever: entry.lever,
        step: entry.step,
        status: 'skipped',
        reason: 'refused',
        detail: error.message,
      });
      continue;
    }
    const probability = canonicalProbability(run.successProbability);
    computed.push({
      lever: entry.lever,
      step: entry.step,
      status: 'computed',
      levers: leversToJson(entry.levers),
      successProbability: probability,
      delta: probabilityDelta(baseProbability, probability),
      order,
    });
  }
  const magnitude = (delta: string): bigint => {
    const micros = probabilityMicros(delta);
    return micros < 0n ? -micros : micros;
  };
  computed.sort((a, b) => {
    const left = magnitude(a.delta);
    const right = magnitude(b.delta);
    if (left !== right) return left > right ? -1 : 1;
    return a.order - b.order;
  });
  return Object.freeze({
    status: 'served',
    method: base.method,
    paths: base.paths,
    seed: base.baseline.seed,
    engineVersion: base.engineVersion,
    assumptionsVersion: base.resolved.version,
    inputDigest: basePrepared.assembled.digest,
    asOfDate: base.derived.balances.asOfDate,
    deadlineMs,
    base: { successProbability: baseProbability },
    levers: [...computed.map(({ order: _order, ...outcome }) => outcome), ...skipped],
  });
}

/** `retiredStaleness`, total: the label a version no new run may be computed on reads back with. */
function staleFor(version: string, registry: AssumptionsRegistry): Staleness {
  return (
    retiredStaleness(version, registry) ?? {
      reason: 'assumptions_version_retired',
      assumptionsVersion: version,
      known: computableVersions(registry),
    }
  );
}

/**
 * The baseline's tornado for one holder: read the base (the baseline, its
 * resolved assumptions, the derived inputs from the newest sealed day and the
 * life events), then `sensitivityOver`. A holder with no baseline, or whose
 * assumptions no longer resolve, gets that answer and nothing is computed.
 */
export async function leverSensitivity(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: {
    readonly userId: string;
    readonly correlationId: string;
    readonly deadlineMs?: number;
  },
): Promise<LeverSensitivityOutcome> {
  const baseline = await getBaseline(executor, request.userId);
  if (baseline === null) return { status: 'no_baseline' };
  const registry = dependencies.registry ?? currentRegistry();
  let resolved: ResolvedAssumptions;
  try {
    resolved = await resolveForUser(
      executor,
      { userId: request.userId, timeZone: dependencies.timeZone },
      registry,
    );
  } catch (error) {
    if (!(error instanceof UnknownAssumptionsVersion)) throw error;
    return { status: 'stale', staleness: staleFor(error.requested, registry) };
  }
  if (isRetainedVersion(registry, resolved.version)) {
    return { status: 'stale', staleness: staleFor(resolved.version, registry) };
  }
  const method: ProjectionMethod =
    dependencies.monteCarlo === null ? 'deterministic' : 'monte_carlo';
  const derived = await dependencies.inputs.derivedInputs({
    userId: request.userId,
    asOf: null,
    allowOpenDay: false,
  });
  // `assembleBaselinePlan` refuses a plan with no spending figure; the tornado
  // refuses with it rather than inventing one.
  assembleBaselinePlan(baseline.profile, derived);
  return sensitivityOver(
    {
      userId: request.userId,
      baseline,
      derived,
      lifeEvents: await listLifeEvents(executor, request.userId),
      resolved,
      method,
      paths: method === 'deterministic' ? 1 : DEFAULT_MONTE_CARLO_PATHS,
      engineVersion:
        dependencies.monteCarlo === null ? ENGINE_VERSION : dependencies.monteCarlo.engineVersion,
      correlationId: request.correlationId,
    },
    dependencies,
    request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs },
  );
}
