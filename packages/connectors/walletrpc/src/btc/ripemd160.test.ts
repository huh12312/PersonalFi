// SPDX-License-Identifier: MIT
/**
 * RIPEMD-160's own published test vectors (Dobbertin/Bosselaers/Preneel), the
 * only independent check available with no network and no dependency this
 * package is not permitted to add. `ripemd160.ts`'s header explains why this
 * function is vendored rather than imported.
 */
import { describe, expect, it } from 'vitest';
import { ripemd160 } from './ripemd160.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('ripemd160', () => {
  it('hashes the empty string', () => {
    expect(hex(ripemd160(new TextEncoder().encode('')))).toBe(
      '9c1185a5c5e9fc54612808977ee8f548b2258d31',
    );
  });

  it('hashes "abc"', () => {
    expect(hex(ripemd160(new TextEncoder().encode('abc')))).toBe(
      '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc',
    );
  });

  it('hashes "message digest"', () => {
    expect(hex(ripemd160(new TextEncoder().encode('message digest')))).toBe(
      '5d0689ef49d2fae572b881b123a85ffa21595f36',
    );
  });

  it('hashes the alphabet', () => {
    expect(hex(ripemd160(new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')))).toBe(
      'f71c27109c692c1b56bbdceb5b9d2865b3708dbc',
    );
  });

  it('hashes a message spanning two blocks', () => {
    expect(
      hex(
        ripemd160(
          new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        ),
      ),
    ).toBe('12a053384a9c0c88e405a06c27dcf49ada62eb2b');
  });
});
