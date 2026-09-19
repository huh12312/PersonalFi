// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * Same payload discipline as `@ctx/ledger`'s and `@ctx/categorization`'s: **ids
 * and counts, never rows.** A consumer that wants the envelopes re-reads them,
 * which is also how it gets whatever the user has changed since.
 *
 * ## Money in a payload is a decimal string
 *
 * The one deliberate exception to "no values in payloads" is the handful of
 * amounts a notification genuinely cannot be written without — a threshold
 * alert that says "you crossed 80% of something" is not a notification. Those
 * are carried as **decimal strings** (`'-125.40'`, `Money.formatAmount`) with
 * their currency beside them, never as JSON numbers, for the reason
 * `Money.toJSON` exists: a JSON number cannot hold a `bigint` safely and
 * `JSON.parse('12345678901234567890')` silently returns something else. This is
 * one of the `bigint` boundaries the evidence note enumerates, and the
 * conversion happens exactly once, at `.create(...)`.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

const uuid = z.uuid();
/** A plain decimal amount, `Money.formatAmount`'s output. Never a JSON number. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const BudgetPeriodOpened = defineEvent({
  type: 'budgeting.BudgetPeriodOpened',
  aggregateType: 'budget_period',
  description:
    'A budget period was created, with its half-open [startDate, endDate) bounds in the user zone. ' +
    'Carried because a period boundary is the moment several other contexts want to act — the ' +
    'insight engine re-runs its cash rules, the notification digest window resets — and none of ' +
    'them should be inferring "a month started" from a clock of their own. The bounds are dates, ' +
    'not instants, which is why a DST boundary is not an event anyone here has to handle.',
  schema: z.object({
    budgetId: uuid,
    periodId: uuid,
    kind: z.enum(['CALENDAR_MONTH', 'SEMIMONTHLY', 'BIWEEKLY', 'WEEKLY', 'CUSTOM']),
    startDate: isoDate,
    /** **Exclusive.** */
    endDate: isoDate,
    sequence: z.int(),
    lineCount: z.int().nonnegative(),
  }),
});

export const BudgetPeriodRolled = defineEvent({
  type: 'budgeting.BudgetPeriodRolled',
  aggregateType: 'budget_period',
  description:
    'A period closed and its envelopes carried into the next one. The two money figures are the ' +
    'conservation pair: `rolledOut` is what crossed the boundary and `absorbedByRta` is what the ' +
    'policy discarded, and `available = rolledOut + absorbedByRta` for every line is a CHECK on ' +
    '`rollovers`. A consumer that wants the per-line detail reads that table through this ' +
    "context's reader; the counts here are enough to decide whether to look.",
  schema: z.object({
    budgetId: uuid,
    fromPeriodId: uuid,
    toPeriodId: uuid,
    lineCount: z.int().nonnegative(),
    rolledOut: decimal,
    absorbedByRta: decimal,
    autoAssigned: decimal,
    currency,
  }),
});

export const BudgetLineAssigned = defineEvent({
  type: 'budgeting.BudgetLineAssigned',
  aggregateType: 'budget_line',
  description:
    'Money was assigned to an envelope, by the user or by auto-assign. `source` is the fact that ' +
    'matters to a UI: an assignment the system made on the user\'s behalf (07 §1.9 step 2) must be ' +
    'explainable and undoable, and one the user made must not be quietly re-decided by the next ' +
    'roll. The delta is carried as well as the new total so a running feed does not have to ' +
    'remember the previous value.',
  schema: z.object({
    budgetId: uuid,
    periodId: uuid,
    lineId: uuid,
    categoryId: uuid.nullable(),
    source: z.enum(['USER', 'AUTO', 'ROLLOVER_FIX']),
    delta: decimal,
    assigned: decimal,
    currency,
  }),
});

export const BudgetThresholdCrossed = defineEvent({
  type: 'budgeting.BudgetThresholdCrossed',
  aggregateType: 'budget_line',
  description:
    'An envelope crossed a spending threshold, or Ready to Assign went negative. Edge-triggered: ' +
    '`budget_alerts_state` holds a row once a threshold has been crossed and deletes it when a ' +
    'recompute puts the line back under, so this fires on the crossing and not on every sync page ' +
    'for the rest of the month. WP 2.4 coalesces notifications; it must not be coalescing away a ' +
    'storm this context should never have emitted. `OVERSPENT_CASH` and `OVERSPENT_CREDIT` are ' +
    'distinct because 07 §1.3 makes them different facts — cash has already left, credit has not.',
  schema: z.object({
    budgetId: uuid,
    periodId: uuid,
    lineId: uuid.nullable(),
    categoryId: uuid.nullable(),
    threshold: z.enum([
      'PCT_50',
      'PCT_80',
      'PCT_100',
      'OVERSPENT_CASH',
      'OVERSPENT_CREDIT',
      'RTA_NEGATIVE',
    ]),
    /** `spent / assigned` at the crossing, a decimal string. Null for RTA_NEGATIVE. */
    ratio: decimal.nullable(),
    available: decimal,
    currency,
  }),
});

export const ReadyToAssignChanged = defineEvent({
  type: 'budgeting.ReadyToAssignChanged',
  aggregateType: 'budget_period',
  description:
    'The "to be budgeted" number moved. Emitted on the change rather than on every recompute, so ' +
    'a nightly sync that shifts nothing is silent. It carries the amount because RTA *is* the ' +
    'fact — 07 §1.9 steps 3 and 4 turn its sign into the difference between an opportunity and ' +
    'the one hard alert in the whole budget — and because a consumer re-reading it would have to ' +
    'reach into this context to do so.',
  schema: z.object({
    budgetId: uuid,
    periodId: uuid,
    readyToAssign: decimal,
    previous: decimal,
    currency,
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const BUDGETING_EVENTS: readonly EventDefinition[] = Object.freeze([
  BudgetPeriodOpened,
  BudgetPeriodRolled,
  BudgetLineAssigned,
  BudgetThresholdCrossed,
  ReadyToAssignChanged,
]);
