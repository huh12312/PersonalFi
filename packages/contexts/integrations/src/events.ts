// SPDX-License-Identifier: MIT
/**
 * The two facts the market-data refresh states.
 *
 * 03-phase-3-dispatch.md §3, WP 3.4: *"Emits `integrations.PricesUpdated`,
 * `integrations.PriceSourceUnavailable`. Schedule `integrations.price_refresh`
 * at 03:45 local (08 §3.7)."*
 *
 * ## Why unavailability is its own event
 *
 * A refresh that reaches nothing and a refresh that wrote zero rows because
 * nothing moved are the same shape from the outside and completely different
 * facts. Folding them together would mean the only way to notice that a key
 * expired, a budget was spent, or the egress guard refused something is to
 * notice the *absence* of price movement — which nobody notices.
 *
 * So `PriceSourceUnavailable` fires once per source per run that could not
 * answer, and it carries the reason as a closed vocabulary rather than a
 * message, because `skipped_no_key` (a configuration state — §6: "Phase 3
 * completes with zero keys") and `refused` (the egress guard said no, which is
 * a security event) demand completely different responses and a string would
 * make telling them apart a regex.
 *
 * ## No payload carries a price
 *
 * Ids and counts, like every other context here. A consumer that wants the
 * numbers re-reads them through `@ctx/investments`' `PriceReader`, which also
 * applies 07 §6.1's ladder and the 24-hour staleness rule — neither of which an
 * event payload could carry correctly, because staleness is a statement about
 * the moment of *reading*, not the moment of writing.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';
import { MARKET_DATA_PROVIDERS } from '../schema/index.ts';

/**
 * Why a source could not answer.
 *
 * Mirrors `SourceOutcome`'s failure arms exactly, minus `ok` and `no_data` —
 * a provider that answered "no close on a bank holiday" is working correctly
 * and is not unavailable.
 */
export const PRICE_SOURCE_UNAVAILABLE_REASONS = [
  'skipped_no_key',
  'rate_limited',
  'refused',
  'error',
] as const;
export type PriceSourceUnavailableReason = (typeof PRICE_SOURCE_UNAVAILABLE_REASONS)[number];

export const PricesUpdated = defineEvent({
  type: 'integrations.PricesUpdated',
  aggregateType: 'user',
  description:
    'A market-data refresh finished and wrote price and/or FX rows. Ids and counts only: the ' +
    'closes are in `prices` and a consumer re-reads them through PriceReader, which applies 07 ' +
    "6.1's ladder and the 24-hour staleness rule. Staleness in particular cannot travel in a " +
    'payload — it is a statement about the clock at read time, so an event that carried it would ' +
    'be wrong by the time anybody handled it. Fires even when zero rows changed, because "the ' +
    'refresh ran and nothing moved" is a fact a scheduler and a settings screen both need.',
  schema: z.object({
    /** The business date the refresh was for, `YYYY-MM-DD` at UTC 00:00 (07 §6.1). */
    asOfDate: z.string(),
    /** Securities whose price row was written or updated. */
    securityIds: z.array(z.uuid()),
    priceRowsWritten: z.int().nonnegative(),
    fxRowsWritten: z.int().nonnegative(),
    /** Securities the ladder could not price at all this run. */
    securitiesUnpricedCount: z.int().nonnegative(),
    /** Providers that contributed at least one row, for the attribution surface. */
    providers: z.array(z.enum(MARKET_DATA_PROVIDERS)),
  }),
});

export const PriceSourceUnavailable = defineEvent({
  type: 'integrations.PriceSourceUnavailable',
  aggregateType: 'user',
  description:
    'One market-data provider could not answer during a refresh. Separate from PricesUpdated ' +
    'because a run that reached nothing and a run where nothing moved look identical from the ' +
    'outside and are completely different facts. The reason is a closed vocabulary rather than a ' +
    'message: `skipped_no_key` is a configuration state (dispatch §6 — an install with no key is ' +
    'configured that way, not broken), while `refused` is the egress guard stopping an outbound ' +
    'call and is a security event. `detail` is redacted before it is written — a provider that ' +
    "echoes the query string back would otherwise carry FRED's API key into the outbox.",
  schema: z.object({
    provider: z.enum(MARKET_DATA_PROVIDERS),
    reason: z.enum(PRICE_SOURCE_UNAVAILABLE_REASONS),
    /** Redacted. Never a URL, never a raw provider body. */
    detail: z.string(),
    /** Present for `rate_limited`: when the client's own budget frees up. */
    retryAfterMs: z.int().nonnegative().nullable(),
    /** `@core/platform`'s `RefusalCode`, present for `refused`. */
    refusalCode: z.string().nullable(),
    asOfDate: z.string(),
  }),
});

export const INTEGRATIONS_EVENTS: readonly EventDefinition[] = Object.freeze([
  PricesUpdated,
  PriceSourceUnavailable,
]);
