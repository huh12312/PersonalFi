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

export const PLANNING_EVENTS: readonly EventDefinition[] = Object.freeze([
  NetWorthSnapshotTaken,
  GoalCreated,
  RiskProfileAnswered,
  AssumptionsOverridden,
]);
