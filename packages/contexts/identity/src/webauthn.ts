// SPDX-License-Identifier: MIT
/**
 * Passkeys (03 §3.2, decision D21, P0-4).
 *
 * The posture, and why each knob is where it is:
 *
 * - `residentKey: 'required'` + `userVerification: 'required'` — discoverable
 *   credentials give usernameless login, which is the correct UX for a one-user
 *   app: land on the page, touch the sensor, in. There is no username to type
 *   because there is no ambiguity about who is logging in.
 * - `attestationType: 'none'` — attestation verification buys nothing for a single
 *   known user and drags in a metadata-service dependency.
 * - ES256 (-7) and EdDSA (-8) only. **RS256 is rejected.**
 * - `authenticatorAttachment` unset, so both platform authenticators (a phone) and
 *   roaming ones (a YubiKey) are allowed. 03 §3.2 asks for at least two enrolled,
 *   because one passkey on one phone is a self-inflicted denial of service;
 *   `credentialCount` is exposed so the UI can nag until there is a second.
 * - The RP ID is configuration and must be **fixed early**: changing it invalidates
 *   every enrolled passkey, so a Tailscale-name → custom-domain move mid-project
 *   costs Chris his credentials.
 *
 * Challenges live in `webauthn_challenges`, not in a signed cookie, because
 * single-use is a `DELETE` and not a cookie attribute.
 */
import { newId, type Clock } from '@core/kernel';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { asBytes, asDate, asOptionalDate, toParam, type IdentityQueryable } from './db.ts';
import { AuthError } from './errors.ts';

/** COSE algorithm identifiers. RS256 (-257) is deliberately absent. */
const SUPPORTED_ALGORITHMS = [-8, -7];

const CHALLENGE_TTL_SECONDS = 300;

export type ChallengePurpose = 'registration' | 'authentication' | 'step_up';

export interface CredentialSummary {
  readonly id: string;
  readonly credentialId: string;
  readonly friendlyName: string;
  readonly transports: readonly string[];
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly deviceType: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface WebAuthnServiceOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly rpId: string;
  readonly rpName: string;
  readonly allowedOrigins: readonly string[];
}

export interface VerifiedAssertion {
  readonly credentialId: string;
  readonly credentialRowId: string;
  readonly userId: string;
  readonly userVerified: boolean;
}

export class WebAuthnService {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #rpId: string;
  readonly #rpName: string;
  readonly #origins: readonly string[];

  constructor(options: WebAuthnServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#rpId = options.rpId;
    this.#rpName = options.rpName;
    this.#origins = options.allowedOrigins;
  }

  // ------------------------------------------------------------ registration

  async startRegistration(
    userId: string,
    userName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.listCredentials(userId);
    const options = await generateRegistrationOptions({
      rpName: this.#rpName,
      rpID: this.#rpId,
      userName,
      userID: new TextEncoder().encode(userId),
      userDisplayName: userName,
      attestationType: 'none',
      // Offering the already-registered credentials stops the authenticator
      // silently creating a second credential for the same key, which would look
      // like two devices and behave like one.
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: [...credential.transports],
      })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
    await this.#storeChallenge(userId, options.challenge, 'registration');
    return options;
  }

  async finishRegistration(input: {
    userId: string;
    response: RegistrationResponseJSON;
    friendlyName: string;
  }): Promise<CredentialSummary> {
    const challenge = await this.#consumeChallenge(input.userId, 'registration');

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challenge,
        expectedOrigin: [...this.#origins],
        expectedRPID: this.#rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      });
    } catch {
      // The library's messages are informative and would make a fine oracle.
      throw new AuthError('invalid_credential', 'the registration could not be verified');
    }

    if (!verification.verified) {
      throw new AuthError('invalid_credential', 'the registration could not be verified');
    }

    const info = verification.registrationInfo;
    const credentialIdBytes = base64UrlToBytes(info.credential.id);

    const duplicate = await this.#db.query(
      `SELECT id FROM webauthn_credentials WHERE credential_id = $1`,
      [toParam(credentialIdBytes)],
    );
    if (duplicate.rows.length > 0) {
      throw new AuthError('credential_in_use', 'that authenticator is already enrolled');
    }

    const id = newId();
    const result = await this.#db.query(
      `INSERT INTO webauthn_credentials (
         id, user_id, credential_id, public_key, sign_count, transports, aaguid,
         backup_eligible, backed_up, device_type, friendly_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, credential_id, friendly_name, transports, aaguid, backed_up, device_type, created_at, last_used_at`,
      [
        id,
        input.userId,
        toParam(credentialIdBytes),
        toParam(info.credential.publicKey),
        BigInt(info.credential.counter),
        info.credential.transports ?? [],
        info.aaguid,
        info.credentialDeviceType === 'multiDevice',
        info.credentialBackedUp,
        info.credentialDeviceType,
        input.friendlyName,
        this.#clock.now(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthError('invalid_credential', 'credential insert failed');
    return mapCredential(row);
  }

  // ---------------------------------------------------------- authentication

  /**
   * Options for a usernameless login.
   *
   * `allowCredentials` is left empty on purpose: with discoverable credentials the
   * client asks the user which passkey to use, and an empty list means the response
   * does not leak which credentials exist to an unauthenticated caller.
   */
  async startAuthentication(
    purpose: 'authentication' | 'step_up',
    userId?: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.#rpId,
      userVerification: 'required',
    });
    await this.#storeChallenge(userId ?? null, options.challenge, purpose);
    return options;
  }

  async finishAuthentication(input: {
    response: AuthenticationResponseJSON;
    purpose: 'authentication' | 'step_up';
    userId?: string | undefined;
  }): Promise<VerifiedAssertion> {
    const challenge = await this.#consumeChallenge(input.userId ?? null, input.purpose);
    const credentialIdBytes = base64UrlToBytes(input.response.id);

    const found = await this.#db.query(
      `SELECT id, user_id, credential_id, public_key, sign_count, transports
       FROM webauthn_credentials WHERE credential_id = $1`,
      [toParam(credentialIdBytes)],
    );
    const row = found.rows[0];
    if (row === undefined) {
      throw new AuthError('invalid_credential', 'the assertion could not be verified');
    }
    const credentialRowId = String(row['id']);
    const userId = String(row['user_id']);
    if (input.userId !== undefined && input.userId !== userId) {
      throw new AuthError('invalid_credential', 'the assertion could not be verified');
    }

    const storedCounter = BigInt(String(row['sign_count']));
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challenge,
        expectedOrigin: [...this.#origins],
        expectedRPID: this.#rpId,
        requireUserVerification: true,
        credential: {
          id: input.response.id,
          publicKey: asBytes(row['public_key']),
          counter: Number(storedCounter),
          transports: (row['transports'] as string[] | null) ?? [],
        },
      });
    } catch {
      throw new AuthError('invalid_credential', 'the assertion could not be verified');
    }

    if (!verification.verified) {
      throw new AuthError('invalid_credential', 'the assertion could not be verified');
    }

    // A counter that fails to advance on an authenticator that uses one means a
    // clone. Authenticators that always report 0 (most platform passkeys) are
    // exempt, which is why the check is `> 0n` rather than `>= 0n`.
    const newCounter = BigInt(verification.authenticationInfo.newCounter);
    if (storedCounter > 0n && newCounter <= storedCounter) {
      throw new AuthError('invalid_credential', 'the assertion could not be verified');
    }

    await this.#db.query(
      `UPDATE webauthn_credentials
       SET sign_count = $2, last_used_at = $3, backed_up = $4
       WHERE id = $1`,
      [
        credentialRowId,
        newCounter,
        this.#clock.now(),
        verification.authenticationInfo.credentialBackedUp,
      ],
    );

    return {
      credentialId: input.response.id,
      credentialRowId,
      userId,
      userVerified: verification.authenticationInfo.userVerified,
    };
  }

  /** True when the stored counter did not advance — the clone signal, for the event log. */
  async counterRegressed(credentialRowId: string, reported: number): Promise<boolean> {
    const result = await this.#db.query(
      `SELECT sign_count FROM webauthn_credentials WHERE id = $1`,
      [credentialRowId],
    );
    const stored = result.rows[0]?.['sign_count'];
    if (stored === undefined) return false;
    const storedCounter = BigInt(String(stored));
    return storedCounter > 0n && BigInt(reported) <= storedCounter;
  }

  // -------------------------------------------------------------- management

  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    const result = await this.#db.query(
      `SELECT id, credential_id, friendly_name, transports, aaguid, backed_up, device_type, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return result.rows.map(mapCredential);
  }

  /**
   * Remove a credential, refusing to remove the last one.
   *
   * Not paternalism: with no credentials and no recovery code the only way back in
   * is a database edit, and the point of the whole design is that there is no such
   * back door.
   */
  async removeCredential(userId: string, credentialRowId: string): Promise<void> {
    const all = await this.listCredentials(userId);
    if (all.length <= 1) {
      throw new AuthError('last_credential', 'the last passkey cannot be removed');
    }
    await this.#db.query(`DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2`, [
      credentialRowId,
      userId,
    ]);
  }

  async #storeChallenge(
    userId: string | null,
    challenge: string,
    purpose: ChallengePurpose,
  ): Promise<void> {
    const now = this.#clock.now();
    await this.#db.query(
      `INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newId(),
        userId,
        challenge,
        purpose,
        now,
        new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1_000),
      ],
    );
  }

  /**
   * Take the newest unconsumed challenge for this purpose and burn it.
   *
   * `UPDATE ... RETURNING` rather than select-then-update so that two concurrent
   * requests cannot both claim the same challenge.
   *
   * The `id DESC` tiebreak matters: ids are UUIDv7 and therefore time-ordered, so
   * when two challenges share a `created_at` — a frozen clock in a test, or two
   * requests inside the same microsecond — "newest" stays well defined instead of
   * resolving to whatever the planner happened to return first.
   */
  async #consumeChallenge(userId: string | null, purpose: ChallengePurpose): Promise<string> {
    const now = this.#clock.now();
    const result = await this.#db.query(
      `UPDATE webauthn_challenges SET consumed_at = $1
       WHERE id = (
         SELECT id FROM webauthn_challenges
         WHERE purpose = $2
           AND consumed_at IS NULL
           AND expires_at > $1
           AND (user_id IS NOT DISTINCT FROM $3 OR $3 IS NULL)
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING challenge`,
      [now, purpose, userId],
    );
    const challenge = result.rows[0]?.['challenge'];
    if (challenge === undefined) {
      throw new AuthError('challenge_expired', 'no pending challenge; start again');
    }
    return String(challenge);
  }

  /** Housekeeping for WP 0.3's job runner. */
  async purgeExpiredChallenges(): Promise<void> {
    await this.#db.query(`DELETE FROM webauthn_challenges WHERE expires_at < $1`, [
      new Date(this.#clock.nowMs() - 3_600_000),
    ]);
  }
}

function mapCredential(row: Record<string, unknown>): CredentialSummary {
  return {
    id: String(row['id']),
    credentialId: bytesToBase64Url(asBytes(row['credential_id'])),
    friendlyName: String(row['friendly_name']),
    transports: (row['transports'] as string[] | null) ?? [],
    aaguid: row['aaguid'] === null ? null : String(row['aaguid']),
    backedUp: Boolean(row['backed_up']),
    deviceType: String(row['device_type']),
    createdAt: asDate(row['created_at']),
    lastUsedAt: asOptionalDate(row['last_used_at']),
  };
}

export function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function bytesToBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
