// SPDX-License-Identifier: MIT
/**
 * `HASH160 = RIPEMD160(SHA256(x))` — the address-hash Bitcoin uses everywhere.
 *
 * Both hashes come through `@core/secretbox`, the single audited crypto call
 * site (eslint's `no-restricted-imports` confines `@noble/hashes` to
 * `packages/secretbox/src/primitives.ts`). `ripemd160` was added to that
 * surface for this one caller; there is no case for a finance app carrying its
 * own hash primitives when one audited implementation is already on the graph.
 */
import { ripemd160, sha256 } from '@core/secretbox';

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}
