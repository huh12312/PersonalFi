// SPDX-License-Identifier: MIT
/**
 * Builds a `ProjectionWorkerJob` (the client kernel's own input shape,
 * `../../../workers/projection.worker.ts`) from the caller's baseline
 * scenario plus the sliders' current lever values.
 *
 * **Known simplification, stated rather than silently guessed** (the same
 * house style `../GoalControls.tsx` and `../search.ts` already use for their
 * own scope cuts): the client kernel's `EnginePlan` has four wealth/
 * contribution buckets (`TAXABLE`/`TAX_DEFERRED`/`ROTH`/`HSA`), but this
 * panel exposes one "monthly savings" lever, not four. Every dollar of it —
 * and the whole starting balance — is modelled in the `TAXABLE` bucket; the
 * other three start and stay at zero. That is a real approximation of a
 * household with tax-advantaged accounts, and it is why this preview can
 * never be read as the saved plan's own number (D20 — the server, not this
 * panel, is authoritative). `startingBalance` itself has no server field to
 * read at all (a scenario's `profile` carries levers and policy, not current
 * balances), so it is the panel's own slider. WP 9.7 (G4-11) seeds it from the
 * newest sealed net-worth day (`./sealedStart.ts`) and labels the placeholder
 * default as one when there is no such day.
 */
import type { BaselineScenario } from '../../../api/generated/types.gen.ts';
import type { EngineGlidepath } from '../../../workers/kernel/glidepath.ts';
import type { ProjectionWorkerJob } from '../../../workers/projection-client.ts';
import {
  DEFAULT_BOND_NOMINAL,
  DEFAULT_BOND_VOLATILITY,
  DEFAULT_CORRELATION_ASSETS,
  DEFAULT_CORRELATION_MATRIX,
  DEFAULT_EQUITY_NOMINAL,
  DEFAULT_EQUITY_VOLATILITY,
  DEFAULT_INFLATION,
  DEFAULT_INFLATION_VOLATILITY,
  DEFAULT_TAX_DEFERRED_RATE,
  DEFAULT_WAGE_GROWTH_SPREAD,
} from './defaults.ts';

export interface SliderLevers {
  readonly retireAge: number;
  /** Whole dollars/year, real. */
  readonly annualSpending: number;
  /** Whole dollars/month. */
  readonly monthlySavings: number;
  /** Whole dollars, today — this panel's own lever; see file header. */
  readonly startingBalance: number;
}

const DEFAULT_START_AGE = 35;
const DEFAULT_END_AGE = 95;
const DEFAULT_RETIRE_AGE = 65;
// Balanced against `DEFAULT_STARTING_BALANCE`/`DEFAULT_MONTHLY_SAVINGS` below so the default
// preview neither always succeeds nor always depletes to exactly $0 by the final year (a real
// mixed outcome makes every lever's effect visible on the very first render, before any drag) —
// verified with the actual kernel: at these three defaults the final year's median is ≈$841k
// (not the $0 floor a higher spending figure hits), and a plausible savings-slider drag to
// $5,000/month moves it to ≈$4.8M.
const DEFAULT_ANNUAL_SPENDING = 40_000;
const DEFAULT_MONTHLY_SAVINGS = 1_500;
const DEFAULT_STARTING_BALANCE = 250_000;

/** Whole years from `birthDate` (`YYYY-MM-DD`) to today — a position on a timeline, not a money computation. */
function wholeYearsSince(birthDate: string, today: Date): number {
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return DEFAULT_START_AGE;
  let years = today.getFullYear() - born.getFullYear();
  const beforeBirthdayThisYear =
    today.getMonth() < born.getMonth() ||
    (today.getMonth() === born.getMonth() && today.getDate() < born.getDate());
  if (beforeBirthdayThisYear) years -= 1;
  return Math.max(18, years);
}

function toEngineGlidepath(
  glidepath: BaselineScenario['profile']['glidepath'] | undefined,
): EngineGlidepath {
  if (glidepath === undefined) return { kind: 'age_based' };
  if (glidepath.kind === 'static') {
    const equityShare = Number(glidepath.equityShare);
    return { kind: 'static', equityShare: Number.isFinite(equityShare) ? equityShare : 0.6 };
  }
  return { kind: glidepath.kind };
}

/** Which levers the saved plan states, and which fall back to this panel's own placeholder (G4-11). */
export interface LeverSources {
  readonly annualSpending: 'plan' | 'placeholder';
  readonly monthlySavings: 'plan' | 'placeholder';
}

export function leverSources(scenario: BaselineScenario | undefined): LeverSources {
  const profile = scenario?.profile;
  const contributions = profile?.contributions ?? null;
  const savesAnything =
    contributions !== null &&
    (['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const).some(
      (bucket) => contributions[bucket] !== undefined && Number(contributions[bucket].minor) > 0,
    );
  return {
    annualSpending:
      profile?.annualSpending !== null && profile?.annualSpending !== undefined
        ? 'plan'
        : 'placeholder',
    monthlySavings: savesAnything ? 'plan' : 'placeholder',
  };
}

/**
 * Sensible defaults for every lever, seeded from `scenario.profile` where it says something.
 * `startingBalance` is the newest sealed day's investable balance when the caller has one
 * (`./sealedStart.ts`); otherwise it is the placeholder, and the panel says so.
 */
export function defaultLevers(
  scenario: BaselineScenario | undefined,
  sealedStartingBalance?: number,
): SliderLevers {
  const profile = scenario?.profile;
  const annualSpending =
    profile?.annualSpending !== null && profile?.annualSpending !== undefined
      ? Number(profile.annualSpending.minor) / 100
      : DEFAULT_ANNUAL_SPENDING;
  const contributions = profile?.contributions ?? null;
  const monthlySavingsAnnual =
    contributions === null
      ? null
      : (['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const).reduce(
          (sum, bucket) =>
            sum +
            (contributions[bucket] === undefined ? 0 : Number(contributions[bucket].minor) / 100),
          0,
        );
  return {
    retireAge: profile?.retirementAge ?? DEFAULT_RETIRE_AGE,
    annualSpending: Number.isFinite(annualSpending) ? annualSpending : DEFAULT_ANNUAL_SPENDING,
    monthlySavings:
      monthlySavingsAnnual !== null && monthlySavingsAnnual > 0
        ? Math.round(monthlySavingsAnnual / 12)
        : DEFAULT_MONTHLY_SAVINGS,
    startingBalance: sealedStartingBalance ?? DEFAULT_STARTING_BALANCE,
  };
}

export interface BuildPreviewJobOptions {
  readonly scenario: BaselineScenario | undefined;
  readonly levers: SliderLevers;
  readonly seed: bigint;
  readonly paths: number;
  readonly today?: Date;
}

export function buildPreviewJob({
  scenario,
  levers,
  seed,
  paths,
  today = new Date(),
}: BuildPreviewJobOptions): ProjectionWorkerJob {
  const profile = scenario?.profile;
  const startAge =
    profile?.birthDate !== undefined
      ? wholeYearsSince(profile.birthDate, today)
      : DEFAULT_START_AGE;
  const endAge = profile?.planEndAge ?? DEFAULT_END_AGE;
  const retireAge = Math.min(levers.retireAge, endAge - 1);
  const glidepath = toEngineGlidepath(profile?.glidepath);
  const taxDeferredRate =
    profile?.taxDeferredRate !== undefined
      ? Number(profile.taxDeferredRate)
      : DEFAULT_TAX_DEFERRED_RATE;
  const contributionGrowth =
    profile?.contributionGrowth === 'wage' ? DEFAULT_INFLATION + DEFAULT_WAGE_GROWTH_SPREAD : 0;

  return {
    plan: {
      startAge,
      retireAge,
      endAge,
      startYear: today.getFullYear(),
      wealth0: [levers.startingBalance, 0, 0, 0],
      contribution0: [levers.monthlySavings * 12, 0, 0, 0],
      glidepaths: [glidepath, glidepath, glidepath, glidepath],
      contributionGrowth,
      spending: levers.annualSpending,
      inflation: DEFAULT_INFLATION,
      equityNominal: DEFAULT_EQUITY_NOMINAL,
      bondNominal: DEFAULT_BOND_NOMINAL,
      taxDeferredRate: Number.isFinite(taxDeferredRate)
        ? taxDeferredRate
        : DEFAULT_TAX_DEFERRED_RATE,
      withdrawalOrder: [0, 1, 2, 3],
      policy: { kind: 'constant_real' },
      extraBucket: 0,
    },
    volatility: {
      equity: DEFAULT_EQUITY_VOLATILITY,
      bond: DEFAULT_BOND_VOLATILITY,
      inflation: DEFAULT_INFLATION_VOLATILITY,
    },
    correlation: { assets: [...DEFAULT_CORRELATION_ASSETS], matrix: DEFAULT_CORRELATION_MATRIX },
    seed,
    paths,
    extra: { annual: 0, untilAge: 0 },
  };
}
