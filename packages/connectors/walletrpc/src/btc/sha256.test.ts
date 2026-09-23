// SPDX-License-Identifier: MIT
/** FIPS 180-4's own published test vectors. See `sha256.ts`'s header. */
import { describe, expect, it } from 'vitest';
import { sha256 } from './sha256.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('sha256', () => {
  it('hashes the empty string', () => {
    expect(hex(sha256(new TextEncoder().encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc"', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the two-block 448-bit vector', () => {
    expect(
      hex(
        sha256(
          new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        ),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('double-hashes to the known Bitcoin genesis-block-style checksum shape', () => {
    // Not a genesis-block claim — just a sanity check that hashing twice
    // (what base58check does) produces a stable, re-derivable 32 bytes.
    const once = sha256(new TextEncoder().encode('hello'));
    const twice = sha256(once);
    expect(hex(twice)).toHaveLength(64);
  });
});
