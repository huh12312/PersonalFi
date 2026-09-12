// SPDX-License-Identifier: MIT
/**
 * KEK custody: the Argon2id floor, the wasm32 ceiling, and the holder that is the
 * only thing in the process allowed to touch the key (03 §2.2, P0-2).
 *
 * Derivations here run at the development floor (8 MiB, t=2, p=1, a few
 * milliseconds). The production numbers are not a unit-test concern — they are
 * enforced by `loadConfig` and recorded in
 * `docs/evidence/phase-0/wp0.2-argon2-parameters.md` — and a suite that paid 5.9 s
 * per derivation is a suite nobody runs.
 */
import { describe, expect, it } from 'vitest';
import { isSecretBoxError } from './errors.ts';
import {
  assertParamsAtOrAboveFloor,
  deriveKek,
  KekHolder,
  KEK_MAX_MEMORY_KIB,
  KEK_SALT_BYTES,
  KEK_TARGET_PARAMS,
} from './kek.ts';
import { KEY_BYTES, type Argon2Params } from './primitives.ts';

const FLOOR: Argon2Params = { memoryKiB: 8_192, timeCost: 2, parallelism: 1 };
const FAST: Argon2Params = { memoryKiB: 8_192, timeCost: 2, parallelism: 1 };

function salt(fill = 1): Uint8Array {
  return new Uint8Array(KEK_SALT_BYTES).fill(fill);
}

const stoppedClock = (): number => 0;

describe('Argon2id parameter floor', () => {
  it('accepts parameters exactly at the floor', () => {
    expect(() => assertParamsAtOrAboveFloor(FLOOR, FLOOR)).not.toThrow();
  });

  it('accepts the shipped production target', () => {
    expect(() =>
      assertParamsAtOrAboveFloor(KEK_TARGET_PARAMS, {
        memoryKiB: 1_048_576,
        timeCost: 4,
        parallelism: 4,
      }),
    ).not.toThrow();
  });

  it('rejects a weaker value for each parameter independently', () => {
    expect(() => assertParamsAtOrAboveFloor({ ...FLOOR, memoryKiB: 8_191 }, FLOOR)).toThrowError(
      /memory 8191 KiB is below the floor/,
    );
    expect(() => assertParamsAtOrAboveFloor({ ...FLOOR, timeCost: 1 }, FLOOR)).toThrowError(
      /time cost 1 is below the floor/,
    );
    expect(() =>
      assertParamsAtOrAboveFloor({ ...FLOOR, parallelism: 0 }, { ...FLOOR, parallelism: 2 }),
    ).toThrowError(/parallelism 0 is below the floor/);
  });

  it('reports every problem at once rather than the first', () => {
    // Same reason `loadConfig` does: fixing one, restarting, and discovering the
    // next is how a five-minute change becomes an afternoon.
    try {
      assertParamsAtOrAboveFloor({ memoryKiB: 1, timeCost: 1, parallelism: 1 }, KEK_TARGET_PARAMS);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isSecretBoxError(error)).toBe(true);
      const message = (error as Error).message;
      expect(message).toMatch(/memory/);
      expect(message).toMatch(/time cost/);
      expect(message).toMatch(/parallelism/);
    }
  });

  it('rejects memory above the measured wasm32 ceiling', () => {
    // `hash-wasm` runs on wasm32: 2 GiB fails with `Invalid typed array length`.
    // Refusing it at configuration time beats discovering it on a 03:15 restart.
    expect(() =>
      assertParamsAtOrAboveFloor({ ...KEK_TARGET_PARAMS, memoryKiB: 2_097_152 }, FLOOR),
    ).toThrowError(/exceeds the wasm32 ceiling/);
    expect(() =>
      assertParamsAtOrAboveFloor({ ...KEK_TARGET_PARAMS, memoryKiB: KEK_MAX_MEMORY_KIB }, FLOOR),
    ).not.toThrow();
  });

  it('classifies a floor violation as params_below_floor', () => {
    try {
      assertParamsAtOrAboveFloor({ ...FLOOR, timeCost: 1 }, FLOOR);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isSecretBoxError(error) && error.code).toBe('params_below_floor');
    }
  });
});

describe('deriveKek', () => {
  it('produces a 32-byte key and reports how long it took', async () => {
    let ticks = 0;
    const derived = await deriveKek('passphrase', salt(), FAST, () => (ticks += 40));
    expect(derived.key).toHaveLength(KEY_BYTES);
    expect(derived.durationMs).toBe(40);
  });

  it('is deterministic for the same passphrase, salt and parameters', async () => {
    const a = await deriveKek('passphrase', salt(), FAST, stoppedClock);
    const b = await deriveKek('passphrase', salt(), FAST, stoppedClock);
    expect([...a.key]).toEqual([...b.key]);
  });

  it('produces a different key for a different salt, passphrase or cost', async () => {
    const base = await deriveKek('passphrase', salt(), FAST, stoppedClock);
    const others = await Promise.all([
      deriveKek('passphrase', salt(2), FAST, stoppedClock),
      deriveKek('passphrasf', salt(), FAST, stoppedClock),
      deriveKek('passphrase', salt(), { ...FAST, timeCost: 3 }, stoppedClock),
    ]);
    for (const other of others) {
      expect([...other.key]).not.toEqual([...base.key]);
    }
  });

  it('refuses a salt that is not 32 bytes', async () => {
    await expect(deriveKek('p', new Uint8Array(16), FAST, stoppedClock)).rejects.toThrow(
      /salt must be 32 bytes/,
    );
  });
});

describe('KekHolder', () => {
  it('starts locked and refuses to hand out a key', () => {
    const holder = new KekHolder();
    expect(holder.isUnlocked).toBe(false);
    expect(holder.state()).toEqual({ state: 'locked', reason: 'not_started' });
    // Throws rather than returning null, so no call site can encrypt under
    // `undefined` and silently produce an unopenable ciphertext.
    expect(() => holder.use(() => 'never')).toThrowError(/not available/);
  });

  it('lends the key for the duration of one operation and never returns it', () => {
    const holder = new KekHolder();
    const key = new Uint8Array(KEY_BYTES).fill(5);
    holder.install(key, 1, { ...FAST, durationMs: 12 }, false);

    expect(holder.isUnlocked).toBe(true);
    expect(holder.version).toBe(1);
    expect(holder.use((kek) => kek.length)).toBe(KEY_BYTES);
    // There is no getter. `use` is the entire surface, which is what makes
    // "who can reach the KEK?" a greppable question.
    expect(Object.keys(holder)).toEqual([]);
  });

  it('zeroes the key on destroy — the SIGTERM path (P0-2)', () => {
    const holder = new KekHolder();
    const key = new Uint8Array(KEY_BYTES).fill(0xab);
    holder.install(key, 1, { ...FAST, durationMs: 1 }, false);

    holder.destroy();

    // The caller's buffer is the holder's buffer, so this is the real check:
    // after shutdown the bytes are gone from the heap, not merely unreachable.
    expect([...key]).toEqual(Array.from({ length: KEY_BYTES }, () => 0));
    expect(holder.isUnlocked).toBe(false);
    expect(holder.state()).toEqual({ state: 'locked', reason: 'not_started' });
    expect(() => holder.destroy()).not.toThrow(); // idempotent
  });

  it('zeroes the previous key when a new generation is installed', () => {
    const holder = new KekHolder();
    const first = new Uint8Array(KEY_BYTES).fill(1);
    const second = new Uint8Array(KEY_BYTES).fill(2);
    holder.install(first, 1, { ...FAST, durationMs: 1 }, false);
    holder.install(second, 2, { ...FAST, durationMs: 1 }, false);

    expect([...first]).toEqual(Array.from({ length: KEY_BYTES }, () => 0));
    expect(holder.version).toBe(2);
    expect(holder.use((kek) => kek[0])).toBe(2);
  });

  it('zeroes the key when it locks, and records why', () => {
    const holder = new KekHolder();
    const key = new Uint8Array(KEY_BYTES).fill(7);
    holder.install(key, 1, { ...FAST, durationMs: 1 }, false);

    holder.lock('passphrase_mismatch');

    expect([...key]).toEqual(Array.from({ length: KEY_BYTES }, () => 0));
    expect(holder.state()).toEqual({ state: 'locked', reason: 'passphrase_mismatch' });
  });

  it('reports parameters and duration but never key material', () => {
    const holder = new KekHolder();
    holder.install(new Uint8Array(KEY_BYTES).fill(9), 3, { ...FAST, durationMs: 5_860 }, true);
    expect(holder.state()).toEqual({
      state: 'unlocked',
      kekVersion: 3,
      kdf: { ...FAST, durationMs: 5_860 },
      rotationRecommended: true,
    });
  });

  it('cannot be serialised into a log line', () => {
    // The realistic leak is not `console.log(kek)`. It is an object graph that
    // happens to contain the holder reaching a structured log serialiser.
    const holder = new KekHolder();
    holder.install(new Uint8Array(KEY_BYTES).fill(0x42), 1, { ...FAST, durationMs: 1 }, false);

    const serialised = JSON.stringify({ security: { kek: holder } });
    expect(serialised).toBe('{"security":{"kek":"[KekHolder]"}}');
    expect(serialised).not.toMatch(/66/); // 0x42 as a JSON byte value
    expect(String(holder)).toBe('[KekHolder]');
    expect(`${holder}`).toBe('[KekHolder]');
  });
});
