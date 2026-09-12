// SPDX-License-Identifier: MIT
/**
 * `/auth/*` — the authentication surface (decision D21, P0-4, P0-5, P0-14, P1-2, P1-3).
 *
 * Every route is schema-first: one Zod schema validates the request, serialises the
 * response, and becomes the OpenAPI document, so the generated frontend client and
 * the server cannot drift.
 *
 * Two rules hold across the whole file:
 *
 * - **Nothing here reports why authentication failed.** Every rejection is
 *   `invalid_credential`; the *reason* goes to `security_events`. An error taxonomy
 *   the caller can read is an enumeration oracle.
 * - **Raw tokens go in cookies, never in a response body.** A token in JSON is a
 *   token in the browser's memory, in a devtools tab, and eventually in a bug
 *   report.
 */
import { isAuthError, type IssuedSession, type SessionRecord } from '@ctx/identity';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, problemSchema } from '../problem.ts';
import {
  clearSessionCookies,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  setSessionCookies,
  type CookiePolicy,
} from '../auth/cookies.ts';
import { ensureCsrfCookie } from '../auth/csrf.ts';
import type { SecurityRuntime } from '../auth/runtime.ts';

export interface AuthRouteOptions {
  readonly runtime: SecurityRuntime;
  readonly cookiePolicy: CookiePolicy;
}

// ---------------------------------------------------------------- schemas

/**
 * WebAuthn payloads are passed through as opaque JSON.
 *
 * Deliberate: `@simplewebauthn/server` is the authority on their shape and
 * validates them cryptographically. A hand-written Zod mirror of
 * `RegistrationResponseJSON` would be a second, weaker spec that silently rejects
 * a valid response the day a browser adds a field.
 */
const webauthnPayload = z
  .record(z.string(), z.unknown())
  .describe('A WebAuthn response as produced by @simplewebauthn/browser.');

/**
 * Widen a SimpleWebAuthn options object to the record the schema serialises.
 *
 * `PublicKeyCredentialCreationOptionsJSON` is an interface with no index
 * signature, so TypeScript refuses `as Record<string, unknown>` outright (TS2352)
 * even though every value is already plain JSON — the library builds these out of
 * strings, numbers and base64url, and `generateRegistrationOptions` is what
 * defines their shape. The two-step widening through `unknown` is the honest
 * spelling of "this is JSON and the schema above says so"; the alternative, a
 * hand-written Zod mirror of the WebAuthn types, is a second and weaker spec that
 * would start rejecting valid responses the first time a browser adds a field.
 */
function asJsonObject(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/**
 * The inverse, at the boundary where a validated request body goes back into the
 * library that defines its type. `T` is inferred from the parameter it is passed
 * to, so the call sites below name no WebAuthn type and `apps/api` needs no
 * dependency on `@simplewebauthn/server`.
 */
function asWebAuthnResponse<T>(value: Record<string, unknown>): T {
  return value as unknown as T;
}

const okResponse = z.object({ ok: z.literal(true) }).meta({ id: 'AuthOk' });

const unlockStateResponse = z
  .object({
    state: z.enum(['unlocked', 'locked']),
    reason: z.enum(['no_passphrase', 'passphrase_mismatch', 'not_started']).optional(),
    bootstrapped: z.boolean().describe('Whether a user account exists yet.'),
    kekVersion: z.number().int().optional(),
    rotationRecommended: z.boolean().optional(),
  })
  .meta({ id: 'UnlockState' });

const sessionResponse = z
  .object({
    userId: z.string(),
    displayName: z.string(),
    displayTimezone: z.string(),
    authMethod: z.enum(['webauthn', 'totp', 'recovery_code', 'bootstrap']),
    trustedDevice: z.boolean(),
    fresh: z.boolean().describe('Whether a step-up assertion is still within its window.'),
    idleExpiresAt: z.string(),
    absoluteExpiresAt: z.string(),
    credentialCount: z.number().int(),
    totpEnrolled: z.boolean(),
    recoveryCodesRemaining: z.number().int(),
  })
  .meta({ id: 'SessionState' });

const credentialSchema = z
  .object({
    id: z.string(),
    credentialId: z.string(),
    friendlyName: z.string(),
    transports: z.array(z.string()),
    aaguid: z.string().nullable(),
    backedUp: z.boolean(),
    deviceType: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .meta({ id: 'Credential' });

const securityEventSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    kind: z.string(),
    outcome: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'SecurityEvent' });

// ------------------------------------------------------------------ plugin

export const authRoutes = (options: AuthRouteOptions): FastifyPluginAsyncZod => {
  const { runtime, cookiePolicy } = options;

  /** Resolve the caller's session, or 401. Slides the idle window as a side effect. */
  async function requireSession(request: FastifyRequest): Promise<SessionRecord> {
    const identity = runtime.requireIdentity();
    const token = request.cookies[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) throw unauthenticated();
    const session = await identity.sessions.authenticate(token);
    if (session === null) throw unauthenticated();
    return session;
  }

  /**
   * Require a WebAuthn assertion from within the last five minutes (P1-2).
   *
   * Other packages will call the equivalent for Plaid Item add/remove, credential
   * reads, exports and sidecar acknowledgements. Here it guards the auth settings
   * themselves, which is the same class of operation: a stolen session cookie must
   * not be able to enrol a second passkey and make itself permanent.
   */
  async function requireFreshSession(request: FastifyRequest): Promise<SessionRecord> {
    const identity = runtime.requireIdentity();
    const session = await requireSession(request);
    if (!identity.sessions.isFresh(session)) {
      throw new AppError({
        status: 403,
        code: 'step_up_required',
        title: 'Forbidden',
        detail: 'This operation needs a recent passkey assertion. Call /auth/step-up/options.',
        family: 'user',
      });
    }
    return session;
  }

  function contextOf(request: FastifyRequest) {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      correlationId: String(request.id),
    };
  }

  function applySession(reply: FastifyReply, issued: IssuedSession): void {
    const maxAge = Math.max(
      1,
      Math.ceil(
        (issued.session.familyExpiresAt.getTime() - issued.session.createdAt.getTime()) / 1_000,
      ),
    );
    setSessionCookies(reply, cookiePolicy, {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      refreshMaxAgeSeconds: maxAge,
    });
  }

  return async (app) => {
    // Every reply that can precede a mutation carries a CSRF token, so the login
    // POST has one to echo without a preliminary round trip.
    app.addHook('onRequest', async (request, reply) => {
      ensureCsrfCookie(request, reply, cookiePolicy);
    });

    app.get(
      '/auth/unlock-state',
      {
        schema: {
          operationId: 'getUnlockState',
          summary: 'Key custody and bootstrap state',
          description:
            'Reports whether the encryption key is available and whether a user exists. ' +
            'Answers while the application is locked, which is what makes a future unlock page possible.',
          tags: ['auth'],
          response: { 200: unlockStateResponse },
        },
      },
      async () => {
        const state = await runtime.initialise();
        const bootstrapped = (await runtime.users().findPrimary()) !== null;
        if (state.state === 'unlocked') {
          return {
            state: 'unlocked' as const,
            bootstrapped,
            kekVersion: state.kekVersion,
            rotationRecommended: state.rotationRecommended,
          };
        }
        return { state: 'locked' as const, reason: state.reason, bootstrapped };
      },
    );

    app.get(
      '/auth/session',
      {
        schema: {
          operationId: 'getSession',
          summary: 'The current session',
          tags: ['auth'],
          response: { 200: sessionResponse, 401: problemSchema, 503: problemSchema },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireSession(request);
        const user = await identity.users.findById(session.userId);
        if (user === null) throw unauthenticated();
        const [credentials, totpEnrolled, recoveryCodesRemaining] = await Promise.all([
          identity.webauthn.listCredentials(session.userId),
          identity.totp.isEnrolled(session.userId),
          identity.recoveryCodes.remainingCount(session.userId),
        ]);
        return {
          userId: user.id,
          displayName: user.displayName,
          displayTimezone: user.displayTimezone,
          authMethod: session.authMethod,
          trustedDevice: session.trustedDevice,
          fresh: identity.sessions.isFresh(session),
          idleExpiresAt: session.idleExpiresAt.toISOString(),
          absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
          credentialCount: credentials.length,
          totpEnrolled,
          recoveryCodesRemaining,
        };
      },
    );

    // ------------------------------------------------------------ registration

    app.post(
      '/auth/register/options',
      {
        schema: {
          operationId: 'startRegistration',
          summary: 'Begin enrolling a passkey',
          description:
            'Supply the one-time enrolment token from `just bootstrap-user`, or call with a ' +
            'session that has stepped up in the last five minutes to add a second authenticator.',
          tags: ['auth'],
          body: z.object({ registrationToken: z.string().min(16).optional() }),
          response: {
            200: z.object({ userId: z.string(), options: webauthnPayload }),
            403: problemSchema,
            503: problemSchema,
          },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session =
          request.body.registrationToken === undefined
            ? await requireFreshSession(request)
            : undefined;
        const result = await mapAuthErrors(() =>
          identity.flows.beginRegistration({
            registrationToken: request.body.registrationToken,
            session,
            context: contextOf(request),
          }),
        );
        return { userId: result.userId, options: asJsonObject(result.options) };
      },
    );

    app.post(
      '/auth/register/verify',
      {
        schema: {
          operationId: 'finishRegistration',
          summary: 'Complete enrolling a passkey',
          tags: ['auth'],
          body: z.object({
            userId: z.string().uuid(),
            friendlyName: z.string().min(1).max(64),
            response: webauthnPayload,
          }),
          response: {
            200: z.object({
              credential: credentialSchema,
              credentialCount: z.number().int(),
              signedIn: z.boolean(),
              /** 03 §3.2: one passkey on one device is a self-inflicted denial of service. */
              enrolSecondAuthenticator: z.boolean(),
            }),
            400: problemSchema,
            503: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const identity = runtime.requireIdentity();
        const existingSession = await optionalSession(request);
        const result = await mapAuthErrors(() =>
          identity.flows.completeRegistration({
            userId: request.body.userId,
            response: asWebAuthnResponse(request.body.response),
            friendlyName: request.body.friendlyName,
            issueSession: existingSession === null,
            context: contextOf(request),
          }),
        );
        if (result.session !== null) applySession(reply, result.session);
        return {
          credential: serialiseCredential(result.credential),
          credentialCount: result.credentialCount,
          signedIn: result.session !== null,
          enrolSecondAuthenticator: result.credentialCount < 2,
        };
      },
    );

    // ----------------------------------------------------------------- login

    app.post(
      '/auth/login/options',
      {
        schema: {
          operationId: 'startLogin',
          summary: 'Begin a passkey login',
          description:
            'Returns a challenge with an empty `allowCredentials`: discoverable credentials give ' +
            'usernameless login, and an empty list tells an unauthenticated caller nothing about ' +
            'which authenticators exist.',
          tags: ['auth'],
          response: { 200: z.object({ options: webauthnPayload }), 503: problemSchema },
        },
      },
      async () => {
        const identity = runtime.requireIdentity();
        const options = await identity.webauthn.startAuthentication('authentication');
        return { options: asJsonObject(options) };
      },
    );

    app.post(
      '/auth/login/verify',
      {
        schema: {
          operationId: 'finishLogin',
          summary: 'Complete a passkey login',
          tags: ['auth'],
          body: z.object({
            response: webauthnPayload,
            /** D21's convenience toggle: extends the refresh window to 14 days. */
            trustedDevice: z.boolean().default(false),
          }),
          response: { 200: okResponse, 401: problemSchema, 429: problemSchema, 503: problemSchema },
        },
      },
      async (request, reply) => {
        const identity = runtime.requireIdentity();
        const issued = await mapAuthErrors(() =>
          identity.flows.loginWithPasskey({
            response: asWebAuthnResponse(request.body.response),
            trustedDevice: request.body.trustedDevice,
            context: contextOf(request),
          }),
        );
        applySession(reply, issued);
        return { ok: true } as const;
      },
    );

    app.post(
      '/auth/totp/verify',
      {
        schema: {
          operationId: 'loginWithTotp',
          summary: 'Log in with the TOTP fallback',
          description:
            'Secondary factor. The resulting session is deliberately not step-up fresh, so it ' +
            'cannot read a provider credential without a passkey assertion first.',
          tags: ['auth'],
          body: z.object({
            token: z.string().regex(/^[0-9]{6,8}$/),
            trustedDevice: z.boolean().default(false),
          }),
          response: { 200: okResponse, 401: problemSchema, 429: problemSchema, 503: problemSchema },
        },
      },
      async (request, reply) => {
        const identity = runtime.requireIdentity();
        const issued = await mapAuthErrors(() =>
          identity.flows.loginWithTotp({
            token: request.body.token,
            trustedDevice: request.body.trustedDevice,
            context: contextOf(request),
          }),
        );
        applySession(reply, issued);
        return { ok: true } as const;
      },
    );

    app.post(
      '/auth/recovery-code/verify',
      {
        schema: {
          operationId: 'loginWithRecoveryCode',
          summary: 'Log in with a single-use recovery code',
          tags: ['auth'],
          body: z.object({ code: z.string().min(8).max(32) }),
          response: {
            200: z.object({ ok: z.literal(true), remainingCodes: z.number().int() }),
            401: problemSchema,
            429: problemSchema,
            503: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const identity = runtime.requireIdentity();
        const issued = await mapAuthErrors(() =>
          identity.flows.loginWithRecoveryCode({
            code: request.body.code,
            context: contextOf(request),
          }),
        );
        applySession(reply, issued);
        return { ok: true as const, remainingCodes: issued.remainingCodes };
      },
    );

    // --------------------------------------------------------------- step-up

    app.post(
      '/auth/step-up/options',
      {
        schema: {
          operationId: 'startStepUp',
          summary: 'Begin a step-up assertion',
          tags: ['auth'],
          response: { 200: z.object({ options: webauthnPayload }), 401: problemSchema },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireSession(request);
        const options = await identity.webauthn.startAuthentication('step_up', session.userId);
        return { options: asJsonObject(options) };
      },
    );

    app.post(
      '/auth/step-up/verify',
      {
        schema: {
          operationId: 'finishStepUp',
          summary: 'Complete a step-up assertion',
          description: 'Marks the session fresh for five minutes.',
          tags: ['auth'],
          body: z.object({ response: webauthnPayload }),
          response: {
            200: z.object({ freshUntil: z.string() }),
            401: problemSchema,
            429: problemSchema,
          },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireSession(request);
        const freshUntil = await mapAuthErrors(() =>
          identity.flows.stepUp({
            session,
            response: asWebAuthnResponse(request.body.response),
            context: contextOf(request),
          }),
        );
        return { freshUntil: freshUntil.toISOString() };
      },
    );

    // -------------------------------------------------------------- sessions

    app.post(
      '/auth/refresh',
      {
        schema: {
          operationId: 'refreshSession',
          summary: 'Rotate the session',
          description:
            'Single-use. Presenting a refresh token that has already been rotated revokes the ' +
            'entire session family: that is the cookie-theft signal.',
          tags: ['auth'],
          response: { 200: okResponse, 401: problemSchema, 429: problemSchema },
        },
      },
      async (request, reply) => {
        const identity = runtime.requireIdentity();
        const token = request.cookies[REFRESH_COOKIE];
        if (typeof token !== 'string' || token.length === 0) throw unauthenticated();
        try {
          const issued = await identity.flows.refresh(token, contextOf(request));
          applySession(reply, issued);
          return { ok: true } as const;
        } catch (error) {
          // Reuse detection has already revoked the family; drop the cookies so the
          // browser stops replaying a token that is now poison.
          clearSessionCookies(reply, cookiePolicy);
          throw toProblemError(error);
        }
      },
    );

    app.post(
      '/auth/logout',
      {
        schema: {
          operationId: 'logout',
          summary: 'Revoke the current session family',
          tags: ['auth'],
          response: { 200: okResponse },
        },
      },
      async (request, reply) => {
        const session = await optionalSession(request);
        if (session !== null) {
          const identity = runtime.requireIdentity();
          await identity.sessions.revokeFamily(session.familyId, 'logout');
        }
        clearSessionCookies(reply, cookiePolicy);
        return { ok: true } as const;
      },
    );

    // ----------------------------------------------------------- credentials

    app.get(
      '/auth/credentials',
      {
        schema: {
          operationId: 'listCredentials',
          summary: 'Enrolled passkeys',
          tags: ['auth'],
          response: {
            200: z.object({
              credentials: z.array(credentialSchema),
              enrolSecondAuthenticator: z.boolean(),
            }),
            401: problemSchema,
          },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireSession(request);
        const credentials = await identity.webauthn.listCredentials(session.userId);
        return {
          credentials: credentials.map(serialiseCredential),
          enrolSecondAuthenticator: credentials.length < 2,
        };
      },
    );

    app.delete(
      '/auth/credentials/:credentialId',
      {
        schema: {
          operationId: 'removeCredential',
          summary: 'Remove a passkey',
          description: 'Needs a step-up assertion. The last remaining passkey cannot be removed.',
          tags: ['auth'],
          params: z.object({ credentialId: z.string().uuid() }),
          response: { 200: okResponse, 403: problemSchema, 409: problemSchema },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireFreshSession(request);
        await mapAuthErrors(() =>
          identity.webauthn.removeCredential(session.userId, request.params.credentialId),
        );
        await identity.flows.recordCredentialRemoved(
          session.userId,
          request.params.credentialId,
          contextOf(request),
        );
        return { ok: true } as const;
      },
    );

    // ------------------------------------------------------------------ totp

    app.post(
      '/auth/totp/enroll',
      {
        schema: {
          operationId: 'enrolTotp',
          summary: 'Begin TOTP enrolment',
          description:
            'Returns the seed once. It is sealed with SecretBox before it reaches the database, ' +
            'so this response is the only place it is ever readable.',
          tags: ['auth'],
          response: {
            200: z.object({ enrolmentId: z.string(), secret: z.string(), uri: z.string() }),
            403: problemSchema,
          },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireFreshSession(request);
        const user = await identity.users.findById(session.userId);
        const enrolment = await identity.totp.enrol(
          session.userId,
          user?.displayName ?? 'PersonalFi',
        );
        return { enrolmentId: enrolment.id, secret: enrolment.secret, uri: enrolment.uri };
      },
    );

    app.post(
      '/auth/totp/confirm',
      {
        schema: {
          operationId: 'confirmTotp',
          summary: 'Confirm TOTP enrolment with a generated code',
          tags: ['auth'],
          body: z.object({
            enrolmentId: z.string().uuid(),
            token: z.string().regex(/^[0-9]{6,8}$/),
          }),
          response: { 200: okResponse, 400: problemSchema, 403: problemSchema },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireFreshSession(request);
        await mapAuthErrors(() =>
          identity.totp.confirm(session.userId, request.body.enrolmentId, request.body.token),
        );
        await identity.flows.recordTotpEnrolled(session.userId, contextOf(request));
        return { ok: true } as const;
      },
    );

    // -------------------------------------------------------- recovery codes

    app.post(
      '/auth/recovery-codes',
      {
        schema: {
          operationId: 'generateRecoveryCodes',
          summary: 'Generate ten single-use recovery codes',
          description:
            'Replaces any existing set. The codes are returned once and are Argon2id-hashed at ' +
            'rest; there is no way to see them again.',
          tags: ['auth'],
          response: {
            200: z.object({ codes: z.array(z.string()).length(10) }),
            403: problemSchema,
          },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireFreshSession(request);
        const generated = await identity.recoveryCodes.generate(session.userId);
        await identity.flows.recordRecoveryCodesGenerated(session.userId, contextOf(request));
        return { codes: [...generated.codes] };
      },
    );

    // ----------------------------------------------------------------- audit

    app.get(
      '/auth/events',
      {
        schema: {
          operationId: 'listSecurityEvents',
          summary: 'The security event log',
          tags: ['auth'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
          response: { 200: z.object({ events: z.array(securityEventSchema) }), 401: problemSchema },
        },
      },
      async (request) => {
        const identity = runtime.requireIdentity();
        const session = await requireSession(request);
        const events = await identity.flows.listEvents(session.userId, request.query.limit);
        return {
          events: events.map((event) => ({
            id: event.id,
            occurredAt: event.occurredAt.toISOString(),
            kind: event.kind,
            outcome: event.outcome,
            detail: event.detail,
          })),
        };
      },
    );

    /** The session, if there is one. Used where absence is not an error. */
    async function optionalSession(request: FastifyRequest): Promise<SessionRecord | null> {
      if (!runtime.isUnlocked) return null;
      const token = request.cookies[SESSION_COOKIE];
      if (typeof token !== 'string' || token.length === 0) return null;
      return runtime.requireIdentity().sessions.authenticate(token);
    }
  };
};

function serialiseCredential(credential: {
  id: string;
  credentialId: string;
  friendlyName: string;
  transports: readonly string[];
  aaguid: string | null;
  backedUp: boolean;
  deviceType: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}): z.infer<typeof credentialSchema> {
  return {
    id: credential.id,
    credentialId: credential.credentialId,
    friendlyName: credential.friendlyName,
    transports: [...credential.transports],
    aaguid: credential.aaguid,
    backedUp: credential.backedUp,
    deviceType: credential.deviceType,
    createdAt: credential.createdAt.toISOString(),
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
  };
}

function unauthenticated(): AppError {
  return new AppError({
    status: 401,
    code: 'not_authenticated',
    title: 'Unauthorized',
    detail: 'Sign in to continue.',
    family: 'user',
  });
}

async function mapAuthErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toProblemError(error);
  }
}

/**
 * Map a domain `AuthError` onto a problem detail.
 *
 * The interesting line is the default: anything the identity context refuses
 * becomes a flat 401 `invalid_credential`. "No such credential", "bad signature"
 * and "already-used recovery code" must be indistinguishable to the caller.
 */
function toProblemError(error: unknown): unknown {
  if (!isAuthError(error)) return error;
  switch (error.code) {
    case 'rate_limited':
    case 'locked_out':
      return new AppError({
        status: 429,
        code: error.code,
        title: 'Too Many Requests',
        detail: `Too many attempts. Try again in ${String(error.retryAfterSeconds ?? 60)} seconds.`,
        family: 'user',
      });
    case 'step_up_required':
      return new AppError({
        status: 403,
        code: 'step_up_required',
        title: 'Forbidden',
        detail: 'This operation needs a recent passkey assertion.',
        family: 'user',
      });
    case 'session_reuse_detected':
      return new AppError({
        status: 401,
        code: 'session_reuse_detected',
        title: 'Unauthorized',
        detail: 'This session was terminated because a session token was replayed. Sign in again.',
        family: 'user',
      });
    case 'session_expired':
      return unauthenticated();
    case 'last_credential':
      return new AppError({
        status: 409,
        code: 'last_credential',
        title: 'Conflict',
        detail: 'The last passkey cannot be removed. Enrol another first.',
        family: 'domain',
      });
    case 'credential_in_use':
      return new AppError({
        status: 409,
        code: 'credential_in_use',
        title: 'Conflict',
        detail: 'That authenticator is already enrolled.',
        family: 'domain',
      });
    case 'already_bootstrapped':
    case 'not_bootstrapped':
      return new AppError({
        status: 409,
        code: error.code,
        title: 'Conflict',
        detail: error.message,
        family: 'domain',
      });
    default:
      return new AppError({
        status: 401,
        code: 'invalid_credential',
        title: 'Unauthorized',
        detail: 'That credential is not valid.',
        family: 'user',
      });
  }
}
