// SPDX-License-Identifier: MIT
/**
 * The reply format a hosted provider is sent (WP 10.6): `NARRATION_FORMAT`,
 * with exactly the keywords that provider's structured-output compiler
 * refuses taken out — nothing renamed, nothing added but an `items` the
 * compiler needs, nothing loosened that the validator does not hold anyway.
 *
 * **The format is a convenience, never a control** (`format.ts`'s header). A
 * hosted reply is wrapped by `reply.ts` and judged by `@ctx/insights`'
 * `validateResponse` exactly as a local one — the contract's own `maxLength`
 * on every string, `maxItems` on every array, the narration shape, the 1:1
 * match and the numerals check. So removing a keyword a vendor will not compile
 * removes nothing the product relies on; it only means the vendor's sampler is
 * not told about that bound, and a reply that breaks it is refused afterwards,
 * by name, as it would be from the local model.
 *
 * What each vendor documents (read 2026-10-15, recorded in the WP 10.6
 * evidence):
 *
 *   * **Anthropic** (Messages API `output_config.format`, `type: json_schema`):
 *     no `minLength`/`maxLength`, no array constraint beyond `minItems` 0 or
 *     1, `additionalProperties` must be `false`; `enum` of numbers and
 *     `type: null` are supported. So `maxLength` and `maxItems` go.
 *   * **OpenAI** (Chat Completions `response_format`, `type: json_schema`,
 *     `strict: true`): every property required, `additionalProperties: false`;
 *     string `pattern`/`format` supported and `maxLength` not listed; array
 *     `minItems`/`maxItems` supported. So `maxLength` goes.
 *   * **OpenRouter** forwards OpenAI's shape to the serving provider; it gets
 *     OpenAI's derivation.
 *
 * For all three, an array the narration must leave empty (`maxItems: 0`, no
 * `items` — derivations, proposed actions, caveats) gains `items: {type:
 * 'null'}`: no vendor documents an `items`-less array, and the validator still
 * refuses anything in it.
 *
 * `test/hosted-format.test.ts` pins the derivation: for each provider, putting
 * back the removed keywords (and taking out the added `items`) gives
 * `NARRATION_FORMAT` deep-equal — so the hosted schema cannot drift from the
 * pinned reply format by a single enum value.
 */
import { NARRATION_FORMAT } from './format.ts';

export const HOSTED_PROVIDERS = ['openai', 'openrouter', 'anthropic'] as const;
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number];

/** The keywords each provider's structured-output compiler refuses, and therefore does not get. */
export const STRIPPED_KEYWORDS: Readonly<Record<HostedProvider, readonly string[]>> = Object.freeze(
  {
    openai: Object.freeze(['maxLength']),
    openrouter: Object.freeze(['maxLength']),
    anthropic: Object.freeze(['maxLength', 'maxItems']),
  },
);

/** What an empty-by-contract array gains so a compiler has an `items` to read. */
export const EMPTY_ARRAY_ITEMS: Readonly<Record<string, unknown>> = Object.freeze({ type: 'null' });

function derive(node: unknown, stripped: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((entry) => derive(entry, stripped));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (stripped.has(key)) continue;
    // `properties` holds names, not keywords: a property called `maxLength`
    // would be data, so only its value is walked.
    out[key] =
      key === 'properties' && value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([name, child]) => [
              name,
              derive(child, stripped),
            ]),
          )
        : derive(value, stripped);
  }
  if (record['type'] === 'array' && record['maxItems'] === 0 && !('items' in record)) {
    out['items'] = { ...EMPTY_ARRAY_ITEMS };
  }
  return out;
}

/** The schema sent to `provider`, derived from `NARRATION_FORMAT` and from nothing else. */
export function hostedNarrationFormat(provider: HostedProvider): Readonly<Record<string, unknown>> {
  return derive(NARRATION_FORMAT, new Set(STRIPPED_KEYWORDS[provider])) as Readonly<
    Record<string, unknown>
  >;
}
