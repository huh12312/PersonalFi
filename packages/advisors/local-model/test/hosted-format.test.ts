// SPDX-License-Identifier: MIT
/**
 * WP 10.6 — the reply-format pin, applied to every hosted provider. Each
 * vendor's schema is `NARRATION_FORMAT` minus exactly the keywords that vendor
 * documents it will not compile (plus an `items` on an empty-by-contract
 * array). Putting them back must give `NARRATION_FORMAT` deep-equal: a hosted
 * schema cannot drift from the pinned reply format by a single enum value.
 */
import { describe, expect, it } from 'vitest';
import { NARRATION_FORMAT } from '../src/format.ts';
import {
  EMPTY_ARRAY_ITEMS,
  HOSTED_PROVIDERS,
  hostedNarrationFormat,
  STRIPPED_KEYWORDS,
} from '../src/hosted-format.ts';

/** Every keyword path in `NARRATION_FORMAT` that a provider strips, with its value. */
function strippedPaths(
  node: unknown,
  stripped: ReadonlySet<string>,
  path = '',
): [string, unknown][] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (stripped.has(key) && !path.endsWith('.properties')) out.push([`${path}.${key}`, value]);
    out.push(...strippedPaths(value, stripped, `${path}.${key}`));
  }
  return out;
}

function restore(derived: unknown, original: unknown): unknown {
  if (derived === null || typeof derived !== 'object' || Array.isArray(derived)) return derived;
  const d = derived as Record<string, unknown>;
  const o = (original ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(d)) {
    if (key === 'items' && !('items' in o)) {
      expect(value).toEqual(EMPTY_ARRAY_ITEMS);
      expect(o['maxItems']).toBe(0);
      continue;
    }
    out[key] = restore(value, o[key]);
  }
  for (const [key, value] of Object.entries(o)) {
    if (!(key in d)) out[key] = value;
  }
  return out;
}

describe.each(HOSTED_PROVIDERS)('the %s reply format', (provider) => {
  it('is NARRATION_FORMAT minus exactly the documented keywords, and nothing else differs', () => {
    const derived = hostedNarrationFormat(provider);
    const stripped = new Set(STRIPPED_KEYWORDS[provider]);
    expect(strippedPaths(derived, stripped)).toEqual([]);
    expect(restore(derived, NARRATION_FORMAT)).toEqual(NARRATION_FORMAT);
    // Every enum, const and required list survives untouched.
    const text = JSON.stringify(derived);
    for (const fragment of [
      '"enum":[1,2,3,4,5]',
      '"enum":["info","notable","warning","urgent"]',
      '"enum":[0.5,0.6,0.7,0.8,0.9]',
      '"enum":["model"]',
      '"enum":[true]',
      '"additionalProperties":false',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('strips what the vendor documents and keeps what it supports', () => {
    const text = JSON.stringify(hostedNarrationFormat(provider));
    expect(text).not.toContain('maxLength');
    if (provider === 'anthropic') expect(text).not.toContain('maxItems');
    else expect(text).toContain('"maxItems":5');
  });
});
