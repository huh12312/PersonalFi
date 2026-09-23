// SPDX-License-Identifier: MIT
/**
 * Exit tests for `docs/plan/03-phase-3-dispatch.md` §3 "WP 3.6": exact names
 * `'a BIP84 zpub derives the published test-vector addresses'` and
 * `'derivation stops at the gap limit of 20 empty addresses'`.
 *
 * The BIP84 vector is BIP84's own published test vector (mnemonic "abandon
 * abandon abandon abandon abandon abandon abandon abandon abandon abandon
 * abandon about", the well-known BIP39 test seed), reproduced verbatim from
 * the BIP:
 * https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#test-vectors
 */
import { describe, expect, it } from 'vitest';
import { GAP_LIMIT, parseAccountKey, scanChain } from '../src/btc/derive.ts';

const BIP84_ACCOUNT_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('a BIP84 zpub derives the published test-vector addresses', () => {
  it('derives the first two receiving addresses and the first change address', () => {
    const account = parseAccountKey(BIP84_ACCOUNT_ZPUB);
    expect(account.scheme).toBe('bip84');

    expect(account.addressAt('external', 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(account.addressAt('external', 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
    expect(account.addressAt('internal', 0)).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it('refuses an xprv/yprv/zprv-shaped input before it ever builds an HDKey', () => {
    expect(() => parseAccountKey('not-a-key-at-all')).toThrow(/extended public key prefix/);
  });
});

describe('derivation stops at the gap limit of 20 empty addresses', () => {
  it('checks exactly 20 addresses when every one is empty, then stops', async () => {
    const account = parseAccountKey(BIP84_ACCOUNT_ZPUB);
    const checkedAddresses: string[] = [];

    const result = await scanChain(account, 'external', async (address) => {
      checkedAddresses.push(address);
      return false;
    });

    expect(result.checked).toHaveLength(GAP_LIMIT);
    expect(checkedAddresses).toHaveLength(GAP_LIMIT);
    expect(result.highestUsedIndex).toBeNull();
    // Every checked address really was derived at consecutive indices 0..19 —
    // proof the loop advanced rather than re-checking the same address.
    expect(new Set(checkedAddresses).size).toBe(GAP_LIMIT);
  });

  it('resets the gap counter on activity and keeps scanning past it', async () => {
    const account = parseAccountKey(BIP84_ACCOUNT_ZPUB);
    // Activity at index 5 only: the scan must check 5 (used) + 20 more empty
    // ones (6..25) before stopping — 26 total, not 20.
    const result = await scanChain(account, 'external', async (_address, _chain, index) =>
      Promise.resolve(index === 5),
    );

    expect(result.highestUsedIndex).toBe(5);
    expect(result.checked).toHaveLength(5 + 1 + GAP_LIMIT);
  });
});
