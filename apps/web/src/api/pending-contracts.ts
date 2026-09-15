// SPDX-License-Identifier: MIT
/**
 * Hand-written client for `/api/auth/*` (Caddy's `handle_path /api/*` strips
 * the prefix before it reaches the API, which still mounts this router at
 * `/auth/*` — gate-security-review.md F-4/C-1a), mirroring 11 of the 18
 * operations.
 *
 * It exists for three request-level behaviours the generated client does not
 * have: `ensureCsrfCookie()` plus the `x-csrf-token` header (without which
 * every mutation is `403 csrf_failed` on a cold session), the `body ??= '{}'`
 * default (without which the payload-free POSTs hit Fastify's
 * `fst_err_ctp_empty_json_body`), and `credentials: 'include'` on every call.
 *
 * TODO(auth-wiring): move those three into a `@hey-api` request interceptor
 * beside `client-runtime-config.ts` and delete this file. The call sites change
 * shape rather than name — `…Options()` and `…Mutation()` are option factories,
 * so `useSessionQuery()` becomes `useQuery(getSessionOptions())`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mirrors apps/api/src/auth/cookies.ts's CSRF_COOKIE / CSRF_HEADER. */
const CSRF_COOKIE_NAME = '__Host-pfi_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

function readCsrfToken(): string | undefined {
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match?.slice(CSRF_COOKIE_NAME.length + 1);
}

/**
 * Guarantee a `__Host-pfi_csrf` cookie exists before the first mutation of a
 * cold browser session (gate-security-review-2.md, P0-4).
 *
 * The API mints that cookie from an `onRequest` hook on the `/auth/*` plugin,
 * so *any* reply from that prefix carries one — but only a reply. A browser
 * that lands directly on `/register?token=...` or `/login` has never made an
 * `/api/auth/*` request, so its first request is the mutation itself, which
 * is rejected `403 csrf_failed` before the freshly-minted cookie is of any
 * use. That made first-run passkey enrolment and every cold-start login
 * impossible: the failure was structural, not racy.
 *
 * `/api/auth/unlock-state` is the right primer: it is a GET (so the CSRF
 * check skips it), it requires no session, and it answers while the app is
 * locked.
 */
async function ensureCsrfCookie(): Promise<void> {
  if (readCsrfToken() !== undefined) return;
  await fetch('/api/auth/unlock-state', { credentials: 'include' }).catch(() => undefined);
}

/**
 * A generic RFC 9457 problem, close enough for a shell to render *something*
 * useful. The generated client will have the real per-route problem unions;
 * this file only needs "did it fail, and what should the user read."
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const problemSchema = z.object({
  status: z.number().optional(),
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
});

/**
 * Exported so `pending-contracts.test.ts` can exercise the credentials and
 * header-merging contract directly, rather than through a route wrapper.
 */
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  // Caller headers are merged into the base set here, and `init` is spread
  // *before* `credentials` and `headers` further down, so a caller can add a
  // header but cannot drop `credentials: 'include'` or the CSRF token.
  const headers: Record<string, string> = {
    ...JSON_HEADERS,
    ...(init.headers as Record<string, string> | undefined),
  };
  // `body` is normalised for mutations below, so `init.body` must not win the
  // spread further down — pull it out here and pass the resolved value.
  let body = init.body;
  if (MUTATING_METHODS.has(method)) {
    await ensureCsrfCookie();
    const csrf = readCsrfToken();
    if (csrf !== undefined) headers[CSRF_HEADER_NAME] = csrf;
    // Fastify's JSON content-type parser rejects an *empty* body with
    // `400 fst_err_ctp_empty_json_body` whenever `Content-Type:
    // application/json` is set — which `JSON_HEADERS` sets unconditionally.
    // `startLogin`, `startStepUp` and `logout` legitimately send no payload,
    // so all three 400'd on every call: passkey login, step-up and sign-out
    // were dead in the shipped bundle (gate-security-review-2.md, P0-4).
    // An empty JSON object satisfies the parser and every one of those routes,
    // none of which declares a required body field.
    body ??= '{}';
  }

  // `body` is spread conditionally rather than named outright: under
  // `exactOptionalPropertyTypes` an explicit `body: undefined` is not a legal
  // `RequestInit`, and a safe method must reach `fetch` with no body at all
  // rather than a synthesised one.
  const response = await fetch(path, {
    ...init,
    method,
    ...(body === undefined ? {} : { body }),
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem = problemSchema.safeParse(body);
    throw new ApiError(
      response.status,
      problem.success ? (problem.data.code ?? 'unknown') : 'unknown',
      problem.success && problem.data.detail !== undefined
        ? problem.data.detail
        : `Request to ${path} failed (${String(response.status)}).`,
    );
  }

  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

/* ------------------------------------------------------------------------ */
/* Schemas — hand-copied from apps/api/src/routes/auth.ts                    */
/* ------------------------------------------------------------------------ */

/** Opaque WebAuthn JSON, passed through unvalidated on this side too — see auth.ts's rationale. */
const webauthnPayloadSchema = z.record(z.string(), z.unknown());
export type WebauthnPayload = z.infer<typeof webauthnPayloadSchema>;

const unlockStateSchema = z.object({
  state: z.enum(['unlocked', 'locked']),
  reason: z.enum(['no_passphrase', 'passphrase_mismatch', 'not_started']).optional(),
  bootstrapped: z.boolean(),
  kekVersion: z.number().int().optional(),
  rotationRecommended: z.boolean().optional(),
});
export type UnlockState = z.infer<typeof unlockStateSchema>;

const sessionStateSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  displayTimezone: z.string(),
  authMethod: z.enum(['webauthn', 'totp', 'recovery_code', 'bootstrap']),
  trustedDevice: z.boolean(),
  fresh: z.boolean(),
  idleExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
  credentialCount: z.number().int(),
  totpEnrolled: z.boolean(),
  recoveryCodesRemaining: z.number().int(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

const credentialSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  friendlyName: z.string(),
  transports: z.array(z.string()),
  aaguid: z.string().nullable(),
  backedUp: z.boolean(),
  deviceType: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Credential = z.infer<typeof credentialSchema>;

const okSchema = z.object({ ok: z.literal(true) });

/* ------------------------------------------------------------------------ */
/* Functions — one per operationId in apps/api/src/routes/auth.ts            */
/* ------------------------------------------------------------------------ */

export function getUnlockState(): Promise<UnlockState> {
  return apiFetch('/api/auth/unlock-state', unlockStateSchema);
}

export function getSession(): Promise<SessionState> {
  return apiFetch('/api/auth/session', sessionStateSchema);
}

export function startRegistration(body: {
  registrationToken?: string;
}): Promise<{ userId: string; options: WebauthnPayload }> {
  return apiFetch(
    '/api/auth/register/options',
    z.object({ userId: z.string(), options: webauthnPayloadSchema }),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function finishRegistration(body: {
  userId: string;
  friendlyName: string;
  response: WebauthnPayload;
}): Promise<{
  credential: Credential;
  credentialCount: number;
  signedIn: boolean;
  enrolSecondAuthenticator: boolean;
}> {
  return apiFetch(
    '/api/auth/register/verify',
    z.object({
      credential: credentialSchema,
      credentialCount: z.number().int(),
      signedIn: z.boolean(),
      enrolSecondAuthenticator: z.boolean(),
    }),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function startLogin(): Promise<{ options: WebauthnPayload }> {
  return apiFetch('/api/auth/login/options', z.object({ options: webauthnPayloadSchema }), {
    method: 'POST',
  });
}

export function finishLogin(body: {
  response: WebauthnPayload;
  trustedDevice?: boolean;
}): Promise<{ ok: true }> {
  return apiFetch('/api/auth/login/verify', okSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function loginWithTotp(body: {
  token: string;
  trustedDevice?: boolean;
}): Promise<{ ok: true }> {
  return apiFetch('/api/auth/totp/verify', okSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function loginWithRecoveryCode(body: {
  code: string;
}): Promise<{ ok: true; remainingCodes: number }> {
  return apiFetch(
    '/api/auth/recovery-code/verify',
    z.object({ ok: z.literal(true), remainingCodes: z.number().int() }),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function startStepUp(): Promise<{ options: WebauthnPayload }> {
  return apiFetch('/api/auth/step-up/options', z.object({ options: webauthnPayloadSchema }), {
    method: 'POST',
  });
}

export function finishStepUp(body: { response: WebauthnPayload }): Promise<{ freshUntil: string }> {
  return apiFetch('/api/auth/step-up/verify', z.object({ freshUntil: z.string() }), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch('/api/auth/logout', okSchema, { method: 'POST' });
}

/**
 * Shared by `useSessionQuery` below, the `/_app` auth guard
 * (`src/routes/_app.tsx`), and `IdleLockOverlay`/`LockScreen`'s unlock
 * refetch, so all four name the key once between them.
 */
export const sessionQueryKey = ['auth', 'session'] as const;

/* ------------------------------------------------------------------------ */
/* React Query hooks — named as the generated client's plugin would name     */
/* them (one hook per operationId), so the eventual rename in the "one-file  */
/* change" above is mechanical.                                             */
/* ------------------------------------------------------------------------ */

export function useUnlockStateQuery() {
  return useQuery({ queryKey: ['auth', 'unlock-state'], queryFn: getUnlockState });
}

export function useSessionQuery(enabled = true) {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    enabled,
    retry: false,
  });
}

export function useStartRegistrationMutation() {
  return useMutation({ mutationFn: startRegistration });
}

export function useFinishRegistrationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finishRegistration,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

export function useStartLoginMutation() {
  return useMutation({ mutationFn: startLogin });
}

export function useFinishLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finishLogin,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

export function useTotpLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: loginWithTotp,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

export function useRecoveryCodeLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: loginWithRecoveryCode,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

export function useStartStepUpMutation() {
  return useMutation({ mutationFn: startStepUp });
}

export function useFinishStepUpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finishStepUp,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

/**
 * Logout must forget not just who is signed in but everything that session's
 * queries ever cached — balances, transactions, anything added later.
 * `clear()` removes every cache entry outright; `invalidateQueries` would only
 * mark them stale and leave the last-fetched data readable until a refetch
 * completes.
 */
export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.clear(),
  });
}
