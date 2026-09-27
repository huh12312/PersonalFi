// SPDX-License-Identifier: MIT
/**
 * Shared fixture builders for `features/plan`'s unit tests — the
 * `features/investments/fixtures.ts` pattern. Every shape here is a minimal,
 * schema-valid instance of a generated wire type, never a re-typed guess at
 * one.
 */
import type {
  AssumptionsFile,
  BaselineScenario,
  ComparePlanScenariosResponse,
  ForkScenario,
  GetAssumptionsResponse,
  ListPlanScenariosResponse,
  Money,
  PlanLifeEvent,
  RunPlanProjectionResponse,
} from '../../api/generated/types.gen.ts';
import type { PlanPercentile } from './FanChart.tsx';

export function usd(minor: string): Money {
  return { minor, currency: 'USD' };
}

export function baselineScenario(overrides: Partial<BaselineScenario> = {}): BaselineScenario {
  return {
    kind: 'baseline',
    id: 'scenario-baseline',
    name: 'Baseline',
    profile: {
      birthDate: '1985-04-12',
      retirementAge: 65,
      planEndAge: 95,
      currency: 'USD',
      glidepath: { kind: 'age_based' },
      contributionGrowth: 'wage',
      annualSpending: null,
      withdrawalPolicy: 'guardrails',
      spendingFloor: 'essential_spend',
      taxDeferredRate: '0.22',
      socialSecurity: null,
      pensions: [],
      contributions: null,
    },
    seed: 'seed-baseline-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function forkScenario(overrides: Partial<ForkScenario> = {}): ForkScenario {
  return {
    kind: 'fork',
    id: 'scenario-fork-retire-early',
    baselineId: 'scenario-baseline',
    name: 'Retire at 62',
    levers: { retireAge: 62 },
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

export function scenariosResponse(): ListPlanScenariosResponse {
  return { scenarios: [baselineScenario(), forkScenario()] };
}

/** Three checkpoints — start, mid-career, retirement — with a deliberately wide p5/p95 band. */
export function percentilesFixture(): PlanPercentile[] {
  return [
    {
      index: 0,
      age: 41,
      calendarYear: 2026,
      p5: usd('25000000'),
      p10: usd('30000000'),
      p25: usd('35000000'),
      p50: usd('40000000'),
      p75: usd('45000000'),
      p90: usd('50000000'),
      p95: usd('55000000'),
    },
    {
      index: 1,
      age: 51,
      calendarYear: 2036,
      p5: usd('55000000'),
      p10: usd('65000000'),
      p25: usd('75000000'),
      p50: usd('90000000'),
      p75: usd('105000000'),
      p90: usd('120000000'),
      p95: usd('135000000'),
    },
    {
      index: 2,
      age: 65,
      calendarYear: 2046,
      p5: usd('90000000'),
      p10: usd('120000000'),
      p25: usd('150000000'),
      p50: usd('180000000'),
      p75: usd('210000000'),
      p90: usd('240000000'),
      p95: usd('270000000'),
    },
  ];
}

export function projectionResponse(
  overrides: Partial<RunPlanProjectionResponse> = {},
): RunPlanProjectionResponse {
  return {
    status: 'computed',
    run: {
      id: 'run-1',
      scenarioId: 'scenario-baseline',
      scenarioKind: 'baseline',
      method: 'monte_carlo',
      seed: 'seed-baseline-1',
      paths: 10_000,
      engineVersion: 'engine-1',
      assumptionsVersion: 'assumptions-1',
      asOfDate: '2026-09-23',
      balancesSealed: true,
      currency: 'USD',
      successProbability: '0.82',
      durationMs: 412,
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    percentiles: percentilesFixture(),
    staleness: null,
    ...overrides,
  };
}

export function assumptionsFileFixture(): AssumptionsFile {
  return {
    capitalMarket: {
      usEquity: {
        expectedReturn: {
          value: '0.065',
          kind: 'nominal',
          basis: null,
          source: '07 Appendix A §5.5',
          asOf: '2026-01-01',
          note: null,
        },
      },
    },
    usTax2026: {
      socialSecurity: {
        wageBase: {
          value: '184500',
          kind: 'limit',
          basis: null,
          source: 'SSA 2026 COLA notice',
          asOf: '2025-10-15',
          note: null,
        },
      },
    },
  };
}

export function assumptionsResponse(
  overrides: Partial<GetAssumptionsResponse> = {},
): GetAssumptionsResponse {
  return {
    version: 'assumptions-1',
    file: assumptionsFileFixture(),
    overrides: [],
    overridablePaths: ['capitalMarket.usEquity.expectedReturn'],
    ...overrides,
  };
}

export function lifeEventFixture(overrides: Partial<PlanLifeEvent> = {}): PlanLifeEvent {
  return {
    id: 'life-event-1',
    kind: 'windfall',
    name: 'Signing bonus',
    occursOn: '2030-06-01',
    amount: usd('500000'),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function compareResponse(
  overrides: Partial<ComparePlanScenariosResponse> = {},
): ComparePlanScenariosResponse {
  return {
    a: projectionResponse(),
    b: projectionResponse({
      run: {
        ...(projectionResponse().run as NonNullable<RunPlanProjectionResponse['run']>),
        id: 'run-2',
        scenarioId: 'scenario-fork-retire-early',
        successProbability: '0.74',
      },
    }),
    seed: 'seed-baseline-1',
    successProbabilityDelta: '-0.08',
    retirementDate: { a: '2046-04-12', b: '2043-04-12' },
    retirementDeltaMonths: -36,
    ...overrides,
  };
}
