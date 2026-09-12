// SPDX-License-Identifier: MIT
/**
 * Session cookies (03 §3.4, P0-5).
 *
 * All three carry the `__Host-` prefix, which a browser only honours when the
 * cookie is `Secure`, has `Path=/`, and has **no** `Domain` attribute. That binds
 * them to the exact origin and forecloses a whole family of cousin-domain and
 * subdomain-injection attacks for free.
 *
 * **Deviation from 03 §3.4, deliberate.** The memo asks for the refresh cookie to
 * be scoped to `Path=/api/auth/refresh`. That is incompatible with `__Host-`,
 * which requires `Path=/`, so the two controls cannot both be had. `__Host-` wins:
 * P0-5 names it explicitly, and path scoping is a weak control anyway — it narrows
 * which of *our own* requests carry the cookie, it does not stop another origin
 * from reaching it, whereas `__Host-` does. The lost defence in depth is bought
 * back by `SameSite=Strict`, the `Origin` check, and refresh reuse detection.
 */
import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = '__Host-pfi_session';
export const REFRESH_COOKIE = '__Host-pfi_refresh';
export const CSRF_COOKIE = '__Host-pfi_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface CookiePolicy {
  readonly secure: boolean;
}

interface CookieAttributes {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  maxAge?: number;
}

function base(policy: CookiePolicy, httpOnly: boolean): CookieAttributes {
  return { path: '/', httpOnly, secure: policy.secure, sameSite: 'strict' };
}

/**
 * Set the session cookies.
 *
 * No `Max-Age` on the session cookie: it is a **session cookie** in the browser's
 * sense, gone when the browser closes, and its real lifetime is the server-side
 * row. A `Max-Age` that disagreed with `idle_expires_at` would only ever be wrong
 * in one of the two useful directions.
 */
export function setSessionCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  tokens: { accessToken: string; refreshToken: string; refreshMaxAgeSeconds: number },
): void {
  reply.setCookie(SESSION_COOKIE, tokens.accessToken, base(policy, true));
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base(policy, true),
    maxAge: tokens.refreshMaxAgeSeconds,
  });
}

/**
 * The double-submit CSRF token.
 *
 * `httpOnly: false` is the whole point: the browser must be able to read it and
 * echo it in `X-CSRF-Token`. It is not a credential — it authenticates nothing,
 * it only proves the request was composed by script running on our origin, which
 * a cross-site form cannot do.
 */
export function setCsrfCookie(reply: FastifyReply, policy: CookiePolicy, token: string): void {
  reply.setCookie(CSRF_COOKIE, token, base(policy, false));
}

/** Clear every auth cookie. Used on logout and on refresh-reuse detection. */
export function clearSessionCookies(reply: FastifyReply, policy: CookiePolicy): void {
  for (const name of [SESSION_COOKIE, REFRESH_COOKIE]) {
    reply.clearCookie(name, base(policy, true));
  }
  reply.clearCookie(CSRF_COOKIE, base(policy, false));
}
