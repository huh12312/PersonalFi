// SPDX-License-Identifier: MIT
/**
 * The rule language: conditions, actions, and the zod schemas that police them.
 *
 * 04 §5.2 calls rules "*the* power feature", and the reason they are a typed
 * schema rather than free-form JSON is that they are stored in a `jsonb` column
 * and read back months later by code that has changed in the meantime. A rule
 * that parsed when it was written and throws on the read path takes the whole
 * categorisation pass down with it, so every rule is validated on the way **in**
 * and re-validated on the way **out**, and a rule that fails the second check is
 * disabled and reported rather than allowed to crash a sync.
 *
 * ## Conditions
 *
 * `all` and `any`, never arbitrary nesting. Two levels covers every rule a user
 * has ever actually wanted ("payee contains X and amount is over Y", "payee is
 * any of these three"), and arbitrary nesting buys a rule builder UI that nobody
 * can use and a matcher nobody can read. An empty `all` with an empty `any` never
 * matches — a rule that matches everything is a footgun with no legitimate use.
 *
 * ## On user-supplied regular expressions
 *
 * `payee_regex` is a real ReDoS surface: it is a pattern the user wrote, compiled
 * in our process, run against strings on the sync path. Node has no regex
 * timeout, so the mitigations here are structural rather than a stopwatch:
 *
 *   * the pattern is capped at `MAX_PATTERN_LENGTH`;
 *   * the subject is capped at `MAX_SUBJECT_LENGTH` (a payee is short; a 40 KB
 *     descriptor is not a payee and matching it is not worth the risk);
 *   * patterns containing a quantified group that itself contains a quantifier —
 *     the `(a+)+` shape that produces exponential backtracking — are rejected at
 *     validation time with an error the user sees while they are still editing.
 *
 * That is a mitigation, not a proof. It is written down here rather than implied
 * so that a future reviewer can weigh it, and so nobody mistakes "we thought
 * about it" for "it cannot happen". The honest remaining answer, if this ever
 * matters more, is to run the match in a worker with a deadline.
 */
import { z } from 'zod';

export const MAX_PATTERN_LENGTH = 200;
export const MAX_SUBJECT_LENGTH = 512;

/** `(x+)+`, `(x*)*`, `(x+)*` — a quantified group wrapping a quantifier. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/u;

const safePattern = z
  .string()
  .min(1)
  .max(MAX_PATTERN_LENGTH)
  .refine((pattern) => !NESTED_QUANTIFIER.test(pattern), {
    message:
      'pattern contains a nested quantifier such as (a+)+, which can take exponential time to match',
  })
  .refine(
    (pattern) => {
      try {
        // Compiling *is* the validation: the constructor throws on a bad pattern
        // and the result is deliberately discarded.
        new RegExp(pattern, 'iu');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'pattern is not a valid regular expression' },
  );

const payeeMatch = z.enum(['contains', 'not_contains', 'starts_with', 'ends_with', 'equals']);

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payee'), match: payeeMatch, value: z.string().min(1).max(200) }),
  z.object({ type: z.literal('payee_regex'), pattern: safePattern }),
  z
    .object({
      type: z.literal('amount'),
      /**
       * Signed minor units, house convention: negative is an outflow. A
       * **string**, not a number, for the same reason money crosses the wire as
       * one — `bigint` does not survive `JSON.stringify` and IEEE-754 loses the
       * cents of a large amount.
       */
      minMinor: z
        .string()
        .regex(/^-?\d+$/u)
        .nullable(),
      maxMinor: z
        .string()
        .regex(/^-?\d+$/u)
        .nullable(),
      /** Compare |amount| instead, for "anything over $100 either way". */
      absolute: z.boolean().default(false),
    })
    /**
     * An inverted range matches nothing, ever, and looks like a working rule in
     * the list. This is the specific check `rules.ts`, `OWNERSHIP.md` and
     * migration 0006 all cite as the reason `conditions` is validated jsonb
     * rather than two child tables — no `CHECK` spread across `rule_conditions`
     * rows could see both bounds at once — so it had better actually exist.
     * Compared as `BigInt`, because these are minor units and `-9007199254740993`
     * is a legal one.
     */
    .refine(
      (condition) =>
        condition.minMinor === null ||
        condition.maxMinor === null ||
        BigInt(condition.minMinor) <= BigInt(condition.maxMinor),
      { message: 'the minimum amount is above the maximum, so this condition can never match' },
    ),
  z.object({ type: z.literal('direction'), direction: z.enum(['inflow', 'outflow']) }),
  z.object({ type: z.literal('account'), accountIds: z.array(z.uuid()).min(1).max(64) }),
  z.object({
    type: z.literal('day_of_month'),
    from: z.int().min(1).max(31),
    to: z.int().min(1).max(31),
  }),
  z.object({
    type: z.literal('provider_category'),
    codes: z.array(z.string().min(1).max(96)).min(1).max(64),
  }),
  z.object({ type: z.literal('currency'), currency: z.string().length(3) }),
  z.object({ type: z.literal('is_transfer'), value: z.boolean() }),
]);

export type RuleCondition = z.infer<typeof conditionSchema>;

export const conditionsSchema = z
  .object({
    all: z.array(conditionSchema).max(16).default([]),
    any: z.array(conditionSchema).max(16).default([]),
  })
  .refine((conditions) => conditions.all.length + conditions.any.length > 0, {
    message: 'a rule with no conditions would match every transaction',
  });

export type RuleConditions = z.infer<typeof conditionsSchema>;

/**
 * Actions.
 *
 * `split` is a placeholder on purpose: the shape is fixed now so a rule authored
 * in Phase 1 survives into Phase 2, and the engine refuses to apply it
 * (`applied: false`, with a reason) until the splits write path exists. A schema
 * that has to change to accommodate a feature is a migration of every stored
 * rule; a schema with an inert branch is a `TODO` the type system can see.
 *
 * `link_recurring` and `notify` moved from that same "inert" bucket into
 * `IMPLEMENTED_ACTIONS` in WP 2.5 (Phase 2 dispatch §2, "Rule actions beyond
 * `set_category`"), but "implemented" here means only *validated and recorded*:
 * `applyRule` accepts a rule carrying either action, matches it, and records
 * which of them fired on the `categorization.RuleApplied` event
 * (`actionsRecorded`) — but neither one does anything yet. There is no
 * `recurring_series` row for `link_recurring` to point at until WP 2.3 builds
 * one, and no channel for `notify` to send through until WP 2.4's
 * `NotificationChannel` exists. Moving them here now, inert, means a rule
 * authored today ("tag every Netflix charge and link it to my Netflix
 * subscription") is not silently dropped by validation and does not need a
 * second migration of every stored rule the day WP 2.3/2.4 land — only the
 * *engine* gains a side effect then, the *schema* does not change.
 */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_category'), categoryKey: z.string().min(1).max(64) }),
  z.object({ type: z.literal('set_merchant_name'), name: z.string().min(1).max(120) }),
  z.object({ type: z.literal('set_note'), note: z.string().max(500) }),
  z.object({ type: z.literal('add_tag'), tag: z.string().min(1).max(48) }),
  z.object({ type: z.literal('exclude') }),
  z.object({ type: z.literal('mark_transfer') }),
  z.object({
    type: z.literal('split'),
    parts: z
      .array(
        z.object({
          categoryKey: z.string().min(1).max(64),
          shareBasisPoints: z.int().min(1).max(10_000),
        }),
      )
      .min(2)
      .max(20),
  }),
  z.object({ type: z.literal('link_recurring'), seriesKey: z.string().min(1).max(120) }),
  /**
   * "Tell me when this rule fires." `message` is the user's own text, never
   * interpolated into a template server-side (WP 2.4's advice-copy lint is
   * about advisor prose, not this) — a channel, a rule and quiet hours all
   * belong to `@ctx/notifications` and none of that exists yet, hence inert.
   */
  z.object({ type: z.literal('notify'), message: z.string().min(1).max(240) }),
]);

export type RuleAction = z.infer<typeof actionSchema>;

export const actionsSchema = z.array(actionSchema).min(1).max(8);

/**
 * Actions the engine can actually *carry out or record* today. The rest
 * (`split`) are recorded on the rule but never run.
 *
 * `link_recurring` and `notify` are "validated but inert" (see the doc comment
 * above `actionSchema`): a rule carrying one is not rejected and `applyRule`
 * records that it fired, but nothing yet links a recurring series or delivers a
 * notification. WP 2.3 and WP 2.4 are the targets that turn "recorded" into
 * "done", and neither needs another schema change to get there.
 */
export const IMPLEMENTED_ACTIONS: ReadonlySet<RuleAction['type']> = new Set([
  'set_category',
  'set_merchant_name',
  'set_note',
  'add_tag',
  'exclude',
  'mark_transfer',
  'link_recurring',
  'notify',
]);

export const ruleSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string().min(1).max(120),
  /** Ascending. Lower number wins, matching 04 §5.2's "by ascending priority". */
  priority: z.int().min(0).max(10_000),
  enabled: z.boolean(),
  conditions: conditionsSchema,
  actions: actionsSchema,
  /** Evaluate during the sync consumer, as opposed to only on an explicit apply. */
  runOnSync: z.boolean(),
  /** Stop evaluating further rules once this one matches (04 §5.2). */
  stopProcessing: z.boolean(),
  /** The transaction a "always categorise X as Y" rule was created from, if any. */
  createdFromTransactionId: z.uuid().nullable(),
});

export type Rule = z.infer<typeof ruleSchema>;
