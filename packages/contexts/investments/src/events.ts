// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * WP 3.1 stated exactly one. WP 3.2 adds four — `HoldingsUpdated`,
 * `LotsUpdated`, `RealizedGainRecorded` and `PossibleWashSaleFlagged` — and WP
 * 3.4 `integrations.PricesUpdated`, which is not this context's.
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
 * A position changed. Ids and counts; re-read the rows through the reader.
 */
export const HoldingsUpdated = defineEvent({
  type: 'investments.HoldingsUpdated',
  aggregateType: 'account',
  description:
    'A sync landed new or changed positions for one account. Ids and counts only — the quantities ' +
    'and values are in `holdings`, and a consumer that wants them re-reads that table so it sees ' +
    'today’s numbers rather than the ones that were true when the event was written. ' +
    '`costBasisUnavailableCount` is on the payload rather than left to a query because it is the ' +
    'number that decides whether the UI may show an unrealised gain at all (04 §5.5), and a ' +
    'consumer should not have to discover that by joining.',
  schema: z.object({
    accountId: z.uuid(),
    securityIds: z.array(z.uuid()),
    addedCount: z.int().nonnegative(),
    updatedCount: z.int().nonnegative(),
    /** Positions whose basis nobody knows. Their gain reads `unavailable`, never zero. */
    costBasisUnavailableCount: z.int().nonnegative(),
    asOfDate: z.string(),
  }),
});

/**
 * Lots opened, closed or adjusted.
 *
 * Separate from `HoldingsUpdated` because they are different *kinds* of claim:
 * a holding is what the institution asserts, a lot is what we computed. A
 * consumer that wants tax numbers wants this one, and a consumer that wants a
 * balance wants the other; collapsing them would make every consumer wake for
 * both.
 */
export const LotsUpdated = defineEvent({
  type: 'investments.LotsUpdated',
  aggregateType: 'account',
  description:
    'Cost-basis lots for one account and security were opened, consumed, carried in from another ' +
    'wallet, or rewritten by a corporate action. Ids and counts. `estimatedBasisCount` travels ' +
    'in the payload for the same reason `costBasisUnavailableCount` does on HoldingsUpdated: an ' +
    'ESTIMATED lot obliges the UI to show a warning (07 §6.2) and a consumer must not have to ' +
    'infer that obligation.',
  schema: z.object({
    accountId: z.uuid(),
    securityId: z.uuid(),
    openedLotIds: z.array(z.uuid()),
    closedLotIds: z.array(z.uuid()),
    adjustedLotIds: z.array(z.uuid()),
    /** Lots whose basis is a guess. Each carries a visible warning. */
    estimatedBasisCount: z.int().nonnegative(),
  }),
});

/**
 * A disposal was matched and the gain split into short- and long-term.
 *
 * The one event here whose payload carries numbers, and the reason is the same
 * one `SecurityResolutionFailed` gives: the interesting case is the one where
 * there is nothing to re-read. A gain that could not be computed leaves no row
 * saying so, and `shortTermStatus`/`longTermStatus` are how a consumer learns
 * that the answer is `unavailable` rather than zero. The amounts are decimal
 * strings of minor units, never JSON numbers.
 */
export const RealizedGainRecorded = defineEvent({
  type: 'investments.RealizedGainRecorded',
  aggregateType: 'account',
  description:
    'A sale or other disposal was matched against lots. Carries the short-term and long-term ' +
    'results as a status plus an optional amount, never a bare number: an unknown basis makes the ' +
    'term `unavailable`, and 04 §5.5 forbids reporting that as a gain from a zero basis. Minor ' +
    'units travel as decimal strings because a JSON number cannot hold a bigint.',
  schema: z.object({
    accountId: z.uuid(),
    securityId: z.uuid(),
    transactionId: z.uuid(),
    disposalDate: z.string(),
    method: z.string(),
    matchedLotIds: z.array(z.uuid()),
    currency: z.string().length(3),
    shortTermStatus: z.enum(['available', 'unavailable']),
    shortTermMinor: z.string().nullable(),
    longTermStatus: z.enum(['available', 'unavailable']),
    longTermMinor: z.string().nullable(),
    proceedsMinor: z.string(),
    feesMinor: z.string(),
  }),
});

/**
 * A loss was replaced inside the 61-day window.
 *
 * `label` is on the payload as a literal rather than implied by the event type,
 * so that a consumer rendering it cannot shorten it: 07 §4.4 requires
 * `POSSIBLE_WASH_SALE` and forbids `WASH_SALE`, because "substantially
 * identical" is facts-and-circumstances and we are warning, not determining.
 */
export const PossibleWashSaleFlagged = defineEvent({
  type: 'investments.PossibleWashSaleFlagged',
  aggregateType: 'account',
  description:
    'A loss-making disposal has a replacement purchase inside the 61-day window (30 days either ' +
    'side of the sale, the sale date included), scanned across every account including IRAs. A ' +
    'warning, never a determination: the label is POSSIBLE_WASH_SALE and the payload pins it. ' +
    '`basisAdjustmentIsPermanentlyLost` is true when the replacement sits in a retirement ' +
    'account, where Rev. Rul. 2008-5 leaves the disallowed loss nowhere to go.',
  schema: z.object({
    label: z.literal('POSSIBLE_WASH_SALE'),
    securityId: z.uuid(),
    disposalAccountId: z.uuid(),
    replacementAccountId: z.uuid(),
    replacementLotId: z.uuid(),
    saleDate: z.string(),
    replacementDate: z.string(),
    /** Signed days from sale to replacement; negative means bought first. */
    offsetDays: z.int(),
    disallowedLossMinor: z.string(),
    currency: z.string().length(3),
    tackedHoldingPeriodStartDate: z.string(),
    basisAdjustmentIsPermanentlyLost: z.boolean(),
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
  HoldingsUpdated,
  LotsUpdated,
  RealizedGainRecorded,
  PossibleWashSaleFlagged,
]);
