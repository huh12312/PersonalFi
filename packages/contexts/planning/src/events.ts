// SPDX-License-Identifier: MIT
/**
 * Every fact `@ctx/planning` states. Today there is one.
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
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const PLANNING_EVENTS: readonly EventDefinition[] = Object.freeze([NetWorthSnapshotTaken]);
