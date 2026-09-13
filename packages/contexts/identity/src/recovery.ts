// SPDX-License-Identifier: MIT
/**
 * Recovery codes — the break-glass path (03 §3.2, P0-4).
 *
 * Ten single-use codes, generated at setup, displayed exactly once, Argon2id-hashed
 * at rest. Without them a lost phone means restoring from backup, which is a bad
 * enough afternoon that the codes will get printed.
 *
 * Design notes worth the sentence each:
 *
 * - **Crockford base32, no ambiguous characters.** These get written on paper and
 *   read back at a stressful moment; `0`/`O` and `1`/`I` are a support call.
 * - **Argon2id, not SHA-256.** A ten-character code is roughly 50 bits, which is
 *   plenty online and not plenty against an offline attacker holding a stolen dump.
 *   The verification cost is paid at most a handful of times in the app's life.
 * - **Verification is O(n) over ten rows and that is fine.** There is no lookup key
 *   — deriving one from the code would leak which codes exist.
 * - **Regenerating replaces the whole batch.** A half-spent set of ten plus three
 *   new ones is a set nobody can reason about.
 */
import { newId, type Clock } from '@core/kernel';
import { argon2idEncoded, argon2idVerify, randomBytes, type Argon2Params } from '@core/secretbox';
import type { IdentityQueryable } from './db.ts';

export const RECOVERY_CODE_COUNT = 10;
/** 10 characters of Crockford-ish base32 ≈ 50 bits. */
const CODE_LENGTH = 10;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * OWASP's password-storage minimum (m = 19 MiB, t = 2, p = 1), which is the right
 * setting here rather than the KEK's 1 GiB: verifying a recovery code happens
 * interactively while someone waits, and a ten-character random code is not a
 * human-chosen password.
 */
const RECOVERY_CODE_HASH_PARAMS: Argon2Params = {
  memoryKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export interface RecoveryCodeServiceOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
}

export interface GeneratedRecoveryCodes {
  readonly batchId: string;
  /** Plaintext, in display order. Returned once and never stored. */
  readonly codes: readonly string[];
}

export class RecoveryCodeService {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #params: Argon2Params = RECOVERY_CODE_HASH_PARAMS;

  constructor(options: RecoveryCodeServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
  }

  /** Mint a fresh batch of ten, discarding any previous batch. */
  async generate(userId: string): Promise<GeneratedRecoveryCodes> {
    const batchId = newId();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => mintCode());
    const now = this.#clock.now();

    await this.#db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
    for (const code of codes) {
      const hash = await argon2idEncoded(normalise(code), this.#params);
      await this.#db.query(
        `INSERT INTO recovery_codes (id, user_id, code_hash, batch_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), userId, hash, batchId, now],
      );
    }
    return { batchId, codes };
  }

  /**
   * Spend a code. Returns true only if it matched an unused one.
   *
   * The `UPDATE ... WHERE used_at IS NULL` is the single-use guarantee: two
   * concurrent requests presenting the same code race on that predicate and exactly
   * one wins. Checking-then-updating would let both through.
   */
  async consume(userId: string, code: string): Promise<boolean> {
    const candidate = normalise(code);
    const result = await this.#db.query(
      `SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );

    for (const row of result.rows) {
      const matched = await argon2idVerify(String(row['code_hash']), candidate);
      if (!matched) continue;
      const claimed = await this.#db.query(
        `UPDATE recovery_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [String(row['id']), this.#clock.now()],
      );
      return claimed.rows.length > 0;
    }
    return false;
  }

  async remainingCount(userId: string): Promise<number> {
    const result = await this.#db.query(
      `SELECT count(*)::int AS remaining FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.['remaining'] ?? 0);
  }
}

/** Grouped `XXXXX-XXXXX` for legibility on paper. */
function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // Modulo bias over a 30-character alphabet is ~0.4 bits across ten characters.
    // Against a rate-limited online guess at 50 bits of entropy, that is noise.
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Accept what the user typed: any case, with or without the dash or spaces. */
function normalise(code: string): string {
  return code.toUpperCase().replaceAll(/[^0-9A-Z]/g, '');
}
