// SPDX-License-Identifier: MIT
/**
 * Exit test for `docs/plan/03-phase-3-dispatch.md` §3 "WP 3.6", exact name:
 * `'an input parsing as a WIF, a seed phrase or an xprv is refused'`.
 *
 * Sabotage-tested: `docs/evidence/phase-3/wp3.6-walletrpc.md` §4 records
 * commenting out each branch of `classifyPrivateMaterial` one at a time and
 * observing this file go red before restoring it.
 */
import { base58check } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { isConnectorError, type ConnectorError } from '@connector/port';
import { sha256 } from '../src/btc/sha256.ts';
import { assertNoPrivateMaterial, classifyPrivateMaterial } from '../src/guard.ts';

const BASE58CHECK = base58check(sha256);

/** A structurally-valid (correct checksum, correct length) fixture, not a real key. */
function wifOf(version: number): string {
  const payload = new Uint8Array(34); // version-less: 32-byte key + compression flag
  payload[0] = version;
  payload.fill(0x11, 1, 33);
  payload[33] = 0x01;
  return BASE58CHECK.encode(payload);
}

function extendedKeyOf(version: number): string {
  // version(4) || depth(1) || fingerprint(4) || index(4) || chainCode(32) || key(33, 0x00-prefixed)
  const payload = new Uint8Array(78);
  const view = new DataView(payload.buffer);
  view.setUint32(0, version, false);
  payload.fill(0x22, 5, 9); // fingerprint
  payload.fill(0x33, 13, 45); // chain code
  payload[45] = 0x00; // private-key marker byte
  payload.fill(0x44, 46, 78);
  return BASE58CHECK.encode(payload);
}

// Structurally-valid fixtures (correct base58check framing), not real secrets.
const WIF_COMPRESSED = wifOf(0x80);
const XPRV = extendedKeyOf(0x0488ade4);
const YPRV = extendedKeyOf(0x049d7878);
const ZPRV = extendedKeyOf(0x04b2430c);
const SEED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RAW_HEX_KEY = '0000000000000000000000000000000000000000000000000000000000000001'.slice(-64);
const VALID_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const VALID_ETH_ADDRESS = '0x0000000000000000000000000000000000000001';

describe('an input parsing as a WIF, a seed phrase or an xprv is refused', () => {
  it.each([
    ['a compressed WIF private key', WIF_COMPRESSED, 'wif_private_key'],
    ['an xprv', XPRV, 'extended_private_key'],
    ['a yprv', YPRV, 'extended_private_key'],
    ['a zprv', ZPRV, 'extended_private_key'],
    ['a 12-word BIP39-shaped seed phrase', SEED_PHRASE, 'bip39_mnemonic_shaped'],
    ['a raw 32-byte hex key', RAW_HEX_KEY, 'raw_private_key_hex'],
    ['a 0x-prefixed raw 32-byte hex key', `0x${RAW_HEX_KEY}`, 'raw_private_key_hex'],
  ])('refuses %s', (_label, value, expectedKind) => {
    expect(classifyPrivateMaterial(value)).toBe(expectedKind);
    let thrown: unknown;
    try {
      assertNoPrivateMaterial(value, 'value');
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
    expect((thrown as ConnectorError).kind).toBe('invalid_input');
    // The offending string never appears in the error: only the kind does.
    expect((thrown as Error).message).not.toContain(value);
  });

  it('does not refuse a genuine watch-only xpub/zpub', () => {
    expect(classifyPrivateMaterial(VALID_ZPUB)).toBeNull();
    expect(() => assertNoPrivateMaterial(VALID_ZPUB, 'value')).not.toThrow();
  });

  it('does not refuse a genuine Ethereum address', () => {
    expect(classifyPrivateMaterial(VALID_ETH_ADDRESS)).toBeNull();
    expect(() => assertNoPrivateMaterial(VALID_ETH_ADDRESS, 'value')).not.toThrow();
  });

  it('does not refuse ordinary prose that merely contains many words', () => {
    const sentence = 'this is just a label for my hardware wallet at home not a secret at all';
    expect(classifyPrivateMaterial(sentence)).toBeNull();
  });
});
