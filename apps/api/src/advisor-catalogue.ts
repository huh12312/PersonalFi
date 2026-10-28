// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue, bound (WP 11.5b; 12 §2.1).
 *
 * `@ctx/insights` owns the catalogue — its definitions, its gate (the
 * holder's live narrator grant, the same function `insight.explain` and
 * `brief.narrate` read), its result check and its description — and declares
 * what it reads from other contexts as ports in its own vocabulary. This file
 * is the composition root's half, the 11.5a `ParameterPort` precedent:
 *
 *   * **snapshot**: the same `SnapshotPorts` the insights routes and the
 *     nightly run bind (`domain.ts`' `createInsights*Port`);
 *   * **parameters**: WP 4.2's store through `createKnowledgeParameterPort`
 *     (11.5a) — a tax year the store does not hold answers `year_unavailable`;
 *   * **planning**: the projection service read-only
 *     (`projectScenarioFigures`, `compareScenarioFigures`, `leverSensitivity`),
 *     the required-savings solve the plan route runs (`required-savings.ts`),
 *     and the engine's Social Security claim factor — the computation
 *     `createInsightsPlanningPort` runs for the snapshot's R4 block;
 *   * **contributions**: `investment_transactions`, classified by
 *     `classifyActivity` (WP 10.3), into accounts of the asked kind;
 *   * **livingExpenses**: WP 10.12's port.
 *
 * Nothing here writes. A planning refusal of the *call* (an unknown scenario)
 * becomes a `CatalogueRefusal`; a refusal of the *data* (no baseline, no
 * sealed day, stale assumptions) becomes a `not_available` answer.
 */
import type { Database } from '@core/db';
import { DateOnly, Money, Quantity, currency as toCurrency, type Clock } from '@core/kernel';
import {
  CatalogueRefusal,
  type CatalogueContributionsPort,
  type CataloguePlanningPort,
  type CatalogueRuntimeDependencies,
  type ContributionAccountKind,
  type PortNotAvailable,
  type PortProjection,
} from '@ctx/insights';
import { classifyActivity } from '@ctx/investments';
import {
  ProjectionRefused,
  assembleBaselinePlan,
  compareScenarioFigures,
  createProjectionInputsReader,
  currentRegistry,
  getBaseline,
  isAssumptionsRefusal,
  isPlanningError,
  isProjectionInputRefused,
  leverSensitivity,
  listGoals,
  projectDeterministic,
  projectScenarioFigures,
  resolveForUser,
  type MonteCarloRunner,
  type ProjectionServiceDependencies,
  type ScenarioFigures,
  type Staleness,
} from '@ctx/planning';
import { sql } from 'drizzle-orm';
import {
  createInsightsBudgetPort,
  createInsightsCategorizationPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
  planningRevealedPortsFor,
} from './domain.ts';
import { createKnowledgeParameterPort } from './knowledge-base.ts';
import { createLivingExpensesPort } from './reports/living-expenses.ts';
import { solveRequiredSavingsFor } from './required-savings.ts';

export interface AdvisorCatalogueOptions {
  readonly database: Database;
  readonly clock: Clock;
  /** The holder's IANA zone. */
  readonly timeZone: string;
  /** `RouteDeps.monteCarlo`: the projection engine this process has, or `null` (deterministic). */
  readonly monteCarlo: MonteCarloRunner | null;
  /** `config.secrets.advisor_token_secret`, revealed. */
  readonly tokenSecret: string;
  /** No currency config key yet (wp2.6-insights.md §6 open item 3): USD, as everywhere else. */
  readonly baseCurrency?: string;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function notAvailable(code: string, reason: string): PortNotAvailable {
  return { status: 'not_available', code, reason };
}

function staleReason(staleness: Staleness): PortNotAvailable {
  switch (staleness.reason) {
    case 'assumptions_version_retired':
      return notAvailable(
        'projection_stale',
        'The plan’s assumptions are a version this build no longer computes on; re-save them on the Plan screen.',
      );
    case 'assumptions_changed':
      return notAvailable(
        'projection_stale',
        'The plan’s assumptions changed since its newest run.',
      );
    case 'account_overrides_changed':
      return notAvailable(
        'projection_stale',
        'Account settings changed since the newest run; open the plan to accept them and run it again.',
      );
  }
}

/**
 * Planning's refusals: an unknown scenario or goal refuses the call; anything
 * else Planning refuses (no baseline, no sealed day, no spending figure, an
 * input the engine will not compute on, a tax year the store lacks) is a
 * data-level `not_available`, named by its own code.
 */
async function mapped<T>(work: () => Promise<T | PortNotAvailable>): Promise<T | PortNotAvailable> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProjectionRefused) {
      if (error.code === 'planning.scenario_not_found') {
        throw new CatalogueRefusal('catalogue.scenario_unknown', 404, error.message);
      }
      return notAvailable(error.code.replace(/^planning\./u, ''), error.message);
    }
    if (isPlanningError(error)) {
      if (error.code === 'planning.goal_not_found') {
        throw new CatalogueRefusal('catalogue.goal_unknown', 404, error.message);
      }
      return notAvailable(error.code.replace(/^planning\./u, ''), error.message);
    }
    if (isProjectionInputRefused(error)) {
      return notAvailable(error.code.replace(/^planning\./u, ''), error.message);
    }
    if (isAssumptionsRefusal(error)) {
      return notAvailable('assumptions_unavailable', error.message);
    }
    throw error;
  }
}

function portProjection(figures: ScenarioFigures): PortProjection {
  return {
    status: 'served',
    scenarioKind: figures.scenarioKind,
    method: figures.method,
    paths: figures.paths,
    seed: figures.seed.toString(),
    engineVersion: figures.engineVersion,
    assumptionsVersion: figures.assumptionsVersion,
    inputDigest: figures.inputDigest,
    asOfYear: DateOnly.year(figures.asOfDate),
    balancesSealed: figures.balancesSealed,
    retirementAge: figures.retirementAge,
    retirementYear: DateOnly.year(figures.retirementDate),
    planEndAge: figures.planEndAge,
    successProbability: figures.successProbability,
    years: figures.years.map((year) => ({
      age: year.age,
      calendarYear: year.calendarYear,
      p5: year.p5 === null ? null : Money.toJSON(year.p5),
      p50: Money.toJSON(year.p50),
      p95: year.p95 === null ? null : Money.toJSON(year.p95),
    })),
  };
}

export function createCataloguePlanningPort(
  options: AdvisorCatalogueOptions,
): CataloguePlanningPort {
  const { database, clock, timeZone, monteCarlo } = options;
  const method = monteCarlo === null ? ('deterministic' as const) : ('monte_carlo' as const);
  const dependenciesFor = (userId: string): ProjectionServiceDependencies => ({
    inputs: createProjectionInputsReader(
      database,
      planningRevealedPortsFor(database, { userId, timeZone, clock }),
    ),
    monteCarlo,
    clock,
    timeZone,
    registry: currentRegistry(),
  });
  const scenarioIdOf = async (userId: string, scenario: string): Promise<string | null> => {
    if (scenario !== 'baseline') return scenario;
    return (await getBaseline(database, userId))?.id ?? null;
  };
  const noBaseline = notAvailable(
    'no_baseline',
    'No baseline plan is stated yet; the Plan screen states one.',
  );

  return {
    project: ({ userId, scenario, correlationId }) =>
      mapped(async () => {
        const scenarioId = await scenarioIdOf(userId, scenario);
        if (scenarioId === null) return noBaseline;
        const outcome = await projectScenarioFigures(database, dependenciesFor(userId), {
          userId,
          scenarioId,
          method,
          correlationId,
        });
        return outcome.status === 'stale'
          ? staleReason(outcome.staleness)
          : portProjection(outcome);
      }),

    compare: ({ userId, a, b, correlationId }) =>
      mapped(async () => {
        const scenarioA = await scenarioIdOf(userId, a);
        const scenarioB = await scenarioIdOf(userId, b);
        if (scenarioA === null || scenarioB === null) return noBaseline;
        const outcome = await compareScenarioFigures(database, dependenciesFor(userId), {
          userId,
          scenarioA,
          scenarioB,
          method,
          correlationId,
        });
        if (outcome.status === 'stale') return staleReason(outcome.staleness);
        return {
          status: 'served' as const,
          a: portProjection(outcome.a),
          b: portProjection(outcome.b),
          seed: outcome.seed.toString(),
          successProbabilityDelta: outcome.successProbabilityDelta,
          retirementDeltaMonths: outcome.retirementDeltaMonths,
        };
      }),

    levers: ({ userId, correlationId }) =>
      mapped(async () => {
        const outcome = await leverSensitivity(database, dependenciesFor(userId), {
          userId,
          correlationId,
        });
        if (outcome.status === 'no_baseline') return noBaseline;
        if (outcome.status === 'stale') return staleReason(outcome.staleness);
        return {
          status: 'served' as const,
          method: outcome.method,
          paths: outcome.paths,
          seed: outcome.seed.toString(),
          engineVersion: outcome.engineVersion,
          assumptionsVersion: outcome.assumptionsVersion,
          inputDigest: outcome.inputDigest,
          asOfYear: DateOnly.year(outcome.asOfDate),
          deadlineMs: outcome.deadlineMs,
          baseSuccessProbability: outcome.base.successProbability,
          levers: outcome.levers.map((lever) =>
            lever.status === 'computed'
              ? {
                  lever: lever.lever,
                  step: lever.step,
                  status: 'computed' as const,
                  levers: lever.levers as Readonly<Record<string, unknown>>,
                  successProbability: lever.successProbability,
                  delta: lever.delta,
                }
              : {
                  lever: lever.lever,
                  step: lever.step,
                  status: 'skipped' as const,
                  reason: lever.reason,
                  detail: lever.detail,
                },
          ),
        };
      }),

    async goalIds(userId) {
      return (await listGoals(database, userId)).map((goal) => goal.id);
    },

    requiredSavings: ({ userId, goalId, targetDate, maxMonthly }) =>
      mapped(async () => {
        const goal = (await listGoals(database, userId)).find(
          (candidate) => candidate.id === goalId,
        );
        if (goal === undefined) {
          throw new CatalogueRefusal('catalogue.goal_unknown', 404, `no goal ${goalId}`);
        }
        const result = await solveRequiredSavingsFor(database, {
          userId,
          timeZone,
          clock,
          objective: {
            kind: 'wealth_at',
            targetDate: targetDate === null ? goal.targetDate : DateOnly.parse(targetDate),
            target: goal.target,
            basis: 'real',
          },
          maxMonthly: Money.fromJSON(maxMonthly),
          asOf: null,
          allowOpenDay: false,
        });
        switch (result.kind) {
          case 'already_met':
            return {
              status: 'served' as const,
              kind: 'already_met' as const,
              monthly: Money.toJSON(result.monthly),
            };
          case 'required':
            return {
              status: 'served' as const,
              kind: 'required' as const,
              monthly: Money.toJSON(result.monthly),
              iterations: result.iterations,
            };
          case 'unreachable':
            return {
              status: 'served' as const,
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
                      ceiling: Money.toJSON(result.constraint.ceiling),
                      gapAtCeiling: Money.toJSON(result.constraint.gapAtCeiling),
                    },
            };
        }
      }),

    claimFactors: ({ userId, ages }) =>
      mapped(async () => {
        const baseline = await getBaseline(database, userId);
        if (baseline === null) return noBaseline;
        const resolved = await resolveForUser(database, { userId, timeZone }, currentRegistry());
        const derived = await dependenciesFor(userId).inputs.derivedInputs({
          userId,
          asOf: null,
          allowOpenDay: false,
        });
        const { plan } = assembleBaselinePlan(baseline.profile, derived);
        const social = plan.socialSecurity;
        if (social === null) {
          return notAvailable('no_social_security', 'The plan has no Social Security stated.');
        }
        // The engine's own factor, as `createInsightsPlanningPort`'s R4 block computes it:
        // the same plan, the claim age moved, nothing else.
        const planned = projectDeterministic(plan, resolved).socialSecurity;
        if (planned === null) {
          return notAvailable(
            'no_social_security',
            'The engine computed no Social Security benefit.',
          );
        }
        const factors = ages.map((age) => {
          const summary = projectDeterministic(
            { ...plan, socialSecurity: { ...social, claimAge: { years: age, months: 0 } } },
            resolved,
          ).socialSecurity;
          if (summary === null) throw new Error('a claim age the engine computed nothing for');
          return { age, factor: summary.claimFactor };
        });
        return {
          status: 'served' as const,
          plannedClaimAge: { years: planned.claimAge.years, months: planned.claimAge.months },
          plannedFactor: planned.claimFactor,
          factors,
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

/**
 * Provider subtypes (lower-cased) that name each kind of account a limit
 * applies to. The same vocabulary as Planning's tax-bucket sets
 * (`defaultTaxBucketWithBasis`), narrowed to the accounts each limit governs.
 */
export const CONTRIBUTION_SUBTYPES: Readonly<Record<ContributionAccountKind, readonly string[]>> =
  Object.freeze({
    ira: ['ira', 'traditional ira', 'roth', 'roth ira'],
    workplace_deferral: ['401k', '403b', '457b', 'thrift savings plan', 'roth 401k', 'roth 403b'],
    hsa_self_only: ['hsa', 'health savings account'],
    hsa_family: ['hsa', 'health savings account'],
  });

/** A contribution in, that is a transfer of existing savings rather than new money: not against a limit. */
const TRANSFER_WORD = /\b(rollover|transfer|conversion)\b/u;

interface ContributionRow extends Record<string, unknown> {
  readonly id: string;
  readonly trade_date: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly quantity: string;
  readonly amount_minor: string | bigint;
  readonly fees_minor: string | bigint;
  readonly currency: string;
  readonly security_id: string | null;
}

export function createCatalogueContributionsPort(
  database: Database,
  baseCurrency: string,
): CatalogueContributionsPort {
  return {
    async contributions({ userId, year, accountKind }) {
      const subtypes = CONTRIBUTION_SUBTYPES[accountKind];
      const subtypeList = `{${subtypes.map((entry) => `"${entry}"`).join(',')}}`;
      const accounts = await database.execute<{ id: string }>(sql`
        SELECT a.id
          FROM accounts a
         WHERE a.user_id = ${userId}::uuid
           AND lower(btrim(coalesce(a.subtype, ''))) = ANY(${subtypeList}::text[])
      `);
      const from = `${String(year).padStart(4, '0')}-01-01`;
      const to = `${String(year).padStart(4, '0')}-12-31`;
      const rows = await database.execute<ContributionRow>(sql`
        SELECT t.id,
               to_char(t.trade_date, 'YYYY-MM-DD') AS trade_date,
               t.type,
               t.subtype,
               t.quantity,
               t.amount_minor,
               t.fees_minor,
               t.currency,
               t.security_id
          FROM investment_transactions t
          JOIN accounts a
            ON a.id = t.account_id AND a.user_id = ${userId}::uuid
         WHERE t.user_id = ${userId}::uuid
           AND lower(btrim(coalesce(a.subtype, ''))) = ANY(${subtypeList}::text[])
           AND t.trade_date >= ${from}::date
           AND t.trade_date <= ${to}::date
         ORDER BY t.trade_date, t.id
      `);
      const byMonth = new Map<string, bigint>();
      const excluded = new Map<string, number>();
      const exclude = (reason: string) => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
      for (const row of rows.rows) {
        const code = toCurrency(row.currency.trim());
        const classified = classifyActivity({
          type: row.type,
          subtype: row.subtype,
          amount: Money.of(BigInt(row.amount_minor), code),
          fees: Money.of(BigInt(row.fees_minor), code),
          quantity: Quantity.fromDatabaseString(String(row.quantity)),
          securityId: row.security_id,
        });
        if (classified.kind !== 'contribution') continue;
        const word = `${row.type} ${row.subtype ?? ''}`.toLowerCase();
        if (row.type === 'TRANSFER_IN' || row.type === 'GIFT_IN' || TRANSFER_WORD.test(word)) {
          exclude('transfer_or_rollover');
          continue;
        }
        if (classified.flow === null) {
          exclude('in_kind_unvalued');
          continue;
        }
        if (classified.flow.currency !== baseCurrency) {
          exclude('other_currency');
          continue;
        }
        const month = row.trade_date.slice(0, 7);
        byMonth.set(month, (byMonth.get(month) ?? 0n) + classified.flow.minor);
      }
      return {
        currency: baseCurrency,
        accountsCounted: accounts.rows.length,
        months: [...byMonth.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([month, minor]) => ({
            month,
            total: { minor: minor.toString(), currency: baseCurrency },
          })),
        excluded: [...excluded.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([reason, count]) => ({ reason, count })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The whole binding
// ---------------------------------------------------------------------------

/** The catalogue's runtime dependencies for one process, bound to this database and clock. */
export function createAdvisorCatalogueDependencies(
  options: AdvisorCatalogueOptions,
): CatalogueRuntimeDependencies {
  const { database, clock, timeZone } = options;
  const baseCurrency = options.baseCurrency ?? 'USD';
  return {
    database,
    clock,
    timeZone,
    baseCurrency,
    tokenSecret: options.tokenSecret,
    ports: {
      // The insights routes' own snapshot ports (`routes/insights.ts`' `dependenciesOf`): the
      // api process has no FRED source, so `market.rates` emits no block here — no catalogue
      // function declares it.
      snapshot: {
        ledger: createInsightsLedgerPort(database, clock),
        budget: createInsightsBudgetPort(database),
        recurring: createInsightsRecurringPort(database),
        investments: createInsightsInvestmentsPort(database, clock),
        planning: createInsightsPlanningPort(database, clock, { timeZone }),
        marketData: createInsightsMarketDataPort({ source: undefined }),
        categorization: createInsightsCategorizationPort(database, clock),
      },
      parameters: createKnowledgeParameterPort(),
      planning: createCataloguePlanningPort(options),
      contributions: createCatalogueContributionsPort(database, baseCurrency),
      livingExpenses: createLivingExpensesPort(database, baseCurrency),
    },
  };
}
