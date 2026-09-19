// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * Same payload discipline as `@ctx/ledger`'s and `@ctx/categorization`'s: **ids
 * and counts, never rows**. A consumer that wants the series re-reads it
 * through this context's readers, which is also how it gets whatever the user
 * has confirmed, merged or rejected since.
 *
 * Two payloads carry a monetary figure and the exception is deliberate.
 * `PriceChangeDetected` and `DuplicateServiceDetected` exist so that
 * `@ctx/notifications` (WP 2.4) can decide whether a change is worth waking
 * somebody for, and that decision is a comparison against a threshold — a rule
 * that had to re-read the series to find out whether $0.30 or $180 was at stake
 * would re-read on every single event, which is the shape the payload
 * discipline exists to avoid, not an instance of it. The figure travels as
 * **minor units in a string** (docs/CONVENTIONS.md, "On the wire"), never as a
 * JSON number.
 *
 * ## Emission is edge-triggered, always
 *
 * Detection is a deterministic function of current state, so a consumer replay
 * re-derives the same streams and must not re-announce them. Every event below
 * is therefore emitted from a *transition* computed against what was already in
 * the database — a candidate row that did not exist, a status that moved, a
 * `price_change_events` row that inserted — and never from "the detector
 * mentioned it again". `test/db/idempotence.test.ts` asserts the consequence
 * (`'replaying the consumer twice produces identical rows'`), and the
 * `domain_events` count is part of what it compares.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

const uuid = z.uuid();
/** Minor units as a string. `bigint` and IEEE-754 both make a JSON number a liability. */
const minorUnits = z.string().regex(/^-?\d+$/);
const currency = z.string().length(3);

export const CandidateProposed = defineEvent({
  type: 'recurring.CandidateProposed',
  aggregateType: 'recurring_series',
  description:
    'The detector proposed a stream the user has never ruled on. Emitted once, when the candidate ' +
    'row is first written — not on every pass that re-detects the same stream, because a replay ' +
    'must not re-ask a question the user has already been asked. The cadence, type and confidence ' +
    'are carried because the UI badge and the alert budget both need them to rank the queue; the ' +
    'occurrences behind them are read through listCandidates().',
  schema: z.object({
    candidateId: uuid,
    seriesId: uuid,
    merchantId: uuid,
    cadence: z.string(),
    type: z.string(),
    confidence: z.number().min(0).max(1),
    occurrenceCount: z.int().nonnegative(),
  }),
});

export const SeriesConfirmed = defineEvent({
  type: 'recurring.SeriesConfirmed',
  aggregateType: 'recurring_series',
  description:
    'A series became one we are willing to forecast: a human confirmed it, or it cleared the ' +
    'auto-confirm bar. `source` distinguishes the two, and it matters — 04 §5.1 pins a ' +
    'user-confirmed series permanently against the detector, while an auto-confirmed one is still ' +
    'the detector\'s opinion and can be withdrawn. A merge emits this for the surviving series.',
  schema: z.object({
    seriesId: uuid,
    merchantId: uuid,
    candidateId: uuid.nullable(),
    source: z.enum(['user', 'auto', 'merge']),
    userConfirmed: z.boolean(),
  }),
});

export const SeriesLapsed = defineEvent({
  type: 'recurring.SeriesLapsed',
  aggregateType: 'recurring_series',
  description:
    "07 §2.8's dormancy ladder moved a series down a rung: AT_RISK, LIKELY_CANCELED or CANCELED. " +
    'Emitted on the transition only. Never to be rendered as "you cancelled X" — the ladder knows ' +
    'that charges stopped arriving and nothing more, so the honest phrasing is a question, and the ' +
    'two cases that make it worth asking are a forgotten annual renewal and a bill that silently ' +
    'failed on an expired card.',
  schema: z.object({
    seriesId: uuid,
    merchantId: uuid,
    status: z.enum(['AT_RISK', 'MIGRATED', 'LIKELY_CANCELED', 'CANCELED']),
    previousStatus: z.string(),
    missedPeriods: z.int().nonnegative(),
    lastSeen: z.string(),
  }),
});

export const PriceChangeDetected = defineEvent({
  type: 'recurring.PriceChangeDetected',
  aggregateType: 'recurring_series',
  description:
    'A two-sided changepoint (07 §2.6) was recorded for a series. Emitted when the ' +
    'price_change_events row is inserted, and again only if an unconfirmed change becomes ' +
    'confirmed — that second transition is a different fact and a notification rule is entitled to ' +
    'wait for it. `annualImpactMinor` is `delta × periodsPerYear`, in minor units as a string.',
  schema: z.object({
    priceChangeEventId: uuid,
    seriesId: uuid,
    merchantId: uuid,
    direction: z.enum(['INCREASE', 'DECREASE']),
    effectiveDate: z.string(),
    confirmed: z.boolean(),
    annualImpactMinor: minorUnits,
    currency,
  }),
});

export const DuplicateServiceDetected = defineEvent({
  type: 'recurring.DuplicateServiceDetected',
  aggregateType: 'recurring_series',
  description:
    'Two or more live series occupy one node of 07 §2.9\'s service taxonomy, or one merchant is ' +
    'billing twice. Emitted when the *membership of the group* changes, so adding a sixth streaming ' +
    'service says something and re-detecting the same five does not. `annualImpactMinor` is the sum ' +
    'of all but the cheapest — the amount a user would keep by consolidating, not the total spend.',
  schema: z.object({
    kind: z.enum(['SAME_SERVICE', 'CROSS_SERVICE']),
    node: z.string(),
    seriesIds: z.array(uuid),
    annualImpactMinor: minorUnits,
    currency,
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const RECURRING_EVENTS: readonly EventDefinition[] = Object.freeze([
  CandidateProposed,
  SeriesConfirmed,
  SeriesLapsed,
  PriceChangeDetected,
  DuplicateServiceDetected,
]);
