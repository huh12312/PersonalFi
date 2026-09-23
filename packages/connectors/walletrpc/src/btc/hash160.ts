// SPDX-License-Identifier: MIT
/**
 * `HASH160 = RIPEMD160(SHA256(x))` — the address-hash Bitcoin uses everywhere.
 *
 * Both `sha256` and `ripemd160` are vendored in this package rather than
 * imported: `@core/secretbox` exports a `sha256` that `@connector/port`'s own
 * `fingerprintOf` uses, but it is not a declared dependency of *this*
 * package's `package.json` (which this work package may not edit), so it does
 * not resolve under pnpm's isolated `node_modules` — see `sha256.ts`'s header.
 */
import { sha256 } from './sha256.ts';
import { ripemd160 } from './ripemd160.ts';

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}
