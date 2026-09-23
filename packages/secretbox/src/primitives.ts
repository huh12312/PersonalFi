// SPDX-License-Identifier: MIT
/**
 * The crypto chokepoint.
 *
 * **This is the only file in the repository allowed to import a cipher, a KDF,
 * a hash, or `node:crypto`.** `personalfi/layer-imports` denies those packages in
 * every other layer, and an ESLint `no-restricted-imports` override denies them in
 * every other file of this package too. Everything above this line works with
 * `SecretBox`, never with a primitive.
 *
 * Why a chokepoint at all: the failure mode in application cryptography is almost
 * never a broken cipher, it is a second call site that reuses a nonce, forgets the
 * AAD, or compares a tag with `===`. One file is auditable in an afternoon; forty
 * call sites are not.
 *
 * Library choices (03 §3.1 asked for libsodium; see the deviation note below):
 *
 * - **`@noble/ciphers` (MIT, zero dependencies)** for XChaCha20-Poly1305. The memo
 *   named `libsodium-wrappers-sumo` (ISC) and its reasoning — "prefer a
 *   misuse-resistant AEAD API over hand-assembled `node:crypto`" — is honoured:
 *   noble's `xchacha20poly1305(key, nonce, aad).encrypt(pt)` is the same one-call
 *   shape, tags and padding included, with no way to forget the tag check. It is
 *   preferred here because it is pure TypeScript with **zero transitive
 *   dependencies** and independently audited, whereas `libsodium-wrappers-sumo`
 *   ships a ~1 MB emscripten blob plus a second package. Given that the top-ranked
 *   risk in 03 §1.4 is a malicious dependency running in this process, the smaller,
 *   readable tree wins.
 * - **`hash-wasm` (MIT, zero dependencies)** for Argon2id. `@node-rs/argon2` is a
 *   native addon and is forbidden (D13 notwithstanding): a native addon breaks the
 *   musl/glibc story and cannot be audited from the lockfile. `@noble/hashes` also implements Argon2id in pure JS but is roughly
 *   an order of magnitude slower at 1 GiB, which turns a 6 s boot into a minute.
 * - **`@noble/hashes` (MIT)** for SHA-256 of session and refresh tokens.
 *
 * `node:crypto` is used for exactly one thing — the CSPRNG — because the platform
 * CSPRNG is the right source of randomness and reimplementing it would be absurd.
 */
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/legacy.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { argon2id, argon2Verify } from 'hash-wasm';

/** XChaCha20-Poly1305: 32-byte key, 24-byte nonce, 16-byte tag. */
export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

export interface Argon2Params {
  /** Memory cost in KiB. */
  readonly memoryKiB: number;
  /** Iterations (`t`). */
  readonly timeCost: number;
  /** Lanes (`p`). */
  readonly parallelism: number;
}

/** Cryptographically secure random bytes. The only randomness source in the app. */
export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

/** A fresh 32-byte data encryption key. */
export function randomKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/** A fresh 24-byte nonce. 192 bits, so random generation is safe without a counter. */
export function randomNonce(): Uint8Array {
  return randomBytes(NONCE_BYTES);
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/**
 * RIPEMD-160, for exactly one caller: `@connector/walletrpc`'s Bitcoin
 * `HASH160 = RIPEMD160(SHA256(x))` address derivation (WP 3.6). It lives in
 * `@noble/hashes`' `legacy` module for a reason — it is not a hash to reach for
 * anywhere else in this app — and it is exported from here rather than imported
 * at the call site so the single-crypto-call-site rule keeps one answer.
 */
export function ripemd160(data: Uint8Array): Uint8Array {
  return nobleRipemd160(data);
}

/**
 * Constant-time equality. Length mismatch returns false *before* the comparison,
 * which leaks length only — and every caller here compares fixed-length digests.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * AEAD seal. `aad` is **required**, not optional: an optional parameter is an
 * invitation to omit it, and an omitted AAD is exactly the bug (ciphertext
 * relocatable between rows) the AAD exists to prevent.
 */
export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/** AEAD open. Returns `null` on any authentication failure; never throws a detail. */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array | null {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    // Tag mismatch, wrong key, wrong AAD, truncated input — all one answer.
    return null;
  }
}

/** Argon2id, raw output. Used for the KEK; `length` is 32 for an XChaCha key. */
export async function argon2idRaw(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
  length = KEY_BYTES,
): Promise<Uint8Array> {
  const digest = await argon2id({
    password: passphrase,
    salt,
    memorySize: params.memoryKiB,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    hashLength: length,
    outputType: 'binary',
  });
  return new Uint8Array(digest);
}

/**
 * Argon2id in PHC encoded form, for secrets we only ever *verify*: recovery codes
 * and the one-time registration token. The salt and parameters travel in the
 * string, so a parameter bump does not invalidate existing hashes.
 */
export async function argon2idEncoded(secret: string, params: Argon2Params): Promise<string> {
  return argon2id({
    password: secret,
    salt: randomBytes(16),
    memorySize: params.memoryKiB,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function argon2idVerify(encodedHash: string, secret: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: secret, hash: encodedHash });
  } catch {
    return false;
  }
}

/**
 * Overwrite key material in place.
 *
 * An honest caveat: this is best-effort in a garbage-collected runtime. V8 may
 * have copied the bytes during a compaction, and without `sodium_mlock` the page
 * can reach swap. 03 §2.2 answers the second half at the host level (disable swap
 * or encrypt it); this closes the window where a heap dump taken after shutdown
 * still contains the KEK, which is the part we can actually control.
 */
export function wipe(buffer: Uint8Array): void {
  buffer.fill(0);
}
