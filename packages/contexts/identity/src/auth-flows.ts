// SPDX-License-Identifier: MIT
/**
 * The composed authentication flows.
 *
 * The individual services are deliberately dumb — `WebAuthnService` verifies an
 * assertion and nothing else, `RateLimiter` counts and nothing else. This file is
 * where they are wired into the sequence every flow must follow, *once*:
 *
 *     rate limit → lockout check → verify → record failure or success →
 *     security event → issue or rotate a session → latency floor
 *
 * Having one place for that order is the point. A second login endpoint that
 * forgot the lockout check, or a TOTP path that logged success on failure, is
 * exactly the bug that gets shipped when each route assembles its own sequence.
 */
import type { Clock } from '@core/kernel';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { IdentityQueryable } from './db.ts';
import { AuthError } from './errors.ts';
import { RateLimiter } from './rate-limit.ts';
import { RecoveryCodeService } from './recovery.ts';
import {
  listSecurityEvents,
  recordSecurityEvent,
  type RequestContext,
  type SecurityEventSummary,
} from './security-events.ts';
import { SessionService, type IssuedSession, type SessionRecord } from './sessions.ts';
import { TotpService } from './totp.ts';
import { UserService } from './users.ts';
import { WebAuthnService, type CredentialSummary } from './webauthn.ts';

export interface AuthFlowOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly users: UserService;
  readonly webauthn: WebAuthnService;
  readonly totp: TotpService;
  readonly recoveryCodes: RecoveryCodeService;
  readonly sessions: SessionService;
  readonly rateLimiter: RateLimiter;
  /**
   * Fixed latency floor on *failed* authentication, so "unknown credential" and
   * "wrong TOTP code" cannot be told apart by a stopwatch (03 §3.4). Set to 0 in
   * tests; 250 ms in production.
   */
  readonly failureDelayMs: number;
}

export class AuthFlows {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #users: UserService;
  readonly #webauthn: WebAuthnService;
  readonly #totp: TotpService;
  readonly #recovery: RecoveryCodeService;
  readonly #sessions: SessionService;
  readonly #limiter: RateLimiter;
  readonly #failureDelayMs: number;

  constructor(options: AuthFlowOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#users = options.users;
    this.#webauthn = options.webauthn;
    this.#totp = options.totp;
    this.#recovery = options.recoveryCodes;
    this.#sessions = options.sessions;
    this.#limiter = options.rateLimiter;
    this.#failureDelayMs = options.failureDelayMs;
  }

  /** Usernameless passkey login. The primary path, and the only one on the front page. */
  async loginWithPasskey(input: {
    response: AuthenticationResponseJSON;
    trustedDevice?: boolean;
    context: RequestContext;
  }): Promise<IssuedSession> {
    const subject = subjectOf(input.context);
    await this.#limiter.consume('webauthn', subject);

    let assertion;
    try {
      assertion = await this.#webauthn.finishAuthentication({
        response: input.response,
        purpose: 'authentication',
      });
    } catch (error) {
      await this.#failure('webauthn', subject, null, 'auth.webauthn.failure', input.context, {
        reason: error instanceof AuthError ? error.code : 'unknown',
      });
      throw error;
    }

    await this.#limiter.recordSuccess('webauthn', subject);
    const issued = await this.#sessions.issue({
      userId: assertion.userId,
      authMethod: 'webauthn',
      trustedDevice: input.trustedDevice === true,
      // A passkey assertion *is* a step-up, so the session starts fresh and the
      // user is not challenged twice inside five minutes of signing in.
      fresh: true,
      context: input.context,
    });

    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'auth.webauthn.success',
      outcome: 'success',
      userId: assertion.userId,
      detail: {
        credentialRowId: assertion.credentialRowId,
        trustedDevice: input.trustedDevice === true,
      },
      context: input.context,
    });
    return issued;
  }

  /**
   * Step-up: a fresh assertion that buys five minutes of elevated privilege.
   *
   * Required by P1-2 for credential access, Item add/remove, export, changing auth
   * settings, unlocking the KEK, and any sidecar-originated action. The session is
   * not re-issued: the *same* session becomes fresh, so a step-up cannot be used to
   * launder a session whose absolute cap is about to expire.
   */
  async stepUp(input: {
    session: SessionRecord;
    response: AuthenticationResponseJSON;
    context: RequestContext;
  }): Promise<Date> {
    const subject = `user:${input.session.userId}`;
    await this.#limiter.consume('webauthn', subject, input.session.userId);

    try {
      await this.#webauthn.finishAuthentication({
        response: input.response,
        purpose: 'step_up',
        userId: input.session.userId,
      });
    } catch (error) {
      await this.#failure(
        'webauthn',
        subject,
        input.session.userId,
        'auth.webauthn.failure',
        input.context,
        { stepUp: true },
      );
      throw error;
    }

    await this.#limiter.recordSuccess('webauthn', subject);
    const freshUntil = await this.#sessions.markFresh(input.session.id);
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'auth.step_up',
      outcome: 'success',
      userId: input.session.userId,
      detail: { sessionId: input.session.id },
      context: input.context,
    });
    return freshUntil;
  }

  /**
   * TOTP login. Secondary: the session it issues is **not** step-up fresh, so it
   * cannot immediately read a Plaid credential — that still needs a passkey.
   */
  async loginWithTotp(input: {
    token: string;
    trustedDevice?: boolean;
    context: RequestContext;
  }): Promise<IssuedSession> {
    const user = await this.#users.findPrimary();
    if (user === null) throw new AuthError('not_bootstrapped', 'no user exists yet');
    const subject = `user:${user.id}`;
    await this.#limiter.consume('totp', subject, user.id);

    const ok = await this.#totp.verify(user.id, input.token);
    if (!ok) {
      await this.#failure('totp', subject, user.id, 'auth.totp.failure', input.context, {});
      throw new AuthError('invalid_credential', 'that code is not valid');
    }

    await this.#limiter.recordSuccess('totp', subject);
    const issued = await this.#sessions.issue({
      userId: user.id,
      authMethod: 'totp',
      trustedDevice: input.trustedDevice === true,
      fresh: false,
      context: input.context,
    });
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'auth.totp.success',
      outcome: 'success',
      userId: user.id,
      context: input.context,
    });
    return issued;
  }

  /** Break glass. Same posture as TOTP: a session, but not a fresh one. */
  async loginWithRecoveryCode(input: {
    code: string;
    context: RequestContext;
  }): Promise<IssuedSession & { remainingCodes: number }> {
    const user = await this.#users.findPrimary();
    if (user === null) throw new AuthError('not_bootstrapped', 'no user exists yet');
    const subject = `user:${user.id}`;
    await this.#limiter.consume('recovery_code', subject, user.id);

    const ok = await this.#recovery.consume(user.id, input.code);
    if (!ok) {
      await this.#failure(
        'recovery_code',
        subject,
        user.id,
        'auth.recovery_code.failure',
        input.context,
        {},
      );
      throw new AuthError('invalid_credential', 'that recovery code is not valid');
    }

    await this.#limiter.recordSuccess('recovery_code', subject);
    const issued = await this.#sessions.issue({
      userId: user.id,
      authMethod: 'recovery_code',
      fresh: false,
      context: input.context,
    });
    const remaining = await this.#recovery.remainingCount(user.id);
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'auth.recovery_code.success',
      outcome: 'success',
      userId: user.id,
      detail: { remainingCodes: remaining },
      context: input.context,
    });
    return { ...issued, remainingCodes: remaining };
  }

  /**
   * Begin enrolling a passkey.
   *
   * Two entry points and no third. Either a one-time bootstrap token — the only
   * way in on a box with no credentials, redeemed here so a replayed link cannot
   * mint a second challenge — or an existing session that has stepped up within
   * the last five minutes. An unauthenticated registration endpoint would be an
   * account-takeover primitive behind one misconfigured proxy.
   */
  async beginRegistration(input: {
    registrationToken?: string | undefined;
    session?: SessionRecord | undefined;
    context: RequestContext;
  }): Promise<{
    userId: string;
    options: Awaited<ReturnType<WebAuthnService['startRegistration']>>;
  }> {
    await this.#limiter.consume('register', subjectOf(input.context));

    let userId: string;
    let userName: string;
    if (input.registrationToken !== undefined) {
      const user = await this.#users.redeemRegistrationToken(input.registrationToken);
      userId = user.id;
      userName = user.displayName;
    } else if (input.session !== undefined) {
      if (!this.#sessions.isFresh(input.session)) {
        throw new AuthError('step_up_required', 'a recent passkey assertion is required');
      }
      const user = await this.#users.findById(input.session.userId);
      if (user === null) throw new AuthError('not_bootstrapped', 'no such user');
      userId = user.id;
      userName = user.displayName;
    } else {
      throw new AuthError('step_up_required', 'an enrolment token or a fresh session is required');
    }

    return { userId, options: await this.#webauthn.startRegistration(userId, userName) };
  }

  /**
   * Finish enrolling a passkey.
   *
   * When there is no session yet this is the bootstrap path, and it issues one —
   * having just proved possession of an authenticator, making the operator log in
   * again immediately would be ceremony with no security content.
   */
  async completeRegistration(input: {
    userId: string;
    response: RegistrationResponseJSON;
    friendlyName: string;
    issueSession: boolean;
    context: RequestContext;
  }): Promise<{
    credential: CredentialSummary;
    session: IssuedSession | null;
    credentialCount: number;
  }> {
    const credential = await this.#webauthn.finishRegistration({
      userId: input.userId,
      response: input.response,
      friendlyName: input.friendlyName,
    });
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'credential.added',
      outcome: 'success',
      userId: input.userId,
      detail: { credentialRowId: credential.id, bootstrap: input.issueSession },
      context: input.context,
    });

    const session = input.issueSession
      ? await this.#sessions.issue({
          userId: input.userId,
          authMethod: 'webauthn',
          fresh: true,
          context: input.context,
        })
      : null;

    const credentialCount = (await this.#webauthn.listCredentials(input.userId)).length;
    return { credential, session, credentialCount };
  }

  /** Refresh with reuse detection. The detection itself lives in `SessionService`. */
  async refresh(refreshToken: string, context: RequestContext): Promise<IssuedSession> {
    await this.#limiter.consume('refresh', subjectOf(context));
    return this.#sessions.refresh(refreshToken, context);
  }

  // -------------------------------------------------------------- audit only
  //
  // Thin wrappers so routes never call `recordSecurityEvent` directly. That keeps
  // the one-writer property honest: if the audit trail is ever wrong, the fix is
  // in this file rather than scattered across a dozen handlers.

  async recordCredentialRemoved(
    userId: string,
    credentialRowId: string,
    context: RequestContext,
  ): Promise<void> {
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'credential.removed',
      outcome: 'success',
      userId,
      detail: { credentialRowId },
      context,
    });
  }

  async recordTotpEnrolled(userId: string, context: RequestContext): Promise<void> {
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'totp.enrolled',
      outcome: 'success',
      userId,
      context,
    });
  }

  async recordRecoveryCodesGenerated(userId: string, context: RequestContext): Promise<void> {
    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'recovery_codes.generated',
      outcome: 'success',
      userId,
      detail: { count: 10 },
      context,
    });
  }

  async listEvents(userId: string, limit: number): Promise<SecurityEventSummary[]> {
    return listSecurityEvents(this.#db, userId, limit);
  }

  async #failure(
    bucket: string,
    subject: string,
    userId: string | null,
    kind: Parameters<typeof recordSecurityEvent>[2]['kind'],
    context: RequestContext,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const outcome = await this.#limiter.recordFailure(bucket, subject, userId);
    await recordSecurityEvent(this.#db, this.#clock, {
      kind,
      outcome: 'failure',
      userId,
      detail: { ...detail, consecutiveFailures: outcome.consecutiveFailures },
      context,
    });
    if (outcome.lockedUntil !== null) {
      await recordSecurityEvent(this.#db, this.#clock, {
        kind: 'auth.locked_out',
        outcome: 'blocked',
        userId,
        detail: { bucket, lockedUntil: outcome.lockedUntil.toISOString() },
        context,
      });
    }
    await this.#applyFailureDelay();
  }

  /**
   * Normalise failure latency.
   *
   * Uses a real timer rather than a busy loop so it costs nothing but wall time,
   * and is a *floor* on the failure path only — deliberately not an equalisation of
   * success and failure, which would need a fixed budget larger than the slowest
   * Argon2id verification and would make every login feel broken.
   */
  async #applyFailureDelay(): Promise<void> {
    if (this.#failureDelayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.#failureDelayMs));
  }
}

/**
 * The rate-limit subject for an unauthenticated request.
 *
 * Behind Caddy on a LAN this is usually one address, which makes the IP limit a
 * global limit on the auth endpoints — acceptable, and in fact desirable, for one
 * user. `unknown` is its own bucket rather than an error: a request with no
 * recoverable address must still be counted, not exempted.
 */
function subjectOf(context: RequestContext): string {
  return `ip:${context.ip ?? 'unknown'}`;
}
