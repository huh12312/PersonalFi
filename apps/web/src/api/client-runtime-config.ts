// SPDX-License-Identifier: MIT

/**
 * Structurally the same shape as the generated `CreateClientConfig` in
 * `generated/client.gen.ts` — deliberately *not* imported from there, so a
 * `pnpm gen` regeneration can never change this file's own type-checking
 * (see `createClientConfig` below for the one place the two shapes actually
 * have to line up, and `tsconfig.app.json` for why `src/api/generated`
 * itself is a normal, included part of this project rather than excluded).
 */

/**
 * Mirrors `apps/api/src/auth/cookies.ts`'s `CSRF_COOKIE` / `CSRF_HEADER` and
 * `src/api/pending-contracts.ts`'s copies of the same two constants. Kept as a
 * third copy rather than imported from `pending-contracts.ts` because that
 * file exports neither name (its `ensureCsrfCookie`/`readCsrfToken` are
 * module-private) and because this file's whole reason to exist is surviving
 * `pnpm gen` — importing from a file that is itself slated to disappear once
 * the header comment's `TODO(auth-wiring)` closes out would just move the
 * drift risk rather than remove it.
 */
const CSRF_COOKIE_NAME = '__Host-pfi_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCsrfToken(): string | undefined {
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match?.slice(CSRF_COOKIE_NAME.length + 1);
}

/**
 * Same primer as `pending-contracts.ts`'s `ensureCsrfCookie` — a browser that
 * lands directly on a deep link has made no `/auth/*` request yet, so it has
 * no `__Host-pfi_csrf` cookie the moment the *first* generated-client mutation
 * fires. `/auth/unlock-state` is a GET (skips the CSRF check), needs no
 * session, and answers while the app is locked, so it is safe to call from
 * here unconditionally.
 */
async function ensureCsrfCookie(): Promise<void> {
  if (readCsrfToken() !== undefined) return;
  await fetch('/auth/unlock-state', { credentials: 'same-origin' }).catch(() => undefined);
}

/**
 * Structural, not imported: the generated `Client` type
 * (`generated/client/types.gen.ts`) lives under the excluded
 * `src/api/generated` tree, and this file must not import from there (see the
 * class doc above `ClientRuntimeConfig`). A `Request`-in/`Request`-out
 * function is all `client.interceptors.request.use` needs.
 */
export interface InterceptableClient {
  interceptors: {
    request: {
      use: (fn: (request: Request, options: unknown) => Request | Promise<Request>) => void;
    };
  };
}

/**
 * The generated `@hey-api/client-fetch` client has no CSRF awareness at all —
 * every mutating call needs the `x-csrf-token` header
 * `apps/api/src/auth/cookies.ts` verifies, or it is `403 csrf_failed` on a
 * cold session, same as the hand-written `pending-contracts.ts` client this
 * mirrors. Registered once against the generated singleton client from
 * `src/main.tsx` (that module, not this one, may import
 * `src/api/generated/client.gen.ts` — see this file's own header), this is
 * the "request interceptor in `client-runtime-config.ts`" called for instead
 * of hand-writing new fetch calls.
 *
 * `request.headers.set(...)` mutates the `Request` created inside
 * `beforeRequest`/`request` in `generated/client/client.gen.ts` directly: a
 * `Request` built via `new Request(url, init)` carries a `"request"` header
 * guard, which permits `set`/`append` on a custom header like this one (only
 * a handful of forbidden names — `Host`, `Origin`, …, — are blocked).
 */
export function registerCsrfInterceptor(client: InterceptableClient): void {
  client.interceptors.request.use(async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return request;
    await ensureCsrfCookie();
    const token = readCsrfToken();
    if (token !== undefined) request.headers.set(CSRF_HEADER_NAME, token);
    return request;
  });
}

/**
 * Wired into codegen via `runtimeConfigPath` in `openapi-ts.shared.mjs`,
 * `@hey-api/client-fetch`'s escape hatch for exactly this case. `pnpm
 * --filter @app/web gen` regenerates `src/api/generated` from
 * `packages/contracts/openapi/openapi.json` on every run and would re-bake
 * whatever that document's `servers` entry says; this file is hand-written
 * and gitignore-exempt, so it is the one place the override survives
 * regeneration.
 *
 * Both overrides exist because the generated defaults are wrong for a
 * same-origin deployment behind Caddy:
 *
 *   - `baseUrl: ''` — every request is relative to wherever the SPA itself
 *     was served from, which is exactly where Caddy proxies `/auth`,
 *     `/health`, and `/ready` too. Taking the contract's `servers` entry
 *     instead would bake the generating machine's origin into the bundle:
 *     an environment-specific origin to get wrong, and CORS on every call.
 *   - `credentials: 'same-origin'` — without it the generated client sends
 *     no cookies at all, so every authenticated request would be anonymous.
 *     `'same-origin'` rather than `'include'` because the session cookie
 *     carries the `__Host-` prefix and must never ride a cross-origin
 *     request; there is no deployment where it should.
 */
export function createClientConfig<T extends object>(
  config?: T,
): T & { baseUrl: string; credentials: 'same-origin' } {
  return {
    ...config,
    baseUrl: '',
    credentials: 'same-origin',
  } as T & { baseUrl: string; credentials: 'same-origin' };
}
