// SPDX-License-Identifier: MIT
/**
 * The security runtime: key custody and the identity context, constructed once at
 * boot and torn down on `SIGTERM`.
 *
 * **Boot is unattended (03 §2.2 Tier 1).** With `${SECRETS_DIR}/master_key`
 * present the process derives the KEK and reaches `unlocked` with no interaction.
 * That is a requirement, not a convenience: the memo is explicit that a manual
 * unlock ceremony after every power cut gets bypassed within a month, and the
 * bypass is `KEK=hunter2` in a `.env`.
 *
 * Three states the API can be in, and all three must boot successfully:
 *
 * - **`not_started`** — no user exists yet. `just bootstrap-user` has not been run.
 *   `/health` and `/auth/unlock-state` answer; everything else is 503.
 * - **`locked`** — a user exists but the passphrase is absent or no longer derives
 *   the stored KEK. This is the state a future `/unlock` page (Tier 2) renders, and
 *   it is the recovery path for a host where TPM sealing broke after a firmware
 *   update (Tier 3's prerequisite).
 * - **`unlocked`** — normal operation.
 *
 * Failing to boot in the first two states would be the wrong behaviour: a container
 * that crash-loops tells the operator nothing, while one that serves a 503 with a
 * reason tells them exactly what to do.
 */
import { describeKek, type AppConfig } from '@core/config';
import type { Clock } from '@core/kernel';
import { SecretBox, type UnlockState } from '@core/secretbox';
import {
  createIdentityContext,
  UserService,
  type IdentityContext,
  type IdentityQueryable,
} from '@ctx/identity';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../problem.ts';

export interface SecurityRuntimeOptions {
  readonly config: AppConfig;
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly logger: FastifyBaseLogger;
}

export class SecurityRuntime {
  readonly #options: SecurityRuntimeOptions;
  #secretBox: SecretBox | null = null;
  #identity: IdentityContext | null = null;
  #state: UnlockState = { state: 'locked', reason: 'not_started' };
  #initialising: Promise<void> | null = null;

  constructor(options: SecurityRuntimeOptions) {
    this.#options = options;
  }

  /**
   * Derive the KEK and wire the identity context. Idempotent, and safe to call
   * again later: `just bootstrap-user` can create the user while the API is
   * already running, and the next request should pick it up rather than needing a
   * restart.
   */
  async initialise(): Promise<UnlockState> {
    if (this.#state.state === 'unlocked') return this.#state;
    // Collapse concurrent callers: Argon2id at 1 GiB is six seconds and four
    // parallel derivations would be four gigabytes.
    this.#initialising ??= this.#doInitialise().finally(() => {
      this.#initialising = null;
    });
    await this.#initialising;
    return this.#state;
  }

  unlockState(): UnlockState {
    return this.#state;
  }

  get isUnlocked(): boolean {
    return this.#state.state === 'unlocked';
  }

  /** The identity context, or a 503 problem naming the reason. */
  requireIdentity(): IdentityContext {
    if (this.#identity === null) throw lockedError(this.#state);
    return this.#identity;
  }

  requireSecretBox(): SecretBox {
    if (this.#secretBox === null) throw lockedError(this.#state);
    return this.#secretBox;
  }

  /** A `UserService` that works before the KEK is available, for bootstrap checks. */
  users(): UserService {
    return new UserService({ db: this.#options.db, clock: this.#options.clock });
  }

  /** Wipe the KEK and every cached DEK. Wired to `SIGTERM` in `main.ts`. */
  destroy(): void {
    this.#secretBox?.destroy();
    this.#secretBox = null;
    this.#identity = null;
    this.#state = { state: 'locked', reason: 'not_started' };
  }

  async #doInitialise(): Promise<void> {
    const { config, db, clock, logger } = this.#options;

    const user = await this.users().findPrimary();
    if (user === null) {
      this.#state = { state: 'locked', reason: 'not_started' };
      logger.warn(
        'no user exists yet; run `just bootstrap-user` to create one and enrol the first passkey',
      );
      return;
    }

    const passphrase = config.secrets.master_key;
    if (passphrase === undefined) {
      this.#state = { state: 'locked', reason: 'no_passphrase' };
      logger.error('master_key secret is absent; the application is locked');
      return;
    }

    const secretBox = new SecretBox({
      db,
      userId: user.id,
      clock,
      kdfParams: config.kek.params,
      kdfFloor: config.kek.floor,
    });

    // `reveal()` is the one place the passphrase leaves its `Redacted` box, and it
    // goes straight into the KDF. It is never assigned to a field, never logged,
    // and never placed on `config`.
    const state = await secretBox.unlock(passphrase.reveal());
    this.#state = state;

    if (state.state !== 'unlocked') {
      secretBox.destroy();
      logger.error({ reason: state.reason }, 'key custody: locked');
      return;
    }

    this.#secretBox = secretBox;
    this.#identity = createIdentityContext({
      db,
      clock,
      secretBox,
      rpId: config.env.AUTH_RP_ID,
      rpName: config.env.AUTH_RP_NAME,
      allowedOrigins: config.allowedOrigins,
      sessionTtls: {
        idleSeconds: config.env.SESSION_IDLE_TTL_SECONDS,
        absoluteSeconds: config.env.SESSION_ABSOLUTE_TTL_SECONDS,
        trustedSeconds: config.env.SESSION_TRUSTED_TTL_SECONDS,
        stepUpSeconds: config.env.SESSION_STEP_UP_TTL_SECONDS,
      },
      failureDelayMs: config.env.AUTH_FAILURE_DELAY_MS,
    });

    // P0-2's evidence: "startup log shows KDF params and duration". Parameters and
    // timing only; the salt is public and the key is not in this object at all.
    logger.info(
      { kek: describeKek(config, state.kdf.durationMs), kekVersion: state.kekVersion },
      'key custody: unlocked',
    );
    if (state.rotationRecommended) {
      logger.warn(
        'the stored KEK was derived with parameters below the current floor; rotate it',
      );
    }
  }
}

function lockedError(state: UnlockState): AppError {
  const reason = state.state === 'locked' ? state.reason : 'not_started';
  const detail =
    reason === 'not_started'
      ? 'No user has been created yet. Run `just bootstrap-user` on the host.'
      : 'The encryption key is not available; the application is locked.';
  return new AppError({
    status: 503,
    code: reason === 'not_started' ? 'not_bootstrapped' : 'locked',
    title: 'Service Unavailable',
    detail,
    family: 'internal',
  });
}
