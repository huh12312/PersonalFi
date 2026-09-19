// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * Same payload discipline as `@ctx/ledger`'s: **ids and counts, never rows.** A
 * consumer that wants the assignments re-reads them, which is also how it gets
 * whatever the user has changed since. Budgeting actuals, the spending report and
 * the review-queue badge all hang off `AssignmentsChanged`, and none of them
 * wants a snapshot that was true when the event was written.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

const uuid = z.uuid();

export const AssignmentsChanged = defineEvent({
  type: 'categorization.AssignmentsChanged',
  aggregateType: 'transaction',
  description:
    'One or more transactions were categorised or recategorised. Carries the transaction ids and a ' +
    'per-source breakdown, because the two questions a consumer asks are "which rows must I ' +
    'recompute?" and "how much of this was guessed?" — the second is what a budget needs in order ' +
    'to show an honest confidence, and re-reading every row to count sources would make a cheap ' +
    'question expensive. The categories themselves are not in the payload: a consumer that needs ' +
    'them reads them through listAssignments().',
  schema: z.object({
    transactionIds: z.array(uuid),
    count: z.int().nonnegative(),
    /** How many of `count` came from each tier. Keys are `AssignmentSource` values. */
    bySource: z.record(z.string(), z.int().nonnegative()),
    /** Why this batch ran, so a replay can tell a sync apart from a rule change. */
    trigger: z.enum(['sync', 'rule_apply', 'confirm', 'backfill', 'model_retrain']),
    /** Present when `trigger` is `rule_apply`. */
    ruleId: uuid.nullable(),
  }),
});

export const RuleApplied = defineEvent({
  type: 'categorization.RuleApplied',
  aggregateType: 'rule',
  description:
    'A rule was run against existing transactions. Separate from AssignmentsChanged because the ' +
    'interesting fact here is about the *rule* — a retroactive apply that changed 900 rows is ' +
    'something a notification should mention and an audit trail should hold — while ' +
    'AssignmentsChanged is about the transactions. A preview never emits this: nothing happened.',
  schema: z.object({
    ruleId: uuid,
    runId: uuid,
    retroactive: z.boolean(),
    matchedCount: z.int().nonnegative(),
    changedCount: z.int().nonnegative(),
    /**
     * Which of this rule's non-`set_category` actions are in `IMPLEMENTED_ACTIONS`
     * (WP 2.5). Present so a `link_recurring`/`notify` action is at least visible
     * on the audit trail today, before WP 2.3/2.4 give either one a real target —
     * "validated but inert" (`rules/schema.ts`) means recorded here, not silent.
     * Empty for a rule with no such action, and always empty for a preview.
     */
    actionsRecorded: z.array(z.string()).default([]),
  }),
});

export const MerchantDefaultLearned = defineEvent({
  type: 'categorization.MerchantDefaultLearned',
  aggregateType: 'merchant',
  description:
    'Enough confirmations accumulated for a merchant that its category is now applied automatically ' +
    "(04 §5.2's merchant memory). Emitted at the moment the threshold is crossed, not on every " +
    'confirmation, because the fact worth reacting to is "this merchant became automatic" — that is ' +
    'what the UI tells the user about, and telling them once is the difference between the app ' +
    'feeling like it learned and the app feeling like it nags.',
  schema: z.object({
    merchantProfileId: uuid,
    ledgerMerchantId: uuid,
    categoryId: uuid,
    supportCount: z.int().nonnegative(),
    locked: z.boolean(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather than
 * as an error.
 */
export const CATEGORIZATION_EVENTS: readonly EventDefinition[] = Object.freeze([
  AssignmentsChanged,
  RuleApplied,
  MerchantDefaultLearned,
]);
