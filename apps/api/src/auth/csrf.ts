// SPDX-License-Identifier: MIT
/**
 * CSRF defence (03 §3.4, P1-3). Three independent controls, because
 * `SameSite=Strict` alone has been quietly bypassed too many times to be a plan.
 *
 * 1. **`Sec-Fetch-Site`**, when the browser sends it. `same-origin` and `none`
 *    pass; `cross-site` and `same-site` do not. This is the strongest signal
 *    available — it comes from the browser, not from the page — and it is the
 *    cheapest.
 * 2. **`Origin` allow-list.** Checked whenever the header is present, and
 *    *required* on mutations when `Sec-Fetch-Site` is absent. A mutation that can
 *    prove neither is rejected: fail closed.
 * 3. **Double-submit token**, compared in constant time. The `__Host-pfi_csrf`
 *    cookie is readable by our own script and by nobody else's, so echoing it in
 *    `X-CSRF-Token` proves the request was composed on our origin.
 *
 * Only unsafe methods are checked. A `GET` that changes state is a bug to fix at
 * the route, not a case to handle here.
 */
import { constantTimeEqual, randomBytes, sha256 } from '@core/secretbox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../problem.ts';
import { CSRF_COOKIE, CSRF_HEADER, setCsrfCookie, type CookiePolicy } from './cookies.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function newCsrfToken(): string {
  return Buffer.from(randomBytes(32)).toString('base64url');
}

function csrfRejected(detail: string): AppError {
  return new AppError({
    status: 403,
    code: 'csrf_failed',
    title: 'Forbidden',
    detail,
    family: 'user',
  });
}

export interface CsrfOptions {
  readonly allowedOrigins: readonly string[];
  readonly cookiePolicy: CookiePolicy;
}

/**
 * Mint the CSRF cookie whenever it is missing.
 *
 * It has to exist before the first login POST, and a login page that must first
 * call a "get me a token" endpoint is a login page with an extra failure mode.
 */
export function ensureCsrfCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: CookiePolicy,
): string {
  const existing = request.cookies[CSRF_COOKIE];
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const token = newCsrfToken();
  setCsrfCookie(reply, policy, token);
  return token;
}

export function assertCsrf(request: FastifyRequest, options: CsrfOptions): void {
  if (SAFE_METHODS.has(request.method)) return;

  const fetchSite = request.headers['sec-fetch-site'];
  const origin = request.headers['origin'];

  if (typeof fetchSite === 'string') {
    if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
      throw csrfRejected('This request did not originate from the application.');
    }
  } else if (typeof origin !== 'string') {
    // Neither signal. A browser always sends at least one on a cross-origin
    // mutation, so the absence of both is either a very old client or a tool —
    // and a tool has no business posting with an ambient cookie.
    throw csrfRejected('A same-origin request is required for this operation.');
  }

  if (typeof origin === 'string' && !options.allowedOrigins.includes(origin)) {
    throw csrfRejected('This request did not originate from an allowed origin.');
  }

  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (typeof cookie !== 'string' || typeof header !== 'string') {
    throw csrfRejected('A CSRF token is required for this operation.');
  }
  // Hash both sides first so the comparison is over fixed-length inputs and
  // `constantTimeEqual` cannot short-circuit on a length difference.
  const encoder = new TextEncoder();
  if (!constantTimeEqual(sha256(encoder.encode(cookie)), sha256(encoder.encode(header)))) {
    throw csrfRejected('The CSRF token did not match.');
  }
}
