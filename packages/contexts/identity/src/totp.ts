// SPDX-License-Identifier: MIT
/**
 * TOTP fallback (RFC 6238, 03 §3.3).
 *
 * Supported, and deliberately positioned as **secondary**. A passkey is a
 * challenge-response over a key that never leaves the authenticator; a TOTP seed is
 * a shared secret that exists in two places and can be phished in real time. It is
 * here so that "my phone is in a lake and I am not near my YubiKey" has an answer
 * short of a recovery code.
 *
 * Consequences of that positioning, visible in the code:
 *
 * - The seed is **sealed with `SecretBox`** before it touches the database. It is a
 *   credential, and P0-1 applies to it exactly as it applies to a Plaid token. The
 *   AAD binds it to `totp_secrets.sealed_secret` and to its own row, so the
 *   ciphertext cannot be relocated.
 * - SHA-1, 6 digits, 30-second period — not a lapse but authenticator-app
 *   compatibility, which is the entire point of a fallback nobody has to install
 *   anything new to use.
 * - `window: 1` (±1 step, so ±30 s) for clock skew, no wider.
 * - A consumed step is recorded, so the same code cannot be replayed inside its own
 *   window. 03 §3.3 asks for this explicitly.
 * - No SMS, no email. There is no mail infrastructure, and SMS is a SIM-swap
 *   liability on an asset class that attracts exactly that attack.
 */
import { newId, type Clock } from '@core/kernel';
import type { SecretBox } from '@core/secretbox';
import { Secret, TOTP } from 'otpauth';
import { asBytes, toParam, type IdentityQueryable } from './db.ts';
import { AuthError } from './errors.ts';

const TABLE = 'totp_secrets';
const COLUMN = 'sealed_secret';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = 'SHA1';
/** ±1 step. Wider windows are how a 30-second code becomes a three-minute code. */
export const TOTP_WINDOW = 1;

export interface TotpEnrolment {
  readonly id: string;
  /** Base32 seed, shown exactly once so the user can type it into an app. */
  readonly secret: string;
  /** `otpauth://` URI for the QR code. Contains the seed; never log it. */
  readonly uri: string;
}

export interface TotpServiceOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly secretBox: SecretBox;
}

/** The `issuer` an authenticator app shows above the code. */
const TOTP_ISSUER = 'PersonalFi';

export class TotpService {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #secretBox: SecretBox;

  constructor(options: TotpServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#secretBox = options.secretBox;
  }

  /**
   * Create an unconfirmed enrolment and hand back the seed once.
   *
   * Unconfirmed until a code is verified: enrolling a factor the user has not
   * proved they can compute is how a second factor becomes a lockout.
   */
  async enrol(userId: string, label: string): Promise<TotpEnrolment> {
    const id = newId();
    const secret = new Secret({ size: 20 });
    const sealed = await this.#secretBox.sealText(
      { table: TABLE, column: COLUMN, rowId: id },
      secret.base32,
    );

    await this.#db.query(
      `INSERT INTO totp_secrets (id, user_id, sealed_secret, digits, period_seconds, algorithm, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        userId,
        toParam(sealed),
        TOTP_DIGITS,
        TOTP_PERIOD_SECONDS,
        TOTP_ALGORITHM,
        this.#clock.now(),
      ],
    );

    const totp = new TOTP({
      issuer: TOTP_ISSUER,
      label,
      secret,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });

    return { id, secret: secret.base32, uri: totp.toString() };
  }

  /** Prove the user can compute a code, then make the enrolment live. */
  async confirm(userId: string, enrolmentId: string, token: string): Promise<void> {
    const row = await this.#loadRow(userId, enrolmentId);
    const delta = await this.#validate(row, token);
    if (delta === null) throw new AuthError('invalid_credential', 'that code is not valid');

    await this.#db.query(
      `UPDATE totp_secrets SET confirmed_at = $2, last_used_step = $3 WHERE id = $1`,
      [enrolmentId, this.#clock.now(), this.#stepFor(row.periodSeconds, delta)],
    );
    // Exactly one confirmed enrolment per user; the partial unique index enforces
    // it, and this keeps the table from accumulating dead seeds.
    await this.#db.query(
      `DELETE FROM totp_secrets WHERE user_id = $1 AND id <> $2 AND confirmed_at IS NULL`,
      [userId, enrolmentId],
    );
  }

  /** Verify a code against the confirmed enrolment, refusing replay. */
  async verify(userId: string, token: string): Promise<boolean> {
    const row = await this.#loadConfirmed(userId);
    if (row === null) return false;
    const delta = await this.#validate(row, token);
    if (delta === null) return false;

    const step = this.#stepFor(row.periodSeconds, delta);
    if (row.lastUsedStep !== null && step <= row.lastUsedStep) {
      // Already spent. Inside a 30-second window a code is a bearer token, and a
      // bearer token that works twice is a replay.
      return false;
    }
    await this.#db.query(`UPDATE totp_secrets SET last_used_step = $2 WHERE id = $1`, [
      row.id,
      step,
    ]);
    return true;
  }

  async isEnrolled(userId: string): Promise<boolean> {
    return (await this.#loadConfirmed(userId)) !== null;
  }

  async remove(userId: string): Promise<void> {
    await this.#db.query(`DELETE FROM totp_secrets WHERE user_id = $1`, [userId]);
  }

  async #validate(row: TotpRow, token: string): Promise<number | null> {
    const base32 = await this.#secretBox.openText(
      { table: TABLE, column: COLUMN, rowId: row.id },
      row.sealedSecret,
    );
    return TOTP.validate({
      token,
      secret: Secret.fromBase32(base32),
      algorithm: row.algorithm,
      digits: row.digits,
      period: row.periodSeconds,
      timestamp: this.#clock.nowMs(),
      window: TOTP_WINDOW,
    });
  }

  #stepFor(periodSeconds: number, delta: number): bigint {
    return BigInt(Math.floor(this.#clock.nowMs() / 1_000 / periodSeconds) + delta);
  }

  async #loadRow(userId: string, id: string): Promise<TotpRow> {
    const result = await this.#db.query(
      `SELECT id, sealed_secret, digits, period_seconds, algorithm, last_used_step
       FROM totp_secrets WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthError('invalid_credential', 'no such enrolment');
    return mapTotp(row);
  }

  async #loadConfirmed(userId: string): Promise<TotpRow | null> {
    const result = await this.#db.query(
      `SELECT id, sealed_secret, digits, period_seconds, algorithm, last_used_step
       FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTotp(row);
  }
}

interface TotpRow {
  readonly id: string;
  readonly sealedSecret: Uint8Array;
  readonly digits: number;
  readonly periodSeconds: number;
  readonly algorithm: string;
  readonly lastUsedStep: bigint | null;
}

function mapTotp(row: Record<string, unknown>): TotpRow {
  const lastUsedStep = row['last_used_step'];
  return {
    id: String(row['id']),
    sealedSecret: asBytes(row['sealed_secret']),
    digits: Number(row['digits']),
    periodSeconds: Number(row['period_seconds']),
    algorithm: String(row['algorithm']),
    lastUsedStep:
      lastUsedStep === null || lastUsedStep === undefined ? null : BigInt(String(lastUsedStep)),
  };
}
