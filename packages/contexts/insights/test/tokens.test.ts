// SPDX-License-Identifier: MIT
/**
 * WP 3.13 carry-over: "`@core/secretbox` is not a dependency of `@ctx/insights`
 * — merchant pseudonyms use `configHash` (a keyed hash, not an HMAC)... the
 * cost of the change is monotonically increasing in the number of stored
 * evidence rows... it must be decided in Phase 3, not Phase 5"
 * (03-phase-3-dispatch.md §2).
 *
 * ## The decision
 *
 * `src/snapshot/tokens.ts`'s own header is the decision, made and written
 * down rather than deferred again: keep `@core/platform`'s `configHash`
 * (SHA-256 over `canonicalJson`) rather than adding `@core/secretbox` to this
 * package's dependencies. The honest cost, stated there: a keyed hash is not
 * an HMAC (a prefix-MAC over SHA-256 is length-extendable), but nothing here
 * relies on the missing half — tokens are truncated to 48 bits (no full
 * internal state is published) and authenticate nothing (forging one gains an
 * attacker a string that resolves to no merchant). The property actually
 * relied on, one-wayness under an unknown key, holds under both
 * constructions. Adding the dependency is left to the orchestrator's next
 * batch, at which point this becomes `sha256` directly with the same
 * properties — a swap, not a redesign.
 *
 * ## What this file pins
 *
 * The exact bytes a change to the construction would move — literal digests
 * for a fixed `(secret, userId)` and a fixed `(key, domain, id)` — so that
 * changing the label string, the hash function, the field order, or the
 * truncation length **fails loudly here** rather than silently
 * re-pseudonymising every merchant and orphaning every stored `MERCHANT_…`
 * evidence ref the day someone "cleans up" this file without reading its
 * header. Sabotage: change `TOKEN_HEX` from 12 to 10, or reorder the fields
 * passed to `configHash` in `createTokeniser`, and the literal assertions
 * below fail.
 */
import { describe, expect, it } from 'vitest';
import { createTokeniser, deriveTokenKey, inputDigest } from '../src/snapshot/tokens.ts';

describe('merchant pseudonym construction is pinned (WP 3.13, secretbox decision)', () => {
  it('deriveTokenKey is pinned for a fixed secret and user, and differs by user', () => {
    const keyA = deriveTokenKey('top-secret', 'user-a');
    const keyB = deriveTokenKey('top-secret', 'user-b');

    expect(keyA).toBe('db7aaa8abc3a955094d7e7de14f2068c2c6ae3bc6ff6fb5abf306bb19a6b5d3e');
    expect(keyB).toBe('446ef9bb9d93089b78f38d830bd42673fefa37f88d04f299c1795d95ddf92e30');
    // Not a prefix relationship — a full compression apart, per the header's
    // "two account holders' keys differ by a full compression rather than by
    // a prefix" claim.
    expect(keyA.slice(0, 8)).not.toBe(keyB.slice(0, 8));
  });

  it('a merchant token is pinned, 12 hex characters, MERCHANT_-prefixed, and stable across calls', () => {
    const key = deriveTokenKey('top-secret', 'user-a');
    const tokeniser = createTokeniser({ key, tokeniseEverything: false });

    const first = tokeniser.merchant('merchant-123');
    const second = tokeniser.merchant('merchant-123');

    expect(first).toBe('MERCHANT_f17df14b9b54');
    expect(first).toBe(second);
    expect(first).toMatch(/^MERCHANT_[0-9a-f]{12}$/);
  });

  it('ref() is a uuid for an in-process advisor and a pinned token for an external one — never both the same value', () => {
    const key = deriveTokenKey('top-secret', 'user-a');
    const inProcess = createTokeniser({ key, tokeniseEverything: false });
    const external = createTokeniser({ key, tokeniseEverything: true });

    expect(inProcess.ref('account', 'account-123')).toBe('account-123');
    const externalToken = external.ref('account', 'account-123');
    expect(externalToken).toBe('ACCT_23bea244c2d0');
    expect(externalToken).not.toBe('account-123');

    // Merchant is tokenised for *both* kinds (D22) — the one identifier this
    // context never lets an in-process advisor see as a raw id either.
    expect(inProcess.ref('merchant', 'merchant-123')).toBe('MERCHANT_f17df14b9b54');
    expect(external.ref('merchant', 'merchant-123')).toBe('MERCHANT_f17df14b9b54');
  });

  it('two different domains for the same id never collide, and the same domain+id always does', () => {
    const key = deriveTokenKey('top-secret', 'user-a');
    const tokeniser = createTokeniser({ key, tokeniseEverything: true });

    const account = tokeniser.ref('account', 'shared-id');
    const category = tokeniser.ref('category', 'shared-id');
    expect(account).not.toBe(category);
    expect(account.startsWith('ACCT_')).toBe(true);
    expect(category.startsWith('CAT_')).toBe(true);
  });

  it('inputDigest is pinned, canonical (key order does not matter), and changes when the value does', () => {
    const orderedOne = inputDigest({ a: 1, b: 2 });
    const orderedTwo = inputDigest({ b: 2, a: 1 });

    expect(orderedOne).toBe(
      'sha256:ae202c5b1ff4804767a06ae4e65c0ba24239a1caaa7980e9d2c5024e679ce761',
    );
    expect(orderedOne).toBe(orderedTwo);
    expect(inputDigest({ a: 1, b: 3 })).not.toBe(orderedOne);
  });
});
