// SPDX-License-Identifier: MIT
/**
 * Every fact `@ctx/planning` states.
 *
 * Same payload discipline as `@ctx/ledger`'s and `@ctx/recurring`'s: **ids and
 * counts, never rows**. A consumer that wants the breakdown re-reads it, which
 * is also how it gets whatever has been corrected since.
 *
 * One figure travels anyway — `netWorthMinor` — and the exception is the same
 * one `recurring.PriceChangeDetected` makes, for the same reason. The consumers
 * this event exists for are threshold rules ("you crossed $100k", "net worth
 * fell 5% this month"), and a rule that had to re-read the day to find out
 * whether the threshold was anywhere near would re-read on every single event,
 * which is the shape payload discipline exists to avoid rather than an instance
 * of it. It travels as **minor units in a string** (docs/CONVENTIONS.md, "On the
 * wire"), never as a JSON number — a net worth in cents passes 2^53 at about
 * $90 trillion, which is not the reason: the reason is that D3 does not get
 * suspended at the serialisation boundary, and the migration's own
 * `net_worth_breakdown_is_well_formed` applies the identical rule to the
 * breakdown.
 *
 * ## Emitted once per snapshot, sealed or not
 *
 * The event carries `sealed` rather than being two different events, because a
 * subscriber that cares about the difference can branch and one that does not
 * should not have to register twice. `revision` distinguishes a correction from
 * a first computation without a second event type either.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';
import { AssumptionsOverridden } from './assumptions.ts';

/** Minor units as a string. `bigint` and IEEE-754 both make a JSON number a liability. */
const minorUnits = z.string().regex(/^-?\d+$/);

export const NetWorthSnapshotTaken = defineEvent({
  type: 'planning.NetWorthSnapshotTaken',
  aggregateType: 'net_worth_day',
  description:
    'A day of net worth was computed and written. `sealed` says whether it is now history ' +
    '(08 §3.5: sealed at 02:00 local and never touched again) or still the open day. ' +
    '`revision` is 1 for a first computation and 2+ for a correction, which carries its own ' +
    'provenance on the row. `stalePrice` and `accountsUnvalued` travel because "net worth is ' +
    '$X" and "net worth is $X across 9 of 11 accounts on yesterday\'s prices" are different ' +
    'claims, and a notification rule must not make the first out of the second. The amount is ' +
    'minor units in a string, in `baseCurrency`; the breakdown is re-read, never carried.',
  schema: z.object({
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    revision: z.int().positive(),
    baseCurrency: z.string().length(3),
    netWorthMinor: minorUnits,
    source: z.enum(['observed', 'interpolated', 'corrected']),
    sealed: z.boolean(),
    stalePrice: z.boolean(),
    accountsCounted: z.int().nonnegative(),
    accountsUnvalued: z.int().nonnegative(),
  }),
});

/**
 * A goal was created (WP 4.1).
 *
 * Ids and counts, never the row: no target amount, no name, no account ids.
 * The consumers this exists for — WP 4.6's projection refresh and the Insights
 * goal rules — re-read the goal through Planning's reader under their own
 * scope, which is also how they see whatever has been edited since. The target
 * date and priority travel because "a new goal due within a year" is a routing
 * decision a consumer should not need a read to make; neither is a figure.
 */
export const GoalCreated = defineEvent({
  type: 'planning.GoalCreated',
  aggregateType: 'goal',
  description:
    'A goal was created. Carries the goal id, its kind, target date, priority and how many ' +
    'funding accounts it names — never the target amount, the name or the account ids, which a ' +
    'consumer re-reads through Planning under its own scope.',
  schema: z.object({
    goalId: z.uuid(),
    kind: z.enum(['retirement', 'emergency_fund', 'purchase', 'sabbatical', 'custom']),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    priority: z.int().min(1).max(5),
    fundingAccountCount: z.int().nonnegative(),
  }),
});

/**
 * The holder answered the risk questionnaire (WP 4.1).
 *
 * `tolerance` and `consistencyPenalty` travel because a notification that
 * "your answers disagreed, so your profile is more conservative than you
 * described" is the whole point of the penalty, and a consumer should not have
 * to re-read the row to know whether to say it. The tax-bracket band does
 * **not** travel: it is `risk.profile`-scoped data (sensitivity 4) and crosses
 * only through a granted snapshot, never through the event log.
 */
export const RiskProfileAnswered = defineEvent({
  type: 'planning.RiskProfileAnswered',
  aggregateType: 'risk_profile',
  description:
    'The risk questionnaire was answered and a tolerance derived. Carries the new row id, the ' +
    'instrument version, the derived tolerance and the consistency penalty (points withheld ' +
    'because two framings of one disposition disagreed). Never the answers, never the band.',
  schema: z.object({
    riskProfileId: z.uuid(),
    instrument: z.string().regex(/^risk-v\d+$/),
    tolerance: z.enum([
      'conservative',
      'moderate_conservative',
      'moderate',
      'moderate_aggressive',
      'aggressive',
    ]),
    consistencyPenalty: z.int().nonnegative(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
/**
 * WP 4.2's event. Defined with `defineEvent` in `src/assumptions.ts`, because
 * `saveOverrides` appends it in the same transaction as the row it announces;
 * re-exported here rather than defined twice, and registered in the list.
 */
export { AssumptionsOverridden };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A dimensionless ratio in [0, 1] as a decimal string — never a JSON number (D3, WP 4.8). */
const unitRatio = z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/);

/**
 * A projection was computed and stored (WP 4.6).
 *
 * Emitted **only when a run is freshly computed** — never when an identical
 * request is re-served from `projection_runs`. Re-announcing a cache hit is the
 * WP 3.2 defect one context over: a nightly refresh of an unchanged plan would
 * wake every consumer every night to tell it nothing. Ids, versions and one
 * ratio; never a balance, a percentile or a path. `successProbability` travels
 * because R2 ("success below 80%") is a threshold rule and a threshold rule
 * that had to re-read the run to see whether it was anywhere near would re-read
 * on every event — the `netWorthMinor` exception above, for the same reason,
 * and as a decimal string for the same reason.
 */
export const ProjectionCompleted = defineEvent({
  type: 'planning.ProjectionCompleted',
  aggregateType: 'projection_run',
  description:
    'A projection run was computed and stored. Carries the run and scenario ids, whether the ' +
    'scenario is the baseline or a fork, the method, the starting-balance day, the seed (a ' +
    'decimal string: it is an unsigned 64-bit integer), the path count, the engine and ' +
    'assumptions versions, the success probability as a decimal string and the duration. Never ' +
    'emitted for a request re-served from the cache. Balances and bands are re-read.',
  schema: z.object({
    runId: z.uuid(),
    scenarioId: z.uuid(),
    scenarioKind: z.enum(['baseline', 'fork']),
    method: z.enum(['deterministic', 'monte_carlo']),
    asOfDate: isoDate,
    seed: z.string().regex(/^\d{1,20}$/),
    paths: z.int().positive(),
    engineVersion: z.string().min(1).max(64),
    assumptionsVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    successProbability: unitRatio,
    durationMs: z.int().nonnegative(),
  }),
});

/**
 * A goal's funded ratio is below its required-by-date pace (07 R6, WP 4.6).
 *
 * **Once per evaluation, never once per delivery.** An evaluation is one
 * baseline run's `ProjectionCompleted`, and the evaluation claims that run
 * (`projection_runs.goals_evaluated_at`, stamped once) before it emits
 * anything — so a redelivered or replayed `ProjectionCompleted` finds the claim
 * taken and says nothing. That is the WP 3.2 re-delivery defect, not repeated.
 *
 * Ratios, not figures: the goal's target, its funded amount and the monthly
 * contribution R6's copy quotes are re-read through Planning under the
 * reader's own scope. `fundedSource` says what "funded" was measured from,
 * because "you have funded 0%" means something different when nothing was
 * earmarked.
 */
export const GoalOffTrack = defineEvent({
  type: 'planning.GoalOffTrack',
  aggregateType: 'goal',
  description:
    "A goal's funded ratio fell below its required-by-date pace (07 R6): what is funded today " +
    'plus every contribution the plan schedules before the target date does not reach the ' +
    'target. Emitted at most once per goal per evaluation (one baseline projection run), never ' +
    'once per delivery. Carries ratios and the months remaining, never an amount.',
  schema: z.object({
    goalId: z.uuid(),
    evaluationId: z.uuid(),
    asOfDate: isoDate,
    fundedRatio: z.string().regex(/^\d+(\.\d{1,6})?$/),
    requiredPace: unitRatio,
    monthsRemaining: z.int().nonnegative(),
    fundedSource: z.enum(['earmarks', 'funding_accounts', 'none']),
  }),
});

/**
 * The latest net worth crossed a round figure since the previous snapshot day (WP 10.13, V6).
 *
 * **Once per holder per milestone per direction, ever** — `net_worth_milestones`' unique index is the
 * idempotency boundary, and the event is appended only for a row the snapshotter's insert actually wrote
 * (a recomputed open day, a dip and a recovery, a replayed job all find the row taken and say nothing).
 * A jump across two milestones is two rows and two events. The milestone and the two figures travel as
 * minor units in strings, in `currency`: the consumer this exists for is the dashboard's one-line notice
 * ("You crossed $50,000 in net worth on Oct 3"), and the figure *is* the fact — the same exception
 * `NetWorthSnapshotTaken` makes for `netWorthMinor`. (The dispatch named it `networth.MilestoneCrossed`;
 * every Planning event is `planning.`-prefixed, which `phase3-registration.test.ts` asserts.)
 */
export const NetWorthMilestoneCrossed = defineEvent({
  type: 'planning.NetWorthMilestoneCrossed',
  aggregateType: 'net_worth_milestone',
  description:
    'The latest net worth crossed a round figure since the previous snapshot day: 10k, 25k, 50k, ' +
    '100k and every 100k after going up, or the zero line in either direction. Emitted at most once ' +
    'per holder per milestone per direction (net_worth_milestones is the boundary); a jump across ' +
    'two milestones emits two. Carries the milestone id, the milestone, the direction, the day and ' +
    'the two figures compared, as minor units in strings in `currency`.',
  schema: z.object({
    milestoneId: z.uuid(),
    milestoneMinor: minorUnits,
    direction: z.enum(['up', 'down']),
    currency: z.string().length(3),
    crossedOn: isoDate,
    previousMinor: minorUnits,
    latestMinor: minorUnits,
  }),
});

export const PLANNING_EVENTS: readonly EventDefinition[] = Object.freeze([
  NetWorthSnapshotTaken,
  GoalCreated,
  RiskProfileAnswered,
  AssumptionsOverridden,
  ProjectionCompleted,
  GoalOffTrack,
  NetWorthMilestoneCrossed,
]);
