// SPDX-License-Identifier: MIT
/**
 * The two guards every authenticated route in the application shares.
 *
 * They live here rather than inside `routes/auth.ts` because WP 1.5 added four
 * more routers and a per-router copy of "resolve the session, or 401" is a
 * control a future router forgets to add — the same argument that put the CSRF
 * gate at the root of `app.ts`. One implementation, imported by everything, is
 * also one place to read when the question is "what exactly does step-up mean
 * here?".
 *
 * `requireFreshSession` is decision D21's gate: a WebAuthn assertion from within
 * the last five minutes. It guards adding and removing a connection, exporting
 * the ledger, and the auth settings themselves. The class of attack it exists
 * for is a *stolen session cookie*: possession of the cookie must not be enough
 * to enrol a passkey, read a provider credential, or walk out with a CSV of
 * every transaction the user has ever made.
 */
import type { RequestContext, SessionRecord } from '@ctx/identity';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../problem.ts';
import { SESSION_COOKIE } from './cookies.ts';
import type { SecurityRuntime } from './runtime.ts';

export interface Guards {
  /** The caller's session, or 401. Slides the idle window as a side effect. */
  requireSession(request: FastifyRequest): Promise<SessionRecord>;
  /** The caller's session, or 401/403. Needs a step-up within the last 5 minutes. */
  requireFreshSession(request: FastifyRequest): Promise<SessionRecord>;
  /** The session, if there is one. For routes where absence is not an error. */
  optionalSession(request: FastifyRequest): Promise<SessionRecord | null>;
  contextOf(request: FastifyRequest): RequestContext;
}

export function unauthenticated(): AppError {
  return new AppError({
    status: 401,
    code: 'not_authenticated',
    title: 'Unauthorized',
    detail: 'Sign in to continue.',
    family: 'user',
  });
}

export function stepUpRequired(): AppError {
  return new AppError({
    status: 403,
    code: 'step_up_required',
    title: 'Forbidden',
    detail: 'This operation needs a recent passkey assertion. Call /auth/step-up/options.',
    family: 'user',
  });
}

export function createGuards(runtime: SecurityRuntime): Guards {
  async function requireSession(request: FastifyRequest): Promise<SessionRecord> {
    const identity = runtime.requireIdentity();
    const token = request.cookies[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) throw unauthenticated();
    const session = await identity.sessions.authenticate(token);
    if (session === null) throw unauthenticated();
    return session;
  }

  return {
    requireSession,

    async requireFreshSession(request: FastifyRequest): Promise<SessionRecord> {
      const identity = runtime.requireIdentity();
      const session = await requireSession(request);
      if (!identity.sessions.isFresh(session)) throw stepUpRequired();
      return session;
    },

    async optionalSession(request: FastifyRequest): Promise<SessionRecord | null> {
      if (!runtime.isUnlocked) return null;
      const token = request.cookies[SESSION_COOKIE];
      if (typeof token !== 'string' || token.length === 0) return null;
      return runtime.requireIdentity().sessions.authenticate(token);
    },

    contextOf(request: FastifyRequest): RequestContext {
      return {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        correlationId: String(request.id),
      };
    },
  };
}
