// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * Same payload discipline as `@ctx/ledger`'s, `@ctx/budgeting`'s and
 * `@ctx/recurring`'s: **ids and counts, never rows**. A consumer that wants the
 * insight re-reads it through `read.ts`, which is also how it gets whatever the
 * user has accepted, dismissed or snoozed since.
 *
 * The discipline earns its keep here more than anywhere else in the codebase.
 * An insight's body is advisor-authored prose about the user's money; putting
 * it in an event payload would copy it into `domain_events`, where it outlives
 * the review, outlives a dismissal, and is read by every consumer including
 * ones that only wanted to know a number changed. `InsightProposed` therefore
 * carries the id, the key, the severity and the impact — enough for
 * `@ctx/notifications` to decide whether this is worth waking somebody for —
 * and not one word of the finding itself.
 *
 * `impactAnnualizedMinor` is the one monetary figure that crosses, for exactly
 * the reason `@ctx/recurring`'s `PriceChangeDetected` carries one: a
 * notification rule's decision is a comparison against a threshold, and a rule
 * that had to re-read the insight to find out whether $3 or $400 was at stake
 * would re-read on every single event. It travels as **minor units in a
 * string**, never as a JSON number.
 *
 * ## Why the review events are three and not one
 *
 * `InsightAccepted` and `InsightDismissed` are the two outcomes anything
 * downstream will branch on — an acceptance may seed a rule draft, a dismissal
 * feeds the ranking's `dismiss_rate`. `InsightReviewed` carries the rest
 * (`snooze`, `reopen`) so that "the user answered" is still one subscribable
 * fact for an audit view, without forcing every consumer to learn four actions
 * to find the two it cares about.
 *
 * ## Emission is edge-triggered
 *
 * A nightly re-run of a finding that is still true *updates* its row, and
 * updating is not proposing. `InsightProposed` is emitted from the insert
 * branch of the upsert only, so replaying the consumer or running the schedule
 * twice re-derives the same rows and announces nothing — which is what keeps a
 * backfill from producing one notification per advisor per night per finding.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

const uuid = z.uuid();
/** Minor units as a string. `bigint` and IEEE-754 both make a JSON number a liability. */
const minorUnits = z.string().regex(/^-?\d+$/);
const currency = z.string().length(3);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const AdvisorRunStarted = defineEvent({
  type: 'insights.AdvisorRunStarted',
  aggregateType: 'advisor_run',
  description:
    'An advisor was invoked. Emitted after the kill switches allowed it and before the snapshot ' +
    'is built, so the pair (Started, Completed|Failed) brackets exactly the window in which this ' +
    "deployment had the user's data assembled in memory. A refused run emits nothing here — it " +
    'has an `advisor_runs` row with `status = refused` and never became a run.',
  schema: z.object({
    runId: uuid,
    advisorId: z.string(),
    advisorVersion: z.string(),
    kind: z.enum(['builtin', 'local_model', 'external']),
    trigger: z.enum(['schedule', 'event', 'manual', 'backfill']),
  }),
});

export const AdvisorRunCompleted = defineEvent({
  type: 'insights.AdvisorRunCompleted',
  aggregateType: 'advisor_run',
  description:
    'A run finished and its output was validated. `rejected` is the count the seven-step pipeline ' +
    'refused and is carried because it is the number that matters operationally: an advisor whose ' +
    'proposals are mostly unciteable is the failure mode 02-phase-2-dispatch.md §5 names, and it ' +
    'never throws. `emittedScopes` is what the snapshot actually contained, which is a subset of ' +
    'what was granted — a scope with no source behind it produces no key.',
  schema: z.object({
    runId: uuid,
    advisorId: z.string(),
    inputDigest: digest,
    proposed: z.int().nonnegative(),
    accepted: z.int().nonnegative(),
    rejected: z.int().nonnegative(),
    emittedScopes: z.array(z.string()),
    durationMs: z.int().nonnegative(),
  }),
});

export const AdvisorRunFailed = defineEvent({
  type: 'insights.AdvisorRunFailed',
  aggregateType: 'advisor_run',
  description:
    'A run did not produce usable output: a timeout, a transport error, or a response the ' +
    'envelope steps rejected outright. `quarantined` says whether this failure tripped the ' +
    'breaker (kill switch 3), which is the transition an operator wants to hear about rather ' +
    'than the individual failure.',
  schema: z.object({
    runId: uuid,
    advisorId: z.string(),
    errorCode: z.string(),
    consecutiveFailures: z.int().nonnegative(),
    quarantined: z.boolean(),
  }),
});

export const AdvisorRunCancelled = defineEvent({
  type: 'insights.AdvisorRunCancelled',
  aggregateType: 'advisor_run',
  description:
    'A run the switches allowed to start was stopped before it wrote anything (WP 5.1): a kill ' +
    'level flipped while the advisor was in flight (`stage: in_flight`, noticed by the run ' +
    'watcher within a second) or between its reply and the insert (`stage: write_barrier`, ' +
    'noticed under the row lock). `reason` names the broadest level that applied, in the ' +
    "refusal vocabulary plus `run_cancelled` (level 4, the holder's own cancel); `level` is that " +
    "reason's ladder level, null for the payload preview gate, which is not a level. Not a " +
    'failure: the breaker does not count it.',
  schema: z.object({
    runId: uuid,
    advisorId: z.string(),
    reason: z.enum([
      'advisors_disabled',
      'module_disabled',
      'kind_disabled',
      'advisor_disabled',
      'advisor_quarantined',
      'payload_not_approved',
      'run_cancelled',
    ]),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
    stage: z.enum(['in_flight', 'write_barrier']),
    durationMs: z.int().nonnegative(),
  }),
});

export const InsightProposed = defineEvent({
  type: 'insights.InsightProposed',
  aggregateType: 'insight',
  description:
    'A finding entered the review queue for the first time. Emitted from the insert branch of the ' +
    'upsert only: a nightly re-run of a finding that is still true refreshes the row and says ' +
    'nothing, so a backfill does not produce one notification per night per finding. The payload ' +
    'is ids, a severity and an impact — never the body, which is advisor-authored prose about the ' +
    "user's money and has no business outliving the review in `domain_events`.",
  schema: z.object({
    insightId: uuid,
    advisorId: z.string(),
    key: z.string(),
    period: z.string(),
    type: z.string(),
    severity: z.enum(['info', 'notable', 'warning', 'urgent']),
    confidence: z.number().min(0).max(1),
    impactAnnualizedMinor: minorUnits.nullable(),
    currency: currency.nullable(),
    evidenceCount: z.int().positive(),
  }),
});

export const InsightAccepted = defineEvent({
  type: 'insights.InsightAccepted',
  aggregateType: 'insight',
  description:
    'The user agreed with a finding. Distinct from the generic review event because it is the one ' +
    'outcome something downstream may act on — an accepted "you could rule this merchant into ' +
    'Groceries" is what seeds a rule draft. Accepting still acts on nothing by itself: the draft ' +
    'is a proposal too (08 §4.3).',
  schema: z.object({
    insightId: uuid,
    advisorId: z.string(),
    key: z.string(),
    type: z.string(),
  }),
});

export const InsightDismissed = defineEvent({
  type: 'insights.InsightDismissed',
  aggregateType: 'insight',
  description:
    'The user refused a finding, and the ladder moved. `dismissCount` and `permanent` are carried ' +
    "because they are the user's answer getting firmer — 30 days, then 90, then never — and " +
    "because WP 2.7's ranking discounts an advisor by its dismissal rate. A consumer that wants " +
    'to know *why* reads `insight_feedback.reason`; the event says that it happened.',
  schema: z.object({
    insightId: uuid,
    advisorId: z.string(),
    key: z.string(),
    type: z.string(),
    dismissCount: z.int().positive(),
    permanent: z.boolean(),
    suppressedUntil: z.string().nullable(),
  }),
});

export const InsightReviewed = defineEvent({
  type: 'insights.InsightReviewed',
  aggregateType: 'insight',
  description:
    'The user answered a proposal in a way that is neither acceptance nor refusal: a snooze ' +
    '("not now") or a reopen ("I take that back"). It exists so that "every proposal was ' +
    'answered" is one subscribable fact for an audit view, without making a consumer that cares ' +
    'only about acceptance learn four actions to find it.',
  schema: z.object({
    insightId: uuid,
    advisorId: z.string(),
    key: z.string(),
    action: z.enum(['snooze', 'reopen']),
    status: z.enum(['pending_review', 'accepted', 'dismissed', 'snoozed']),
    snoozeUntil: z.string().nullable(),
  }),
});

// WP 5.6 — the Weekly Advisory Brief (05-phase-5-dispatch.md §3, §4 item 5).
// Appended rather than inserted among the review events above: this file is
// shared with WP 5.3 this wave, and each package's own labelled block is how
// two agents editing it at once never collide on the same lines.

export const BriefPublished = defineEvent({
  type: 'insights.BriefPublished',
  aggregateType: 'advisory_brief',
  description:
    'A Weekly Advisory Brief was published for one ISO week. Emitted once per (user, iso_week) ' +
    "from the insert branch of publishWeeklyBrief's idempotent write, never on a tick that found " +
    'the week already published — so replaying the job or a schedule that ticks twice announces ' +
    'nothing twice, the same edge-triggered discipline InsightProposed keeps. The payload is ids ' +
    'and counts, never a headline or a dollar figure: a consumer that wants either re-reads the ' +
    'Brief, which is also how it sees whatever the holder has since accepted or dismissed. ' +
    '09 NOT-1/NOT-6: this is the one hook a notification renderer needs to deliver the Brief by a ' +
    'channel, which Phase 5 itself does not add (05 §6 Q3, default in-app only).',
  schema: z.object({
    briefId: uuid,
    isoWeek: z.string().regex(/^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/),
    rankedCount: z.int().nonnegative(),
    attentionCount: z.int().nonnegative(),
    nothingMaterial: z.boolean(),
    coldStart: z.boolean(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const INSIGHTS_EVENTS: readonly EventDefinition[] = Object.freeze([
  AdvisorRunStarted,
  AdvisorRunCompleted,
  AdvisorRunFailed,
  AdvisorRunCancelled,
  InsightProposed,
  InsightAccepted,
  InsightDismissed,
  InsightReviewed,
  BriefPublished,
]);
