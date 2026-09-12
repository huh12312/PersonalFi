// SPDX-License-Identifier: MIT
/**
 * `@core/secretbox` — the cryptography chokepoint.
 *
 * **Why this is a package and not a module inside `@ctx/identity`.** 03 §2 and the
 * identity context's own OWNERSHIP.md both describe `SecretBox` as "the single
 * chokepoint through which every other context encrypts anything". The boundary
 * lint makes that impossible to deliver from inside a context: `personalfi/layer-imports`
 * denies `@ctx/*` → `@ctx/*` imports outright, so `@ctx/connections` could not
 * call a `SecretBox` living in `@ctx/identity` — it would need an injected port
 * from the composition root for every seal, or a second copy of the crypto. Both
 * outcomes are worse than one shared infrastructure package. Putting it at the
 * `@core/*` tier alongside `@core/db` makes the chokepoint real: *one* package may
 * import a cipher, every context may call it, and the allow-list in
 * `scripts/eslint-boundaries.js` is the proof.
 *
 * It owns `encryption_keys` for the same reason `@core/db` owns `schema_migrations`:
 * the keyring is this package's private bookkeeping, and a rotation that had to
 * reach across an ownership boundary would be a distributed transaction over the
 * most fragile data in the system.
 */
export { SecretBox, recordScope, epochScope } from './secret-box.ts';
export type { KeyPolicy, SealOptions, KeyVersionSummary, SecretBoxOptions } from './secret-box.ts';
export {
  buildAad,
  describeAad,
  decodeEnvelope,
  encodeEnvelope,
  bytesToUuid,
  uuidToBytes,
  AAD_NAMESPACE,
  ENVELOPE_VERSION,
  HEADER_BYTES,
  KEY_ID_BYTES,
  type ColumnRef,
  type Envelope,
} from './envelope.ts';
export {
  KekHolder,
  assertParamsAtOrAboveFloor,
  deriveKek,
  KEK_TARGET_PARAMS,
  KEK_MAX_MEMORY_KIB,
  KEK_SALT_BYTES,
  type UnlockState,
} from './kek.ts';
export { SecretBoxError, isSecretBoxError, type SecretBoxErrorCode } from './errors.ts';
export type { SecretBoxQueryable, EncryptionKeyRow, KeyKind } from './store.ts';

/**
 * Primitives re-exported for the packages that legitimately need them — session
 * token hashing in `@ctx/identity`, the double-submit CSRF token in `apps/api`.
 *
 * They are *here* rather than imported from `@noble/hashes` at the call site so
 * that "which code touches a primitive?" has one answer: this package's surface.
 * Anything richer than "hash this token" or "compare these two digests" belongs
 * behind `SecretBox`, not here.
 */
export {
  randomBytes,
  sha256,
  constantTimeEqual,
  argon2idEncoded,
  argon2idVerify,
  wipe,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  type Argon2Params,
} from './primitives.ts';
