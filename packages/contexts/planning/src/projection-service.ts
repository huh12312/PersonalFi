// SPDX-License-Identifier: MIT
/**
 * The projection service (WP 4.6): assemble a scenario's plan, serve it from
 * the cache or run an engine, store the run, say so — and evaluate goal pace
 * (07 R6) once per baseline run.
 *
 * ## The cache (04 §5.6)
 *
 * `cache_key = sha256(assumptions + engine_version + seed + input)`, where:
 *
 *   * **assumptions** is the *resolved* set — the file's content-hash version
 *     **and the holder's override deltas**. `ResolvedAssumptions.version` is
 *     the file's version even with overrides applied (WP 4.2), so keying on the
 *     version alone would serve a run computed at 6.5% equity returns to a
 *     holder who has since overridden it to 5.5%. Both go in.
 *   * **engine_version** is `ENGINE_VERSION` for the deterministic engine and
 *     the bound `MonteCarloRunner.engineVersion` for Monte Carlo — known before
 *     the run, which is why the port exposes it as a property.
 *   * **seed** is the baseline's (a fork has none of its own, 0022).
 *   * **input** is `input_digest`: sha256 over the canonical JSON of the whole
 *     assembled input — the plan after levers and life events, the method and
 *     path count, the scenario, the sealed day the balances came from, which
 *     life events did *not* apply and why.
 *
 * An identical request is served from `projection_runs` and **does not run the
 * engine** — and does not re-announce: `planning.ProjectionCompleted` is
 * appended only when a run is freshly computed (WP 3.2's re-delivery defect,
 * not repeated). `docs/evidence/phase-4/wp4.6-projection-service.md` §2 walks
 * each input changed one at a time with the hit or miss it produced.
 *
 * ## Stale, never silently recomputed
 *
 * If the holder's overrides name an assumptions version this build no longer
 * holds, `resolveForUser` throws `UnknownAssumptionsVersion`. The service does
 * **not** catch that and fall back to today's defaults — that would silently
 * drop the holder's overrides and hand back a new number under an old name.
 * It returns the scenario's latest stored run labelled **stale, with the
 * version named**, and computes nothing. Reading a stored run back
 * (`readProjection`) labels it stale the same way when its own version has
 * been retired. The `net_worth_daily` seal enforces the same rule one table
 * over.
 *
 * ## Balances from a sealed day
 *
 * Starting balances come from Planning's own `net_worth_daily` — the current
 * revision of the requested day, or the newest **sealed** day when none is
 * named — never from a live balance read. An open-day run is legal only when
 * `allowOpenDay` asks for it, and the run records `balances_sealed = false`.
 * So a projection dated to a sealed day reproduces after a re-sync moves
 * today, which is the dispatch's §5 risk row.
 *
 * ## Read, compute, write — never a transaction held across an engine run (WP 5.5)
 *
 * A projection is three phases, exported separately: `prepareProjection`
 * (every read — the scenario, the resolved assumptions, the sealed day, the
 * life events, the cache lookup), `computeProjection` (the engine, and nothing
 * else: no executor reaches it), and `storeProjection` (the run, its bands and
 * `ProjectionCompleted`, as one fact). `runProjection` composes them over one
 * executor for the routes; the nightly refresh job (`jobs.ts`) runs the first
 * and last each in their own short transaction and the engine between them,
 * holding no connection — a ~1 s Monte Carlo inside a transaction is a pooled
 * connection pinned for nothing, and Phase 5 adds a weekly job that runs the
 * engine per Brief item. A concurrent identical run between the read and the
 * write is harmless: `insertRun`'s `ON CONFLICT` serves the winner's row and
 * nothing is announced twice.
 *
 * ## Life events that leave, and crypto (WP 5.5)
 *
 * A stored **outflow** (a home purchase, college, a sabbatical) in the plan's
 * range is now applied: a dated one-off on the plan (`oneOffs`), converted at
 * the boundary and drawn through the withdrawal order in its year. It is listed
 * under `lifeEvents.applied` and no longer under `unapplied`. A **crypto**
 * account (the composition root marks it `sleeve: 'crypto'`) is summed out of
 * its tax bucket into `cryptoHolding` and handed to the Monte Carlo as its own
 * sleeve (07 §6.4: never folded into equity — and a `TAXABLE` glidepath is an
 * equity/bond blend). The deterministic engine has no crypto sleeve, so its
 * run is the plan **with crypto valued at zero** — 07 §6.4 treatment 2's
 * conservative projection — and the input document says so.
 *
 * ## Goal pace (07 R6), once per evaluation
 *
 * `planning.goal_pace@v1` consumes a **baseline** run's `ProjectionCompleted`,
 * claims that run (`projection_runs.goals_evaluated_at`, stamped once), and
 * only then evaluates and emits `planning.GoalOffTrack` per off-track goal.
 * A redelivery or a replay finds the claim taken and emits nothing.
 */
import {
  DateOnly,
  Money,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import {
  appendEvent,
  configHash,
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type Executor,
  type RegisteredConsumer,
} from '@core/platform';
import {
  UnknownAssumptionsVersion,
  computableVersions,
  currentRegistry,
  isRetainedVersion,
  resolveForUser,
  type AssumptionsRegistry,
  type ResolvedAssumptions,
} from './assumptions.ts';
import { CADENCE_PERIODS_PER_YEAR, amountOn, type ContributionPlan } from './contributions.ts';
import {
  diffOverrideFingerprints,
  fingerprintOf,
  storedFingerprintOf,
  type OverrideChange,
  type OverrideFingerprint,
} from './override-staleness.ts';
import { listEarmarks } from './earmarks.ts';
import {
  PROJECTION_BUCKETS,
  ageOn,
  type AssumptionsLike,
  type BucketPlan,
  type OneOffPlan,
  type ProjectionBucket,
  type ProjectionPlan,
  type ProjectionResult,
} from './engine/boundary.ts';
import { ENGINE_VERSION } from './engine/deterministic.ts';
import { projectDeterministic } from './engine/project.ts';
import { GoalOffTrack, ProjectionCompleted } from './events.ts';
import { listContributions, listGoals } from './goals.ts';
import type { CashEarmark, Goal } from './goals-store.ts';
import { lifeEventsForPlan, listLifeEvents, type LifeEvent } from './life-events.ts';
import type { MonteCarloOutcome, MonteCarloRunner, RevealedPorts } from './ports.ts';
import {
  ProjectionRefused,
  balancesDay,
  claimGoalEvaluation,
  findRun,
  findRunByCacheKey,
  insertRun,
  latestRunForScenario,
  percentilesOf,
  type BalancesDay,
  type StoredPercentile,
  type StoredRun,
} from './projection-store.ts';
import { deriveRevealedBehavior, type DerivedAmount } from './revealed.ts';
import {
  applyLevers,
  getScenario,
  getBaseline,
  leversToJson,
  type BaselineProfile,
  type BaselineScenario,
  type Scenario,
} from './scenarios.ts';
import { platformOf, type PlanningExecutor } from './store.ts';
import type { ProjectionMethod } from '../schema/projections.ts';

/** 08 §7.2's default. */
export const DEFAULT_MONTE_CARLO_PATHS = 10_000;
/** The store's CHECK ceiling. WP 4.5's worker host refuses its own, narrower envelope before spawning. */
export const MAX_STORED_PATHS = 1_000_000;

/** Version of the input document's shape. Part of the digest: a shape change misses the cache. */
export const INPUT_DOCUMENT_SCHEMA = 'personalfi.projection-input/1';

// ---------------------------------------------------------------------------
// Derived inputs: what is observed rather than stated
// ---------------------------------------------------------------------------

/** One derived annual amount, or `null` when WP 4.3 could not derive it (and the run says so). */
export interface DerivedInputs {
  readonly currency: string;
  readonly balances: {
    readonly asOfDate: DateOnlyType;
    readonly revision: number;
    readonly sealed: boolean;
    readonly byBucket: Readonly<Record<ProjectionBucket, MoneyType>>;
  };
  readonly contributions: Readonly<Record<ProjectionBucket, MoneyType | null>>;
  readonly annualIncome: MoneyType | null;
  readonly nonSavingsSpending: MoneyType | null;
  readonly essentialSpending: MoneyType | null;
  /**
   * WP 5.5: the day's crypto, summed out of the tax buckets (07 §6.4). Absent
   * or zero when the holder has none — or when the composition root does not
   * mark crypto accounts, in which case they stay in `TAXABLE` as before.
   */
  readonly cryptoHolding?: MoneyType;
  /**
   * WP 9.2: the holder's overlay on their accounts (tax treatment, role,
   * valuation), as the fingerprint the input digest is over. Absent when they
   * have set none, so a run without overrides digests as it always did.
   */
  readonly accountOverrides?: NonNullable<OverrideFingerprint>;
}

/** Where the service reads what is observed. The real one is `createProjectionInputsReader`. */
export interface ProjectionInputsReader {
  derivedInputs(input: {
    readonly userId: string;
    /** `null`: the newest sealed day. */
    readonly asOf: DateOnlyType | null;
    readonly allowOpenDay: boolean;
  }): Promise<DerivedInputs>;
}

function annualOf(amount: DerivedAmount): MoneyType | null {
  return amount.status === 'derived' ? amount.annual : null;
}

/**
 * The production reader: balances by tax bucket from `net_worth_daily` (this
 * context's own table — sealed, per the header) and contributions, income and
 * spending from WP 4.3's `deriveRevealedBehavior` over the ports the
 * composition root binds. The tax bucket of each account is the
 * `CashflowReader`'s (`defaultTaxBucketFor`), so the bucket a balance is
 * counted in and the bucket its contributions are derived for agree.
 */
export function createProjectionInputsReader(
  executor: PlanningExecutor,
  revealed: RevealedPorts,
): ProjectionInputsReader {
  return {
    async derivedInputs(input) {
      const day = await balancesDay(executor, input.userId, input.asOf);
      if (day === null) {
        throw new ProjectionRefused(
          'planning.projection_no_balances',
          input.asOf === null
            ? 'no sealed net-worth day exists yet; a projection starts from a sealed day (08 §3.5)'
            : `no net-worth row for ${input.asOf}`,
        );
      }
      if (!day.sealed && !input.allowOpenDay) {
        throw new ProjectionRefused(
          'planning.projection_balances_unsealed',
          `${day.asOfDate} is still the open day; a projection from it moves when today does. ` +
            'Ask for it explicitly (allowOpenDay) and the run records that it did.',
        );
      }
      return derivedFromDay(day, revealed, input.userId);
    },
  };
}

async function derivedFromDay(
  day: BalancesDay,
  revealed: RevealedPorts,
  userId: string,
): Promise<DerivedInputs> {
  const code = day.baseCurrency;
  const accounts = await revealed.cashflow.accounts(userId, day.asOfDate);
  const bucketOf = new Map(accounts.map((account) => [account.accountId, account.taxBucket]));
  const overrides = fingerprintOf(accounts);
  const crypto = new Set(
    accounts.filter((account) => account.sleeve === 'crypto').map((account) => account.accountId),
  );
  const byBucket: Record<ProjectionBucket, MoneyType> = {
    TAXABLE: Money.zero(code),
    TAX_DEFERRED: Money.zero(code),
    ROTH: Money.zero(code),
    HSA: Money.zero(code),
  };
  let cryptoHolding = Money.zero(code);
  for (const entry of day.breakdown) {
    const bucket = bucketOf.get(entry.accountId);
    if (bucket === undefined || bucket === null) continue;
    if (entry.side !== 'asset' || !entry.inNetWorth) continue;
    const held = Money.of(BigInt(entry.baseMinor), code);
    // The bucket split (wp4.6 §11 item 4): a crypto account is its own sleeve, never a bucket's.
    if (crypto.has(entry.accountId)) cryptoHolding = Money.add(cryptoHolding, held);
    else byBucket[bucket] = Money.add(byBucket[bucket], held);
  }
  for (const bucket of PROJECTION_BUCKETS) {
    // A bucket is a pot of assets; a negative sum is a data problem the engine
    // would refuse by name, and the honest floor for "what is in it" is zero.
    byBucket[bucket] = Money.max(byBucket[bucket], Money.zero(code));
  }
  const behaviour = await deriveRevealedBehavior(revealed, {
    userId,
    asOf: day.asOfDate,
    baseCurrency: code,
  });
  const contributions = {} as Record<ProjectionBucket, MoneyType | null>;
  for (const bucket of PROJECTION_BUCKETS) {
    contributions[bucket] = annualOf(behaviour.contributions.byBucket[bucket]);
  }
  return Object.freeze({
    currency: code,
    balances: Object.freeze({
      asOfDate: day.asOfDate,
      revision: day.revision,
      sealed: day.sealed,
      byBucket: Object.freeze(byBucket),
    }),
    contributions: Object.freeze(contributions),
    annualIncome: annualOf(behaviour.income.total),
    nonSavingsSpending: annualOf(behaviour.spending.nonSavings),
    essentialSpending: annualOf(behaviour.spending.essential),
    // Same floor as a bucket: a negative crypto sum is a data problem, and zero is "none".
    ...(Money.isPositive(cryptoHolding) ? { cryptoHolding } : {}),
    ...(overrides === null ? {} : { accountOverrides: overrides }),
  });
}

// ---------------------------------------------------------------------------
// Assembly: profile + derived (+ levers) (+ life events) → one ProjectionPlan
// ---------------------------------------------------------------------------

export type InputSource = 'stated' | 'derived' | 'none';

/** Where each part of the assembled plan came from. Part of the input digest. */
export interface PlanSources {
  readonly contributions: Readonly<Record<ProjectionBucket, InputSource>>;
  readonly spending: 'stated' | 'derived';
  readonly spendingFloor: 'stated' | 'derived' | 'none' | 'essential_unavailable';
}

/**
 * The baseline's plan, before levers and life events. Pure, Money only.
 *
 * @throws {ProjectionRefused} `planning.projection_spending_unknown` — the
 *   profile states no spending and none could be derived. A plan without a
 *   spending figure is not a plan, and zero would be a confident lie.
 */
export function assembleBaselinePlan(
  profile: BaselineProfile,
  derived: DerivedInputs,
): { readonly plan: ProjectionPlan; readonly sources: PlanSources } {
  const code = profile.currency;
  const buckets: BucketPlan[] = [];
  const contributionSources = {} as Record<ProjectionBucket, InputSource>;
  for (const bucket of PROJECTION_BUCKETS) {
    const stated = profile.contributions?.[bucket];
    const fromData = derived.contributions[bucket];
    const annualContribution = stated ?? fromData ?? Money.zero(code);
    contributionSources[bucket] =
      stated !== undefined ? 'stated' : fromData !== null ? 'derived' : 'none';
    const startingBalance = derived.balances.byBucket[bucket];
    if (Money.isZero(startingBalance) && Money.isZero(annualContribution)) continue;
    buckets.push({ bucket, startingBalance, annualContribution });
  }

  const spending = profile.annualSpending ?? derived.nonSavingsSpending;
  if (spending === null) {
    throw new ProjectionRefused(
      'planning.projection_spending_unknown',
      'the baseline states no retirement spending and none could be derived from twelve months ' +
        'of spending (09 GOAL-4); state it in the baseline',
    );
  }

  let floor: MoneyType | null = null;
  let floorSource: PlanSources['spendingFloor'] = 'none';
  if (profile.withdrawalPolicy === 'guardrails') {
    if (profile.spendingFloor === 'essential_spend') {
      floor = derived.essentialSpending;
      floorSource = floor === null ? 'essential_unavailable' : 'derived';
    } else if (profile.spendingFloor !== 'none') {
      floor = profile.spendingFloor;
      floorSource = 'stated';
    }
  }

  const plan: ProjectionPlan = {
    currency: code,
    asOf: derived.balances.asOfDate,
    birthDate: profile.birthDate,
    retirementAge: profile.retirementAge,
    planEndAge: profile.planEndAge,
    buckets,
    contributionGrowth: profile.contributionGrowth,
    glidepath: profile.glidepath,
    annualSpending: spending,
    withdrawalPolicy:
      profile.withdrawalPolicy === 'constant_real'
        ? { kind: 'constant_real' }
        : {
            kind: 'guardrails',
            spendingFloor: floor,
            ...(profile.cumulativeCutCap === undefined
              ? {}
              : { cumulativeCutCap: profile.cumulativeCutCap }),
          },
    taxDeferredRate: profile.taxDeferredRate,
    socialSecurity:
      profile.socialSecurity === null
        ? null
        : {
            kind: 'statement',
            monthlyPia: profile.socialSecurity.monthlyPia,
            claimAge: profile.socialSecurity.claimAge,
            stressAfter2034: profile.socialSecurity.stressAfter2034,
          },
    pensions: profile.pensions,
    otherIncome: [],
  };
  return {
    plan,
    sources: Object.freeze({
      contributions: Object.freeze(contributionSources),
      spending: profile.annualSpending === null ? 'derived' : 'stated',
      spendingFloor: floorSource,
    }),
  };
}

/** Everything a run is computed from, and the document its digest is over. */
export interface AssembledInput {
  readonly plan: ProjectionPlan;
  /** WP 5.5: crypto held, for the Monte Carlo's own sleeve; `null` when none. */
  readonly cryptoHolding: MoneyType | null;
  readonly document: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

/**
 * Canonical, number-free JSON: `bigint` and `number` both become strings, so
 * the document satisfies `plan_document_has_no_json_number` and hashes the
 * same in every process (`canonicalJson` sorts keys; nothing here depends on
 * insertion order).
 */
export function documentOf(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`a non-finite number cannot enter a run document`);
    return String(value);
  }
  if (Array.isArray(value)) return value.map(documentOf);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]) => [key, documentOf(inner)]),
    );
  }
  return value;
}

export function inputDigestOf(document: Readonly<Record<string, unknown>>): string {
  return `sha256:${configHash(document as Record<string, unknown>)}`;
}

/** The four cache-key inputs (04 §5.6), and nothing else. */
export interface CacheKeyParts {
  readonly assumptionsVersion: string;
  readonly assumptionsOverrides: Readonly<Record<string, string>>;
  readonly engineVersion: string;
  readonly seed: bigint;
  readonly inputDigest: string;
}

/** `sha256(assumptions + engine_version + seed + input)`. */
export function cacheKeyOf(parts: CacheKeyParts): string {
  return `sha256:${configHash({
    assumptionsVersion: parts.assumptionsVersion,
    assumptionsOverrides: { ...parts.assumptionsOverrides },
    engineVersion: parts.engineVersion,
    seed: parts.seed.toString(),
    inputDigest: parts.inputDigest,
  })}`;
}

/** The deltas a resolved assumption set carries, as the flat map 0021 stores. */
export function overridesOf(resolved: ResolvedAssumptions): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(resolved.overrides.map((override) => [override.path, override.value])),
  );
}

/**
 * One scenario's input, assembled and digested. Pure given its arguments, so
 * two processes assembling the same scenario over the same rows produce the
 * same digest — which is what makes the cache a cache.
 */
export function assembleInput(input: {
  readonly scenario: Scenario;
  readonly baseline: BaselineScenario;
  readonly derived: DerivedInputs;
  readonly lifeEvents: readonly LifeEvent[];
  readonly method: ProjectionMethod;
  readonly paths: number;
}): AssembledInput {
  const base = assembleBaselinePlan(input.baseline.profile, input.derived);
  let plan = base.plan;
  let windfall: unknown = null;
  if (input.scenario.kind === 'fork') {
    const applied = applyLevers(plan, input.scenario.levers, {
      annualIncome: input.derived.annualIncome,
    });
    plan = applied.plan;
    windfall = applied.windfall;
  }
  const events = outflowsApplied(input.lifeEvents, plan, lifeEventsForPlan(input.lifeEvents, plan));
  plan = {
    ...plan,
    otherIncome: [...plan.otherIncome, ...events.income],
    ...(events.oneOffs.length === 0 ? {} : { oneOffs: events.oneOffs }),
  };
  const cryptoHolding =
    input.derived.cryptoHolding !== undefined && Money.isPositive(input.derived.cryptoHolding)
      ? input.derived.cryptoHolding
      : null;

  const document = documentOf({
    schema: INPUT_DOCUMENT_SCHEMA,
    scenario: {
      id: input.scenario.id,
      kind: input.scenario.kind,
      levers: input.scenario.kind === 'fork' ? leversToJson(input.scenario.levers) : null,
    },
    method: input.method,
    paths: input.paths,
    balances: {
      asOfDate: input.derived.balances.asOfDate,
      revision: input.derived.balances.revision,
      sealed: input.derived.balances.sealed,
    },
    sources: base.sources,
    // WP 9.2: the holder's overlay on their accounts. Absent (not null) when they
    // have set none, so a run without overrides digests as it always did.
    accountOverrides: input.derived.accountOverrides,
    plan,
    lifeEvents: { applied: events.applied, unapplied: events.unapplied },
    windfall,
    // Absent (not null) when there is none, so a plan without crypto digests as it always did.
    crypto:
      cryptoHolding === null
        ? undefined
        : {
            holding: cryptoHolding,
            monteCarlo: 'own_sleeve',
            deterministic: 'valued_at_zero',
          },
  }) as Record<string, unknown>;
  return Object.freeze({ plan, cryptoHolding, document, digest: inputDigestOf(document) });
}

/**
 * WP 5.5: the stored outflows `lifeEventsForPlan` sets aside as
 * `outflow_not_modelled` become dated one-offs and move to `applied`.
 *
 * That reason is reached only after the currency, the plan's start and the
 * plan's end have all been checked (`oneTimeInflow`'s order), so every event it
 * names is a negative amount, in the plan's currency, inside the plan — exactly
 * what `toEnginePlan` accepts. Inflows stay one-year income streams, as before,
 * so no stored plan without an outflow changes by a byte.
 */
function outflowsApplied(
  lifeEvents: readonly LifeEvent[],
  plan: ProjectionPlan,
  partition: ReturnType<typeof lifeEventsForPlan>,
): ReturnType<typeof lifeEventsForPlan> & { readonly oneOffs: readonly OneOffPlan[] } {
  const byId = new Map(lifeEvents.map((event) => [event.id, event]));
  const oneOffs: OneOffPlan[] = [];
  const applied = [...partition.applied];
  const unapplied: (typeof partition.unapplied)[number][] = [];
  for (const entry of partition.unapplied) {
    const event = byId.get(entry.id);
    if (entry.reason !== 'outflow_not_modelled' || event === undefined) {
      unapplied.push(entry);
      continue;
    }
    oneOffs.push({
      name: `life_event:${event.id}`,
      occursOn: event.occursOn,
      amount: event.amount,
    });
    applied.push({ id: event.id, age: ageOn(plan.birthDate, event.occursOn) });
  }
  // Date order, as `lifeEventsForPlan` lists them: the digest must not depend on which kind came first.
  const order = (id: string) => {
    const event = byId.get(id);
    return event === undefined ? '' : `${event.occursOn}|${event.id}`;
  };
  applied.sort((a, b) => (order(a.id) < order(b.id) ? -1 : order(a.id) > order(b.id) ? 1 : 0));
  return Object.freeze({
    income: partition.income,
    applied: Object.freeze(applied),
    unapplied: Object.freeze(unapplied),
    oneOffs: Object.freeze(oneOffs),
  });
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ProjectionServiceDependencies {
  readonly inputs: ProjectionInputsReader;
  /** `null` until WP 4.5's worker host is bound; a Monte Carlo request is then refused by name. */
  readonly monteCarlo: MonteCarloRunner | null;
  readonly clock: Clock;
  /** The holder's IANA zone, for dating an override (WP 4.2's `resolveForUser`). */
  readonly timeZone: string;
  /** Assumption versions this build can resolve. Default: the checked-in file only. */
  readonly registry?: AssumptionsRegistry;
  /** The deterministic engine. Injectable so a test can count its calls. */
  readonly deterministic?: (plan: ProjectionPlan, assumptions: AssumptionsLike) => ProjectionResult;
}

export interface ProjectionRequest {
  readonly userId: string;
  readonly scenarioId: string;
  readonly method: ProjectionMethod;
  /** Monte Carlo only; default 10,000. A deterministic run is one path. */
  readonly paths?: number;
  /** The starting-balance day. Default: the newest sealed day. */
  readonly asOf?: DateOnlyType | null;
  readonly allowOpenDay?: boolean;
  /**
   * WP 9.2: the holder has seen that their account overrides changed since the
   * stored run and asks for a new one. Without it, a changed overlay returns the
   * stored run **stale** and computes nothing — never a silent recomputation.
   */
  readonly acceptAccountChanges?: boolean;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export type Staleness =
  | {
      /** The run's assumptions version is not one this build holds (WP 4.2's retired version). */
      readonly reason: 'assumptions_version_retired';
      readonly assumptionsVersion: string;
      readonly known: readonly string[];
    }
  | {
      /** The version still resolves, but the holder's current assumptions differ from the run's. */
      readonly reason: 'assumptions_changed';
      readonly assumptionsVersion: string;
      readonly currentVersion: string;
    }
  | {
      /**
       * WP 9.2: the holder changed an account's tax treatment, role or valuation
       * after this run was computed. `changes` names each field that differs.
       */
      readonly reason: 'account_overrides_changed';
      readonly changes: readonly OverrideChange[];
    };

export type ProjectionOutcome =
  | {
      /** Freshly computed, stored, and announced. */
      readonly status: 'computed';
      readonly run: StoredRun;
      readonly percentiles: readonly StoredPercentile[];
    }
  | {
      /** Served from `projection_runs`; no engine ran and nothing was announced. */
      readonly status: 'cached';
      readonly run: StoredRun;
      readonly percentiles: readonly StoredPercentile[];
    }
  | {
      /**
       * The holder's assumptions no longer resolve. The newest stored run of
       * the scenario (if any) is returned **as it was**, labelled — and
       * nothing is computed.
       */
      readonly status: 'stale';
      readonly run: StoredRun | null;
      readonly percentiles: readonly StoredPercentile[];
      readonly staleness: Staleness;
    };

async function scenarioAndBaseline(
  executor: PlanningExecutor,
  userId: string,
  scenarioId: string,
): Promise<{ readonly scenario: Scenario; readonly baseline: BaselineScenario }> {
  const scenario = await getScenario(executor, userId, scenarioId);
  if (scenario.kind === 'baseline') return { scenario, baseline: scenario };
  const baseline = await getScenario(executor, userId, scenario.baselineId);
  if (baseline.kind !== 'baseline') {
    throw new ProjectionRefused('planning.scenario_fork_of_fork', 'a fork must fork the baseline');
  }
  return { scenario, baseline };
}

function pathsFor(method: ProjectionMethod, requested: number | undefined): number {
  if (method === 'deterministic') return 1;
  const paths = requested ?? DEFAULT_MONTE_CARLO_PATHS;
  if (!Number.isInteger(paths) || paths < 2 || paths > MAX_STORED_PATHS) {
    throw new ProjectionRefused(
      'planning.projection_paths_invalid',
      `a Monte Carlo run is 2..${String(MAX_STORED_PATHS)} whole paths`,
    );
  }
  return paths;
}

const SIX_PLACES = /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/;

function mismatch(detail: string): ProjectionRefused {
  return new ProjectionRefused('planning.monte_carlo_outcome_mismatch', detail);
}

/** A runner's answer, checked against what it was asked before a byte of it is stored. */
function checkedOutcome(
  outcome: MonteCarloOutcome,
  asked: { readonly engineVersion: string; readonly seed: bigint; readonly paths: number },
  currency: string,
): MonteCarloOutcome {
  if (outcome.engineVersion !== asked.engineVersion) {
    throw mismatch(`asked engine ${asked.engineVersion}, answered by ${outcome.engineVersion}`);
  }
  if (outcome.seed !== asked.seed) {
    throw mismatch(`asked seed ${asked.seed.toString()}, answered seed ${outcome.seed.toString()}`);
  }
  if (outcome.paths !== asked.paths) {
    throw mismatch(`asked ${String(asked.paths)} paths, answered ${String(outcome.paths)}`);
  }
  if (!SIX_PLACES.test(outcome.successProbability)) {
    throw mismatch(`success probability ${outcome.successProbability} is not a decimal in [0, 1]`);
  }
  if (outcome.periods.length === 0) throw mismatch('no periods');
  for (const period of outcome.periods) {
    const bands = [
      period.p5,
      period.p10,
      period.p25,
      period.p50,
      period.p75,
      period.p90,
      period.p95,
    ];
    if (bands.some((band) => band.currency !== currency)) {
      throw mismatch(`period ${String(period.index)} is not in ${currency}`);
    }
    for (let i = 1; i < bands.length; i += 1) {
      if (Money.compare(bands[i - 1] as MoneyType, bands[i] as MoneyType) > 0) {
        throw mismatch(`period ${String(period.index)}'s percentiles are not ordered`);
      }
    }
  }
  return outcome;
}

function elapsedMs(clock: Clock, started: Date): number {
  return Math.max(0, clock.now().getTime() - started.getTime());
}

/**
 * Everything a computation needs, read and assembled — and nothing that holds
 * a connection. The output of `prepareProjection` when the answer is not
 * already known; the input to `computeProjection` and `storeProjection`.
 */
export interface PreparedProjection {
  readonly status: 'ready';
  readonly userId: string;
  readonly scenario: Scenario;
  readonly method: ProjectionMethod;
  readonly resolved: ResolvedAssumptions;
  readonly assumptionsOverrides: Readonly<Record<string, string>>;
  readonly engineVersion: string;
  readonly paths: number;
  readonly seed: bigint;
  readonly derived: DerivedInputs;
  readonly assembled: AssembledInput;
  readonly cacheKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** What the engine produced for one prepared projection. No Money here is stored yet. */
export interface ComputedProjection {
  readonly successProbability: string;
  readonly percentiles: readonly StoredPercentile[];
  readonly durationMs: number;
}

/**
 * The label a run computed on `assumptionsVersion` reads back with when no new
 * run may be computed on that version any more — it is not held at all, or it
 * is held only as a frozen predecessor (WP 5.5) — naming the version; `null`
 * when the version is one this build computes on. The one decision
 * `readProjection` and `prepareProjection` both make.
 */
export function retiredStaleness(
  assumptionsVersion: string,
  registry: AssumptionsRegistry = currentRegistry(),
): Staleness | null {
  if (registry.has(assumptionsVersion) && !isRetainedVersion(registry, assumptionsVersion)) {
    return null;
  }
  return {
    reason: 'assumptions_version_retired',
    assumptionsVersion,
    known: computableVersions(registry),
  };
}

function staleOutcome(
  run: StoredRun | null,
  percentiles: readonly StoredPercentile[],
  assumptionsVersion: string,
  registry: AssumptionsRegistry,
): ProjectionOutcome {
  return {
    status: 'stale',
    run,
    percentiles,
    staleness: retiredStaleness(assumptionsVersion, registry) ?? {
      // Reached only for a version the registry computes on but the resolver refused — which
      // `resolveOverrides` cannot do; kept total so the type needs no assertion.
      reason: 'assumptions_version_retired',
      assumptionsVersion,
      known: computableVersions(registry),
    },
  };
}

/**
 * Phase 1 — **read**. Resolve, assemble, digest and look the answer up. Returns
 * a finished outcome when there is nothing to compute (a cache hit, or a stale
 * answer), otherwise a `PreparedProjection`.
 */
export async function prepareProjection(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: ProjectionRequest,
): Promise<ProjectionOutcome | PreparedProjection> {
  const registry = dependencies.registry ?? currentRegistry();
  const { scenario, baseline } = await scenarioAndBaseline(
    executor,
    request.userId,
    request.scenarioId,
  );
  const staleRun = async (version: string) => {
    const run = await latestRunForScenario(executor, request.userId, scenario.id, request.method);
    return staleOutcome(
      run,
      run === null ? [] : await percentilesOf(executor, request.userId, run.id),
      version,
      registry,
    );
  };

  let resolved: ResolvedAssumptions;
  try {
    resolved = await resolveForUser(
      executor,
      { userId: request.userId, timeZone: dependencies.timeZone },
      registry,
    );
  } catch (error) {
    if (!(error instanceof UnknownAssumptionsVersion)) throw error;
    // Never re-resolve against today's defaults: that would drop the holder's
    // overrides without a word and present the result under the scenario's name.
    return staleRun(error.requested);
  }
  // WP 5.5: the holder's overrides name a *retained* predecessor. They resolve — the assumptions
  // screen shows them and a re-save carries them onto the current file — but no run is computed on
  // a superseded file: the scenario's latest run is served stale, with that version named.
  if (isRetainedVersion(registry, resolved.version)) return staleRun(resolved.version);

  const runner = request.method === 'monte_carlo' ? dependencies.monteCarlo : null;
  if (request.method === 'monte_carlo' && runner === null) {
    throw new ProjectionRefused(
      'planning.monte_carlo_unavailable',
      'no Monte Carlo engine is bound in this process (WP 4.5); the deterministic projection is ' +
        'available, and is never substituted silently',
    );
  }
  const engineVersion = runner === null ? ENGINE_VERSION : runner.engineVersion;
  const paths = pathsFor(request.method, request.paths);
  const seed = baseline.seed;

  const derived = await dependencies.inputs.derivedInputs({
    userId: request.userId,
    asOf: request.asOf ?? null,
    allowOpenDay: request.allowOpenDay ?? false,
  });
  const lifeEvents = await listLifeEvents(executor, request.userId);
  const assembled = assembleInput({
    scenario,
    baseline,
    derived,
    lifeEvents,
    method: request.method,
    paths,
  });
  const assumptionsOverrides = overridesOf(resolved);
  const cacheKey = cacheKeyOf({
    assumptionsVersion: resolved.version,
    assumptionsOverrides,
    engineVersion,
    seed,
    inputDigest: assembled.digest,
  });

  const hit = await findRunByCacheKey(executor, request.userId, cacheKey);
  if (hit !== null) {
    return {
      status: 'cached',
      run: hit,
      percentiles: await percentilesOf(executor, request.userId, hit.id),
    };
  }
  // WP 9.2: a cache miss because the holder's account overrides changed is not a
  // reason to compute behind their back. Serve the stored run, stale, naming the
  // fields — unless they have said they know (`acceptAccountChanges`).
  if (request.acceptAccountChanges !== true) {
    const latest = await latestRunForScenario(
      executor,
      request.userId,
      scenario.id,
      request.method,
    );
    if (latest !== null) {
      const changes = diffOverrideFingerprints(
        storedFingerprintOf(latest.input),
        derived.accountOverrides ?? null,
      );
      if (changes.length > 0) {
        return {
          status: 'stale',
          run: latest,
          percentiles: await percentilesOf(executor, request.userId, latest.id),
          staleness: { reason: 'account_overrides_changed', changes },
        };
      }
    }
  }
  return Object.freeze({
    status: 'ready',
    userId: request.userId,
    scenario,
    method: request.method,
    resolved,
    assumptionsOverrides,
    engineVersion,
    paths,
    seed,
    derived,
    assembled,
    cacheKey,
    correlationId: request.correlationId,
    causationId: request.causationId ?? null,
  });
}

/**
 * Phase 2 — **compute**. The engine, and nothing else: this function takes no
 * executor, so it cannot hold a transaction or a connection while it runs.
 */
export async function computeProjection(
  dependencies: Pick<ProjectionServiceDependencies, 'monteCarlo' | 'clock' | 'deterministic'>,
  prepared: PreparedProjection,
): Promise<ComputedProjection> {
  const started = dependencies.clock.now();
  const { assembled, resolved } = prepared;
  if (prepared.method === 'deterministic') {
    const result = (dependencies.deterministic ?? projectDeterministic)(assembled.plan, resolved);
    return {
      successProbability: result.success ? '1' : '0',
      percentiles: result.years.map((year) => ({
        index: year.index,
        age: year.age,
        calendarYear: year.calendarYear,
        p5: null,
        p10: null,
        p25: null,
        p50: year.endWealth,
        p75: null,
        p90: null,
        p95: null,
      })),
      durationMs: elapsedMs(dependencies.clock, started),
    };
  }
  const runner = dependencies.monteCarlo;
  if (runner === null || runner.engineVersion !== prepared.engineVersion) {
    throw new ProjectionRefused(
      'planning.monte_carlo_unavailable',
      'the Monte Carlo engine this projection was prepared for is not the one bound now',
    );
  }
  const outcome = checkedOutcome(
    await runner.run({
      plan: assembled.plan,
      assumptions: resolved,
      seed: prepared.seed,
      paths: prepared.paths,
      ...(assembled.cryptoHolding === null ? {} : { cryptoHolding: assembled.cryptoHolding }),
    }),
    { engineVersion: prepared.engineVersion, seed: prepared.seed, paths: prepared.paths },
    assembled.plan.currency,
  );
  return {
    successProbability: outcome.successProbability,
    percentiles: outcome.periods.map((period) => ({
      index: period.index,
      age: period.age,
      calendarYear: period.calendarYear,
      p5: period.p5,
      p10: period.p10,
      p25: period.p25,
      p50: period.p50,
      p75: period.p75,
      p90: period.p90,
      p95: period.p95,
    })),
    durationMs: elapsedMs(dependencies.clock, started),
  };
}

/**
 * Phase 3 — **write**. The run, its bands and `ProjectionCompleted` are one
 * fact: pass a transaction. `appendEvent` is last, so the ordering lock it
 * takes is held only for the insert. A concurrent identical run that landed
 * between phase 1 and here wins the cache key; its row is served and nothing
 * is announced.
 */
export async function storeProjection(
  executor: PlanningExecutor,
  dependencies: Pick<ProjectionServiceDependencies, 'clock'>,
  prepared: PreparedProjection,
  computed: ComputedProjection,
): Promise<ProjectionOutcome> {
  const { assembled, derived, scenario } = prepared;
  const stored = await insertRun(executor, {
    id: newId(),
    userId: prepared.userId,
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    method: prepared.method,
    cacheKey: prepared.cacheKey,
    seed: prepared.seed,
    engineVersion: prepared.engineVersion,
    assumptionsVersion: prepared.resolved.version,
    assumptionsOverrides: prepared.assumptionsOverrides,
    inputDigest: assembled.digest,
    input: assembled.document,
    paths: prepared.paths,
    asOfDate: derived.balances.asOfDate,
    balancesSealed: derived.balances.sealed,
    currency: assembled.plan.currency,
    successProbability: computed.successProbability,
    durationMs: computed.durationMs,
    percentiles: [...computed.percentiles],
    createdAt: dependencies.clock.now(),
  });
  if (!stored.inserted) {
    // A concurrent identical request won the key. Serve its row; announce nothing.
    return {
      status: 'cached',
      run: stored.run,
      percentiles: await percentilesOf(executor, prepared.userId, stored.run.id),
    };
  }

  const run = stored.run;
  await appendEvent(
    platformOf(executor),
    ProjectionCompleted.create(
      {
        runId: run.id,
        scenarioId: run.scenarioId,
        scenarioKind: run.scenarioKind,
        method: run.method,
        asOfDate: run.asOfDate,
        seed: run.seed.toString(),
        paths: run.paths,
        engineVersion: run.engineVersion,
        assumptionsVersion: run.assumptionsVersion,
        successProbability: run.successProbability,
        durationMs: run.durationMs,
      },
      {
        userId: prepared.userId,
        aggregateId: run.id,
        correlationId: prepared.correlationId,
        causationId: prepared.causationId,
      },
      dependencies.clock,
    ),
  );
  return {
    status: 'computed',
    run,
    percentiles: await percentilesOf(executor, prepared.userId, run.id),
  };
}

/**
 * Serve or compute one scenario's projection: `prepareProjection`, then
 * `computeProjection`, then `storeProjection`, over one executor — the routes'
 * shape. A caller that must not hold a transaction across the engine (the
 * nightly refresh, `jobs.ts`) runs the three phases itself.
 */
export async function runProjection(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: ProjectionRequest,
): Promise<ProjectionOutcome> {
  const prepared = await prepareProjection(executor, dependencies, request);
  if (prepared.status !== 'ready') return prepared;
  const computed = await computeProjection(dependencies, prepared);
  return storeProjection(executor, dependencies, prepared, computed);
}

/**
 * A stored run, exactly as stored, with its staleness named.
 *
 * Never recomputes. A run whose `assumptions_version` this build no longer
 * holds is `assumptions_version_retired`; one whose version resolves but whose
 * assumptions differ from the holder's current ones is `assumptions_changed`.
 */
export async function readProjection(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly runId: string;
    readonly timeZone: string;
    readonly registry?: AssumptionsRegistry;
    /**
     * WP 9.2: the holder's account overlay *now* (`null`: none set), compared
     * with the one the run recorded. Omitted, the overlay is not checked — the
     * two callers in `apps/api` both pass it.
     */
    readonly accountOverrides?: OverrideFingerprint;
  },
): Promise<{
  readonly run: StoredRun;
  readonly percentiles: readonly StoredPercentile[];
  readonly staleness: Staleness | null;
}> {
  const registry = input.registry ?? currentRegistry();
  const run = await findRun(executor, input.userId, input.runId);
  if (run === null) {
    throw new ProjectionRefused('planning.projection_not_found', `no projection ${input.runId}`);
  }
  const percentiles = await percentilesOf(executor, input.userId, run.id);
  // Not held at all, or held only as a frozen predecessor (WP 5.5): either way no run is computed
  // on it any more, and this one reads back stale with its version named.
  const retired = retiredStaleness(run.assumptionsVersion, registry);
  if (retired !== null) return { run, percentiles, staleness: retired };
  let current: { readonly version: string; readonly overrides: Readonly<Record<string, string>> };
  try {
    const resolved = await resolveForUser(
      executor,
      { userId: input.userId, timeZone: input.timeZone },
      registry,
    );
    current = { version: resolved.version, overrides: overridesOf(resolved) };
  } catch (error) {
    if (!(error instanceof UnknownAssumptionsVersion)) throw error;
    current = { version: error.requested, overrides: {} };
  }
  const same =
    current.version === run.assumptionsVersion &&
    configHash({ ...current.overrides }) === configHash({ ...run.assumptionsOverrides });
  if (!same) {
    return {
      run,
      percentiles,
      staleness: {
        reason: 'assumptions_changed',
        assumptionsVersion: run.assumptionsVersion,
        currentVersion: current.version,
      },
    };
  }
  // WP 9.2: the assumptions agree; does the overlay on the accounts?
  if (input.accountOverrides !== undefined) {
    const changes = diffOverrideFingerprints(
      storedFingerprintOf(run.input),
      input.accountOverrides,
    );
    if (changes.length > 0) {
      return { run, percentiles, staleness: { reason: 'account_overrides_changed', changes } };
    }
  }
  return { run, percentiles, staleness: null };
}

// ---------------------------------------------------------------------------
// Compare (D20: server-authoritative, common random numbers)
// ---------------------------------------------------------------------------

const RATIO_SCALE = 1_000_000n;

function ratioMicros(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * RATIO_SCALE + BigInt((fraction + '000000').slice(0, 6));
}

function microsToDecimal(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / RATIO_SCALE;
  const fraction = (magnitude % RATIO_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const text = fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative && text !== '0' ? `-${text}` : text;
}

function retirementDateOf(run: StoredRun): DateOnlyType {
  const plan = run.input['plan'] as { birthDate: string; retirementAge: string };
  return DateOnly.addYears(DateOnly.parse(plan.birthDate), Number.parseInt(plan.retirementAge, 10));
}

export interface ScenarioComparison {
  readonly a: ProjectionOutcome;
  readonly b: ProjectionOutcome;
  /** The one seed both runs used. Equal by construction (0022); asserted anyway. */
  readonly seed: bigint;
  /** b − a, a signed decimal string of probability (never a float). */
  readonly successProbabilityDelta: string;
  readonly retirementDate: { readonly a: DateOnlyType; readonly b: DateOnlyType };
  /** b − a in whole months: positive means b retires later. */
  readonly retirementDeltaMonths: number;
}

/**
 * Two scenarios, run (or served) under common random numbers, and the two
 * deltas the compare screen leads with: success probability and retirement
 * date. Both runs use the baseline's seed — there is no other seed a fork
 * could have — and the result carries it once, after checking both runs
 * recorded it.
 */
export async function compareScenarios(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: Omit<ProjectionRequest, 'scenarioId'> & {
    readonly scenarioA: string;
    readonly scenarioB: string;
  },
): Promise<ScenarioComparison> {
  const { scenarioA, scenarioB, ...shared } = request;
  const a = await runProjection(executor, dependencies, { ...shared, scenarioId: scenarioA });
  const b = await runProjection(executor, dependencies, { ...shared, scenarioId: scenarioB });
  if (a.run === null || b.run === null) {
    throw new ProjectionRefused(
      'planning.projection_assumptions_stale',
      'a compare needs both runs; one scenario has no run and its assumptions no longer resolve',
    );
  }
  if (a.run.seed !== b.run.seed) {
    throw new Error(
      `common random numbers violated: ${a.run.seed.toString()} ≠ ${b.run.seed.toString()}`,
    );
  }
  const dateA = retirementDateOf(a.run);
  const dateB = retirementDateOf(b.run);
  const months =
    (DateOnly.year(dateB) - DateOnly.year(dateA)) * 12 +
    (DateOnly.month(dateB) - DateOnly.month(dateA));
  return {
    a,
    b,
    seed: a.run.seed,
    successProbabilityDelta: microsToDecimal(
      ratioMicros(b.run.successProbability) - ratioMicros(a.run.successProbability),
    ),
    retirementDate: { a: dateA, b: dateB },
    retirementDeltaMonths: months,
  };
}

// ---------------------------------------------------------------------------
// The nightly baseline
// ---------------------------------------------------------------------------

export type RefreshOutcome = { readonly status: 'no_baseline' } | ProjectionOutcome;

/**
 * Phase 1 of the nightly refresh: find the baseline and prepare its run, the
 * method chosen exactly as `refreshBaseline` chooses it. `jobs.ts` runs this in
 * a read transaction, the engine outside any, and `storeProjection` in a write
 * transaction.
 */
export async function prepareBaselineRefresh(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: {
    readonly userId: string;
    readonly correlationId: string;
    readonly paths?: number;
  },
): Promise<RefreshOutcome | PreparedProjection> {
  const baseline = await getBaseline(executor, request.userId);
  if (baseline === null) return { status: 'no_baseline' };
  return prepareProjection(executor, dependencies, {
    userId: request.userId,
    scenarioId: baseline.id,
    method: dependencies.monteCarlo === null ? 'deterministic' : 'monte_carlo',
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    correlationId: request.correlationId,
  });
}

/**
 * Recompute (or re-serve) the baseline, and nothing else — the dispatch's rule
 * for `planning.projection_refresh`. A fork is recomputed when it is opened.
 * Monte Carlo when a runner is bound, deterministic otherwise; the run records
 * which, and neither is ever substituted for the other on the same request.
 */
export async function refreshBaseline(
  executor: PlanningExecutor,
  dependencies: ProjectionServiceDependencies,
  request: {
    readonly userId: string;
    readonly correlationId: string;
    readonly paths?: number;
  },
): Promise<RefreshOutcome> {
  const baseline = await getBaseline(executor, request.userId);
  if (baseline === null) return { status: 'no_baseline' };
  return runProjection(executor, dependencies, {
    userId: request.userId,
    scenarioId: baseline.id,
    method: dependencies.monteCarlo === null ? 'deterministic' : 'monte_carlo',
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    correlationId: request.correlationId,
  });
}

// ---------------------------------------------------------------------------
// Goal pace (07 R6)
// ---------------------------------------------------------------------------

/** What one evaluation reads. */
export interface GoalFacts {
  readonly goals: readonly Goal[];
  readonly contributions: ReadonlyMap<string, readonly ContributionPlan[]>;
  /** Live earmarks only. */
  readonly earmarks: readonly CashEarmark[];
  readonly balances: BalancesDay | null;
}

export type FundedSource = 'earmarks' | 'funding_accounts' | 'none';

export type GoalPaceVerdict =
  | {
      readonly goalId: string;
      readonly status: 'on_track' | 'off_track';
      readonly target: MoneyType;
      readonly funded: MoneyType;
      readonly fundedSource: FundedSource;
      /** Everything the goal's plans schedule after `asOf` and on or before the target date. */
      readonly plannedBeforeTarget: MoneyType;
      readonly monthsRemaining: number;
      /** funded / target, six places. May exceed 1. */
      readonly fundedRatio: string;
      /** The share of the target that must already be funded for the plan to arrive on time. */
      readonly requiredPace: string;
      /** R6's `${m}/mo`: what closes the gap by the date, rounded up to the minor unit. */
      readonly requiredMonthly: MoneyType;
      /** R6's `${c}`: what the plans schedule, per month, on average to the date. */
      readonly plannedMonthly: MoneyType;
      /** Funding accounts named by another active goal too, and so not counted here. */
      readonly sharedAccountIds: readonly string[];
    }
  | {
      readonly goalId: string;
      readonly status: 'not_evaluable';
      readonly reason: 'currency_mismatch';
    };

function roundHalfEvenDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice > denominator) return quotient + (numerator < 0n ? -1n : 1n);
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + (numerator < 0n ? -1n : 1n);
}

function ratio(numerator: bigint, denominator: bigint): string {
  return microsToDecimal(roundHalfEvenDivide(numerator * RATIO_SCALE, denominator));
}

/** Whole months from `from` to `to`, floored; zero when `to` is not after `from`. */
export function wholeMonthsBetween(from: DateOnlyType, to: DateOnlyType): number {
  if (!DateOnly.isAfter(to, from)) return 0;
  let months =
    (DateOnly.year(to) - DateOnly.year(from)) * 12 + DateOnly.month(to) - DateOnly.month(from);
  if (DateOnly.isAfter(DateOnly.addMonths(from, months), to)) months -= 1;
  return Math.max(0, months);
}

/**
 * 07 R6: *"any goal's funded ratio < required-by-date pace"*, made exact.
 *
 *   * **funded** — the goal's live earmarks (the holder's explicit "this cash
 *     is for that", WP 4.1) when it has any; otherwise the sealed balances of
 *     its funding accounts, **excluding** an account another active goal also
 *     names (counting it twice would put the same dollar in two goals; the
 *     excluded ids are reported); otherwise zero, said so.
 *   * **planned** — every contribution its plans schedule in the months after
 *     `asOf` up to the target date, each month at the plan's escalated
 *     per-cadence amount × periods ÷ 12, summed exactly and rounded once.
 *   * **required pace** = (target − planned) / target, clamped to [0, 1]: the
 *     share of the target that must already be in hand for the plan to arrive
 *     on the date. **Off track iff funded ratio < required pace**, which is
 *     funded + planned < target.
 *
 * Retirement goals are not evaluated here: whether retirement is on track is
 * the projection's success probability (R2), not a savings pace.
 */
export function evaluateGoalPace(facts: GoalFacts, asOf: DateOnlyType): readonly GoalPaceVerdict[] {
  const active = facts.goals.filter(
    (goal) => goal.status === 'active' && goal.kind !== 'retirement',
  );
  const namedBy = new Map<string, number>();
  for (const goal of active) {
    for (const accountId of new Set(goal.fundedFromAccountIds)) {
      namedBy.set(accountId, (namedBy.get(accountId) ?? 0) + 1);
    }
  }
  const verdicts: GoalPaceVerdict[] = [];
  for (const goal of [...active].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const code = goal.target.currency;
    const earmarks = facts.earmarks.filter(
      (earmark) => earmark.goalId === goal.id && earmark.releasedAt === null,
    );
    let funded = Money.zero(code);
    let fundedSource: FundedSource = 'none';
    const shared: string[] = [];
    if (earmarks.length > 0) {
      if (earmarks.some((earmark) => earmark.amount.currency !== code)) {
        verdicts.push({ goalId: goal.id, status: 'not_evaluable', reason: 'currency_mismatch' });
        continue;
      }
      funded = Money.sum(
        earmarks.map((earmark) => earmark.amount),
        code,
      );
      fundedSource = 'earmarks';
    } else if (goal.fundedFromAccountIds.length > 0 && facts.balances !== null) {
      if (facts.balances.baseCurrency !== code) {
        verdicts.push({ goalId: goal.id, status: 'not_evaluable', reason: 'currency_mismatch' });
        continue;
      }
      for (const accountId of [...new Set(goal.fundedFromAccountIds)].sort()) {
        if ((namedBy.get(accountId) ?? 0) > 1) {
          shared.push(accountId);
          continue;
        }
        const entry = facts.balances.breakdown.find((row) => row.accountId === accountId);
        if (entry === undefined || entry.side !== 'asset') continue;
        const balance = Money.of(BigInt(entry.baseMinor), code);
        if (Money.isPositive(balance)) funded = Money.add(funded, balance);
      }
      fundedSource = 'funding_accounts';
    }

    const monthsRemaining = wholeMonthsBetween(asOf, goal.targetDate);
    let plannedTwelfths = 0n;
    for (const plan of facts.contributions.get(goal.id) ?? []) {
      if (plan.amount.currency !== code) continue;
      for (let month = 1; month <= monthsRemaining; month += 1) {
        const amount = amountOn(plan, DateOnly.addMonths(asOf, month));
        if (amount !== null)
          plannedTwelfths += amount.minor * CADENCE_PERIODS_PER_YEAR[plan.cadence];
      }
    }
    const planned = Money.of(roundHalfEvenDivide(plannedTwelfths, 12n), code);
    const target = goal.target;
    const gap = Money.subtract(target, funded);
    const requiredPaceMinor = target.minor - planned.minor;
    const requiredPace =
      requiredPaceMinor <= 0n
        ? '0'
        : requiredPaceMinor >= target.minor
          ? '1'
          : ratio(requiredPaceMinor, target.minor);
    const requiredMonthly = !Money.isPositive(gap)
      ? Money.zero(code)
      : monthsRemaining === 0
        ? gap
        : Money.of((gap.minor + BigInt(monthsRemaining) - 1n) / BigInt(monthsRemaining), code);
    const plannedMonthly =
      monthsRemaining === 0
        ? Money.zero(code)
        : Money.of(roundHalfEvenDivide(planned.minor, BigInt(monthsRemaining)), code);
    verdicts.push({
      goalId: goal.id,
      status: funded.minor + planned.minor < target.minor ? 'off_track' : 'on_track',
      target,
      funded,
      fundedSource,
      plannedBeforeTarget: planned,
      monthsRemaining,
      fundedRatio: ratio(funded.minor, target.minor),
      requiredPace,
      requiredMonthly,
      plannedMonthly,
      sharedAccountIds: Object.freeze(shared),
    });
  }
  return Object.freeze(verdicts);
}

/** Where one evaluation claims its run and reads its facts. The real one is `goalEvaluationStoreOf`. */
export interface GoalEvaluationStore {
  /** `true` exactly once per run, ever. */
  claim(userId: string, runId: string): Promise<boolean>;
  facts(userId: string, asOf: DateOnlyType): Promise<GoalFacts>;
}

export function goalEvaluationStoreOf(
  executor: PlanningExecutor,
  clock: Clock,
): GoalEvaluationStore {
  return {
    claim: (userId, runId) => claimGoalEvaluation(executor, { userId, runId, clock }),
    async facts(userId, asOf) {
      const goals = await listGoals(executor, userId);
      const contributions = new Map<string, readonly ContributionPlan[]>();
      for (const goal of goals) {
        if (goal.status !== 'active' || goal.kind === 'retirement') continue;
        contributions.set(goal.id, await listContributions(executor, userId, goal.id));
      }
      return {
        goals,
        contributions,
        earmarks: await listEarmarks(executor, userId),
        balances: await balancesDay(executor, userId, asOf),
      };
    },
  };
}

export interface GoalEvaluationResult {
  /** `false`: this run was already evaluated; nothing was read and nothing emitted. */
  readonly claimed: boolean;
  readonly verdicts: readonly GoalPaceVerdict[];
  readonly emitted: number;
}

/**
 * One evaluation: claim the run, then evaluate, then emit. **The claim comes
 * first** — an evaluation that emitted and then tried to claim would have
 * already told Insights twice by the time it found out.
 */
export async function runGoalEvaluation(
  store: GoalEvaluationStore,
  outbox: Executor,
  input: {
    readonly userId: string;
    readonly runId: string;
    readonly asOf: DateOnlyType;
    readonly clock: Clock;
    readonly correlationId: string;
    readonly causationId: string | null;
  },
): Promise<GoalEvaluationResult> {
  if (!(await store.claim(input.userId, input.runId))) {
    return { claimed: false, verdicts: [], emitted: 0 };
  }
  const verdicts = evaluateGoalPace(await store.facts(input.userId, input.asOf), input.asOf);
  let emitted = 0;
  for (const verdict of verdicts) {
    if (verdict.status !== 'off_track') continue;
    await appendEvent(
      outbox,
      GoalOffTrack.create(
        {
          goalId: verdict.goalId,
          evaluationId: input.runId,
          asOfDate: input.asOf,
          fundedRatio: verdict.fundedRatio,
          requiredPace: verdict.requiredPace,
          monthsRemaining: verdict.monthsRemaining,
          fundedSource: verdict.fundedSource,
        },
        {
          userId: input.userId,
          aggregateId: verdict.goalId,
          correlationId: input.correlationId,
          causationId: input.causationId,
        },
        input.clock,
      ),
    );
    emitted += 1;
  }
  return { claimed: true, verdicts, emitted };
}

/** Bump the version (and replay from 0) if what an evaluation *means* changes. */
export const GOAL_PACE_CONSUMER_NAME = 'planning.goal_pace@v1';
export const GOAL_PACE_CONSUMED_EVENT_TYPES = ['planning.ProjectionCompleted'] as const;

/**
 * `planning.goal_pace@v1`: a baseline run completed, so evaluate goal pace
 * against its day. A fork's run is a what-if and evaluates nothing.
 *
 * `storeFor` / `outboxFor` hand it the pump's transaction (the composition
 * root's `assertDrizzleTransaction(context.tx)`), so the claim, the reads and
 * every `GoalOffTrack` land or roll back with the delivery receipt. The
 * in-table claim is what makes a *second* delivery harmless — a replay after a
 * version bump has no receipt to stop it.
 */
export function createGoalPaceConsumer(dependencies: {
  readonly storeFor: (context: ConsumerContext) => GoalEvaluationStore;
  readonly outboxFor: (context: ConsumerContext) => Executor;
}): RegisteredConsumer {
  return registerConsumer(
    GOAL_PACE_CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const { payload } = ProjectionCompleted.parse(event);
      if (payload.scenarioKind !== 'baseline') {
        context.logger.info(
          { consumer: GOAL_PACE_CONSUMER_NAME, runId: payload.runId },
          'a fork run evaluates no goals',
        );
        return;
      }
      const result = await runGoalEvaluation(
        dependencies.storeFor(context),
        dependencies.outboxFor(context),
        {
          userId: event.userId,
          runId: payload.runId,
          asOf: DateOnly.parse(payload.asOfDate),
          clock: context.clock,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
      context.logger.info(
        {
          consumer: GOAL_PACE_CONSUMER_NAME,
          runId: payload.runId,
          claimed: result.claimed,
          goalsEvaluated: result.verdicts.length,
          offTrack: result.emitted,
        },
        result.claimed
          ? 'evaluated goal pace against a baseline run'
          : 'this run was already evaluated; nothing emitted',
      );
    },
    { filter: [...GOAL_PACE_CONSUMED_EVENT_TYPES] },
  );
}
