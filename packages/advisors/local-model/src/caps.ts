// SPDX-License-Identifier: MIT
/**
 * The contract's own length caps, enforced again before anything enters the
 * prompt (05-phase-5-dispatch.md §3 WP 5.2 part 2).
 *
 * A request reaching the adapter was built by `SnapshotBuilder` and parsed by
 * `AdvisorRequestSchema`, so every string is already within its cap. The
 * adapter enforces them a second time because it cannot import the schema
 * (`@ctx/insights` is denied to this layer, and `@core/contracts` exports only
 * the bundle index, not `advisor/v1/request.schema.json`) and because a
 * sanitiser that trusted its input's length would be one refactor away from a
 * prompt that overflows `num_ctx` — where Ollama silently drops the *front*
 * of the context, which is the system region.
 *
 * Keyed by the property a free-text string sits under (the array's property
 * for array items). **`test/caps.test.ts` reads the published
 * `request.schema.json` from disk and fails if this table disagrees with it,
 * or if the schema gains a free-text string field this table does not name**
 * — so a contract minor that adds one (1.5.0's findings, WP 5.3) turns this
 * suite red until the table follows.
 */

/** `maxLength` of every free-text (no `pattern`, no `enum`) string in `AdvisorRequest.snapshot`. */
export const FREE_TEXT_CAPS: Readonly<Record<string, number>> = Object.freeze({
  asset_class: 32,
  attribution: 320,
  attribution_url: 2048,
  cadence: 32,
  category_slug: 96,
  // Contract 1.4.0 (WP 5.7): `transactions.anomalies` rows and `fees.summary`
  // carry a fee type. The parity test caught this table lagging the schema
  // the moment 1.4.0 landed — exactly the drift it exists to catch.
  fee_type: 64,
  kind: 32,
  name: 96,
  period_kind: 32,
  status: 32,
  symbol: 16,
  symbols: 16,
  tax_bracket_band: 16,
  tolerance: 32,
  // Widest `type` site in the schema: contract 1.4.0's `fees.summary` rows
  // name a fee type up to 64 characters beside the 32-character account types.
  type: 64,
  units: 48,
});

/** `holdings_aggregate.account_type_mix`'s `propertyNames.maxLength`: the one record whose keys are data. */
export const RECORD_KEY_CAP = 32;

/**
 * Every other string: the widest `maxLength` anywhere in the request schema.
 * Pattern-constrained strings (dates, money, refs, digests) are far below it,
 * so this cap only ever bites on a field the table has not caught up with.
 */
export const DEFAULT_STRING_CAP = 2048;

export function capFor(field: string): number {
  return Object.hasOwn(FREE_TEXT_CAPS, field)
    ? (FREE_TEXT_CAPS[field] ?? DEFAULT_STRING_CAP)
    : DEFAULT_STRING_CAP;
}
