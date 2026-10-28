// SPDX-License-Identifier: MIT
/**
 * What the advisory catalogue reads beyond `@ctx/insights` itself, in its own
 * vocabulary (WP 11.5b). `@ctx/insights` may not import `@ctx/planning`,
 * `@ctx/investments` or `@ctx/ledger` (08 §1.6; `personalfi/layer-imports`),
 * so the composition root (`apps/api/src/advisor-catalogue.ts`) binds these to
 * the engines and readers that already exist — the projection service, the
 * required-savings solver, the investment activity classifier — exactly as
 * WP 11.5a's `ParameterPort` binds the parameter store.
 *
 * Every port answers in wire data: money as `{ minor, currency }` strings,
 * probabilities and ratios as decimal strings, seeds as strings. Nothing a port
 * returns is a float, and nothing it returns is written anywhere.
 */
import type { MoneyJson } from '../contract/snapshot.ts';
import type { LivingExpensesPort } from '../health/living-expenses.ts';
import type { ParameterPort } from '../knowledge/params.ts';
import type { SnapshotPorts } from '../snapshot/ports.ts';

/** A refusal of the *call* — the arguments named something that is not there. */
export class CatalogueRefusal extends Error {
  readonly code: CatalogueRefusalCode;
  readonly status: 400 | 403 | 404 | 422 | 503;
  constructor(code: CatalogueRefusalCode, status: CatalogueRefusal['status'], message: string) {
    super(message);
    this.name = 'CatalogueRefusal';
    this.code = code;
    this.status = status;
  }
}

export type CatalogueRefusalCode =
  | 'catalogue.unknown_function'
  | 'catalogue.scope_not_granted'
  | 'catalogue.invalid_arguments'
  | 'catalogue.year_unavailable'
  | 'catalogue.goal_unknown'
  | 'catalogue.scenario_unknown'
  | 'catalogue.insight_unknown'
  | 'catalogue.unavailable';

export function isCatalogueRefusal(error: unknown): error is CatalogueRefusal {
  return error instanceof CatalogueRefusal;
}

/** A data-level "cannot answer": the function is granted, the data or engine is not there. */
export interface PortNotAvailable {
  readonly status: 'not_available';
  readonly code: string;
  readonly reason: string;
}

/** One year of a projection's band, money rounded by the caller to the scope's $1,000. */
export interface PortProjectionYear {
  readonly age: number;
  readonly calendarYear: number;
  readonly p5: MoneyJson | null;
  readonly p50: MoneyJson;
  readonly p95: MoneyJson | null;
}

export interface PortProjection {
  readonly status: 'served';
  readonly scenarioKind: 'baseline' | 'fork';
  readonly method: 'monte_carlo' | 'deterministic';
  readonly paths: number;
  readonly seed: string;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly inputDigest: string;
  readonly asOfYear: number;
  readonly balancesSealed: boolean;
  readonly retirementAge: number;
  readonly retirementYear: number;
  readonly planEndAge: number;
  /** Six places. */
  readonly successProbability: string;
  readonly years: readonly PortProjectionYear[];
}

export interface PortComparison {
  readonly status: 'served';
  readonly a: PortProjection;
  readonly b: PortProjection;
  readonly seed: string;
  readonly successProbabilityDelta: string;
  readonly retirementDeltaMonths: number;
}

export type PortLeverOutcome =
  | {
      readonly lever: string;
      readonly step: string;
      readonly status: 'computed';
      /** The lever as the plan stores it (`ScenarioLeversJson`): strings only. */
      readonly levers: Readonly<Record<string, unknown>>;
      readonly successProbability: string;
      readonly delta: string;
    }
  | {
      readonly lever: string;
      readonly step: string;
      readonly status: 'skipped';
      readonly reason: string;
      readonly detail: string;
    };

export interface PortLevers {
  readonly status: 'served';
  readonly method: 'monte_carlo' | 'deterministic';
  readonly paths: number;
  readonly seed: string;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly inputDigest: string;
  readonly asOfYear: number;
  readonly deadlineMs: number;
  readonly baseSuccessProbability: string;
  readonly levers: readonly PortLeverOutcome[];
}

export type PortRequiredSavings =
  | { readonly status: 'served'; readonly kind: 'already_met'; readonly monthly: MoneyJson }
  | {
      readonly status: 'served';
      readonly kind: 'required';
      readonly monthly: MoneyJson;
      readonly iterations: number;
    }
  | {
      readonly status: 'served';
      readonly kind: 'unreachable';
      readonly constraint:
        | {
            readonly name: 'no_contribution_window';
            readonly detail: string;
            readonly contributionsEndAge: number;
          }
        | {
            readonly name: 'monthly_ceiling';
            readonly detail: string;
            readonly ceiling: MoneyJson;
            readonly gapAtCeiling: MoneyJson;
          };
    };

export interface PortClaimFactors {
  readonly status: 'served';
  readonly plannedClaimAge: { readonly years: number; readonly months: number };
  /** The engine's statutory multiplier at the plan's own claim age. */
  readonly plannedFactor: string;
  readonly factors: readonly { readonly age: number; readonly factor: string }[];
}

/** Planning's engines, read-only. A refusal of the call throws `CatalogueRefusal`. */
export interface CataloguePlanningPort {
  project(input: {
    readonly userId: string;
    readonly scenario: string;
    readonly correlationId: string;
  }): Promise<PortProjection | PortNotAvailable>;
  compare(input: {
    readonly userId: string;
    readonly a: string;
    readonly b: string;
    readonly correlationId: string;
  }): Promise<PortComparison | PortNotAvailable>;
  levers(input: {
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<PortLevers | PortNotAvailable>;
  /** The holder's goal ids, so a `goal_ref` from the snapshot can be resolved without a goal id ever crossing. */
  goalIds(userId: string): Promise<readonly string[]>;
  requiredSavings(input: {
    readonly userId: string;
    readonly goalId: string;
    /** `null`: the goal's own target date. */
    readonly targetDate: string | null;
    readonly maxMonthly: MoneyJson;
  }): Promise<PortRequiredSavings | PortNotAvailable>;
  claimFactors(input: {
    readonly userId: string;
    readonly ages: readonly number[];
  }): Promise<PortClaimFactors | PortNotAvailable>;
}

/** The account kinds `limits.contribution_room` answers for. */
export const CONTRIBUTION_ACCOUNT_KINDS = [
  'ira',
  'workplace_deferral',
  'hsa_self_only',
  'hsa_family',
] as const;
export type ContributionAccountKind = (typeof CONTRIBUTION_ACCOUNT_KINDS)[number];

/**
 * Contributions to accounts of one kind in one calendar year, per month: the
 * ledger's investment activity, classified by `@ctx/investments`'
 * `classifyActivity` (WP 10.3) — the same function the Activity tab and the
 * performance return use — so the three cannot disagree about what a
 * contribution was. A month total, never a row.
 */
export interface PortContributions {
  readonly currency: string;
  readonly accountsCounted: number;
  readonly months: readonly { readonly month: string; readonly total: MoneyJson }[];
  /** Rows the classifier called a contribution that do not count against a limit, by reason. */
  readonly excluded: readonly { readonly reason: string; readonly count: number }[];
}

export interface CatalogueContributionsPort {
  contributions(input: {
    readonly userId: string;
    readonly year: number;
    readonly accountKind: ContributionAccountKind;
  }): Promise<PortContributions>;
}

/** Everything the composition root binds. */
export interface CataloguePorts {
  readonly snapshot: SnapshotPorts;
  readonly parameters: ParameterPort;
  readonly planning: CataloguePlanningPort;
  readonly contributions: CatalogueContributionsPort;
  /** WP 10.12's living expenses, when bound; `cash.emergency_fund` reports it beside recent spending. */
  readonly livingExpenses?: LivingExpensesPort;
}
