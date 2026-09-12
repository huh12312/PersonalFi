// SPDX-License-Identifier: MIT
/**
 * KEK custody (03 §2.2, decision D5, P0-2).
 *
 * The KEK is derived once per boot with Argon2id from a passphrase that arrives as
 * a **file secret** (`${SECRETS_DIR}/master_key`), never as an environment
 * variable: env is readable by every dependency in-process and leaks into
 * `/proc/<pid>/environ`, child processes, crash dumps and `docker inspect`.
 *
 * Once derived it lives in exactly one `Uint8Array` inside a `KekHolder`, is never
 * placed on `config`, never logged, and is zeroed on `SIGTERM`. The only way to
 * reach it is `KekHolder.use()`, which is greppable in review.
 *
 * Boot is unattended by design. 03 §2.2 is explicit that a manual unlock ceremony
 * after every power cut will be bypassed within a month, so with the secret file
 * present the process reaches `unlocked` with no interaction. `unlockState()`
 * exists so a future `/unlock` page (Tier 2) has something to render when the file
 * is absent or the passphrase no longer matches.
 */
import { SecretBoxError } from './errors.ts';
import { argon2idRaw, wipe, type Argon2Params } from './primitives.ts';

/**
 * The target parameters: 03 §2.2 and P0-2 both say m ≥ 1 GiB, t = 4, p = 4.
 *
 * This is far above the OWASP password-storage minimum (m = 19 MiB, t = 2, p = 1)
 * and that is correct: the OWASP figure is tuned for thousands of logins per
 * second, and this derivation happens once, at boot.
 */
export const KEK_TARGET_PARAMS: Argon2Params = {
  memoryKiB: 1_048_576,
  timeCost: 4,
  parallelism: 4,
};

/**
 * The floors themselves live in `@core/config` (`KEK_ARGON2_FLOORS`), because
 * "what is the minimum acceptable value of this setting" is configuration policy
 * and belongs next to the validation that enforces it. This package receives the
 * applicable floor through `SecretBoxOptions.kdfFloor` and re-checks it at every
 * derivation, so a caller that skipped `loadConfig` still cannot derive a weak KEK.
 */

/**
 * Measured ceiling, not a taste: `hash-wasm` runs on wasm32, so the Argon2 memory
 * block plus its working buffers must fit in a 4 GiB address space. 1.75 GiB
 * succeeds (10.3 s on the dev box); 2 GiB fails with
 * `Invalid typed array length: 2147484672`. Rejecting it in config is better than
 * discovering it at 03:15 on a restart.
 */
export const KEK_MAX_MEMORY_KIB = 1_835_008;

export const KEK_SALT_BYTES = 32;

/** What the API may show about key custody. Contains nothing sensitive. */
export type UnlockState =
  | {
      readonly state: 'unlocked';
      readonly kekVersion: number;
      readonly kdf: Argon2Params & { readonly durationMs: number };
      /** True when the stored KEK was derived with weaker parameters than the floor. */
      readonly rotationRecommended: boolean;
    }
  | {
      readonly state: 'locked';
      readonly reason: 'no_passphrase' | 'passphrase_mismatch' | 'not_started';
    };

export function assertParamsAtOrAboveFloor(params: Argon2Params, floor: Argon2Params): void {
  const problems: string[] = [];
  if (params.memoryKiB < floor.memoryKiB) {
    problems.push(`memory ${params.memoryKiB} KiB is below the floor of ${floor.memoryKiB} KiB`);
  }
  if (params.timeCost < floor.timeCost) {
    problems.push(`time cost ${params.timeCost} is below the floor of ${floor.timeCost}`);
  }
  if (params.parallelism < floor.parallelism) {
    problems.push(`parallelism ${params.parallelism} is below the floor of ${floor.parallelism}`);
  }
  if (params.memoryKiB > KEK_MAX_MEMORY_KIB) {
    problems.push(
      `memory ${params.memoryKiB} KiB exceeds the wasm32 ceiling of ${KEK_MAX_MEMORY_KIB} KiB`,
    );
  }
  if (problems.length > 0) {
    throw new SecretBoxError(
      'params_below_floor',
      `Argon2id parameters rejected: ${problems.join('; ')}`,
    );
  }
}

export interface DerivedKek {
  readonly key: Uint8Array;
  readonly durationMs: number;
}

/**
 * Derive the KEK. The caller owns the returned buffer and must wipe it; in
 * practice the only caller is `KekHolder.install`.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
  now: () => number,
): Promise<DerivedKek> {
  if (salt.length !== KEK_SALT_BYTES) {
    throw new SecretBoxError('envelope_malformed', 'KEK salt must be 32 bytes');
  }
  const started = now();
  const key = await argon2idRaw(passphrase, salt, params);
  return { key, durationMs: Math.round(now() - started) };
}

/**
 * Sole custodian of the key-encryption key.
 *
 * The key is private to this object and never returned. `use()` hands it to a
 * callback for the duration of one operation; there is no getter, so a stray
 * `JSON.stringify(holder)` or a log line cannot print it.
 */
export class KekHolder {
  #key: Uint8Array | null = null;
  #version = 0;
  #kdf: (Argon2Params & { durationMs: number }) | null = null;
  #rotationRecommended = false;
  #lockedReason: 'no_passphrase' | 'passphrase_mismatch' | 'not_started' = 'not_started';

  install(
    key: Uint8Array,
    version: number,
    kdf: Argon2Params & { durationMs: number },
    rotationRecommended: boolean,
  ): void {
    this.#wipeCurrent();
    this.#key = key;
    this.#version = version;
    this.#kdf = kdf;
    this.#rotationRecommended = rotationRecommended;
  }

  lock(reason: 'no_passphrase' | 'passphrase_mismatch' | 'not_started'): void {
    this.#wipeCurrent();
    this.#lockedReason = reason;
  }

  get isUnlocked(): boolean {
    return this.#key !== null;
  }

  get version(): number {
    return this.#version;
  }

  /**
   * Run one operation with the KEK. Throws `locked` rather than returning a
   * nullable key, so no call site can accidentally encrypt under `undefined`.
   */
  use<T>(operation: (kek: Uint8Array) => T): T {
    if (this.#key === null) {
      throw new SecretBoxError('locked', 'the key-encryption key is not available');
    }
    return operation(this.#key);
  }

  state(): UnlockState {
    if (this.#key === null || this.#kdf === null) {
      return { state: 'locked', reason: this.#lockedReason };
    }
    return {
      state: 'unlocked',
      kekVersion: this.#version,
      kdf: this.#kdf,
      rotationRecommended: this.#rotationRecommended,
    };
  }

  /** Called from the `SIGTERM` handler. Idempotent. */
  destroy(): void {
    this.#wipeCurrent();
    this.#lockedReason = 'not_started';
  }

  #wipeCurrent(): void {
    if (this.#key !== null) wipe(this.#key);
    this.#key = null;
    this.#kdf = null;
    this.#version = 0;
    this.#rotationRecommended = false;
  }

  /**
   * `toJSON` and the inspect hook are overridden for the same reason `Redacted<T>`
   * has them: the realistic leak is not `console.log(kek)`, it is an object graph
   * that happens to contain the holder reaching a structured log serialiser.
   */
  toJSON(): string {
    return '[KekHolder]';
  }

  toString(): string {
    return '[KekHolder]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[KekHolder]';
  }
}
