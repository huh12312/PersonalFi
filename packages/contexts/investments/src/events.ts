// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * WP 3.1 states exactly one. WP 3.2 adds `investments.HoldingsUpdated` and
 * WP 3.4 `integrations.PricesUpdated`; both are listed in 08 §1.3 #7 and
 * neither is this work package's to write.
 *
 * ## The payload discipline, and the one place this event departs from it
 *
 * Every other context here carries **ids and counts, never rows**: a consumer
 * that wants the data re-reads it through the published reader, which is also
 * how it picks up whatever changed in between.
 *
 * `SecurityResolutionFailed` cannot do that, and the reason is the whole point
 * of the event. It fires precisely when **no row was written** — the resolver
 * abstained, and 07's rule that an unresolved thing must "fail loudly rather
 * than mint a row" means there is no `security_id` to hand anybody. An event
 * carrying only a count would tell a consumer that something went wrong and
 * give it no way at all to find out what, which is how a silent data gap
 * becomes a permanent one. So the payload carries the identifiers as the
 * provider spelled them, and the abstain reason per tier.
 *
 * What it does **not** carry: the provider's raw payload, any account id, and
 * any quantity or amount. A resolution failure is about a *name*, and the
 * holding it came from is the caller's to log.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';
import { ABSTAIN_REASONS, IDENTIFIER_KINDS } from './identifiers.ts';

/**
 * One name, as the provider spelled it — before normalisation, deliberately.
 *
 * A malformed CUSIP is one of the reasons resolution fails, and normalising it
 * out of the payload would hide the only thing that would let somebody fix it.
 */
const identifierSchema = z.object({
  kind: z.enum(IDENTIFIER_KINDS),
  value: z.string(),
  chain: z.string().nullable(),
  mic: z.string().nullable(),
});

const abstentionSchema = z.object({
  tier: z.enum(IDENTIFIER_KINDS),
  reason: z.enum(ABSTAIN_REASONS),
  detail: z.string().nullable(),
});

export const SecurityResolutionFailed = defineEvent({
  type: 'investments.SecurityResolutionFailed',
  aggregateType: 'security',
  description:
    'A provider named a security and no tier could turn that name into an identity, so no ' +
    'securities row was written. The identifiers and the per-tier abstain reason travel in the ' +
    'payload because there is no row to re-read — that is what makes this event the only record ' +
    'that the holding exists at all. Emitted once per resolution attempt; a re-sync that fails the ' +
    'same way emits again, because the second failure is a second observation and suppressing it ' +
    'would make a permanent gap look like a transient one.',
  schema: z.object({
    /** Which connector was talking. Never `null`: an anonymous failure is unactionable. */
    provider: z.string().min(1),
    /** The provider's own opaque id, when it had one. Evidence; never an identity. */
    providerSecurityId: z.string().nullable(),
    /** What the provider called it. May be empty — that is itself the failure. */
    identifiers: z.array(identifierSchema),
    /** One entry per tier that could not answer, with why. */
    abstentions: z.array(abstentionSchema).min(1),
    /** The provider's display name, so the user can recognise the position. */
    name: z.string().nullable(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const INVESTMENTS_EVENTS: readonly EventDefinition[] = Object.freeze([
  SecurityResolutionFailed,
]);
