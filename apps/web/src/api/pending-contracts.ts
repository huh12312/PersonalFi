// SPDX-License-Identifier: MIT
/**
 * Stand-in for the generated OpenAPI client, scoped to `/auth/*`.
 *
 * `apps/api/src/routes/auth.ts` exists and is schema-first (every route's zod
 * schema *is* its OpenAPI document contribution — see that file's header
 * comment), but at the time this package was built it had not yet been
 * registered against the running Fastify app, so `packages/contracts/openapi/
 * openapi.json` did not yet carry `/auth/*` and `pnpm --filter @app/web gen`
 * had nothing to generate for it.
 *
 * TODO(auth-wiring): once `/auth/*` is live in the generated OpenAPI document,
 * this file becomes dead code. The swap is a **one-file change**:
 *
 *   1. `pnpm --filter @app/web gen` (regenerates `src/api/generated` from the
 *      now-complete contract; the `@tanstack/react-query` plugin already
 *      configured in `openapi-ts.shared.mjs` emits one query/mutation hook per
 *      `operationId` — the same `operationId`s this file's function and hook
 *      names below mirror on purpose: `getUnlockState` -> `useGetUnlockState`,
 *      etc.).
 *   2. Delete this file.
 *   3. In every file under `src/features/auth/` that imports from
 *      `../../api/pending-contracts.ts`, swap the import for
 *      `../../api/generated/@tanstack/react-query.gen.ts` (or wherever the
 *      plugin emits them) and rename each hook call to the generated name.
 *
 * No component logic changes: the shapes below are hand-copied from
 * `apps/api/src/routes/auth.ts`'s zod schemas field-for-field, so the
 * generated types will be structurally identical.
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

async function apiFetch<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (MUTATING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf !== undefined) headers[CSRF_HEADER_NAME] = csrf;
  }

  const response = await fetch(path, { credentials: 'include', ...init, headers });

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
export const webauthnPayloadSchema = z.record(z.string(), z.unknown());
export type WebauthnPayload = z.infer<typeof webauthnPayloadSchema>;

export const unlockStateSchema = z.object({
  state: z.enum(['unlocked', 'locked']),
  reason: z.enum(['no_passphrase', 'passphrase_mismatch', 'not_started']).optional(),
  bootstrapped: z.boolean(),
  kekVersion: z.number().int().optional(),
  rotationRecommended: z.boolean().optional(),
});
export type UnlockState = z.infer<typeof unlockStateSchema>;

export const sessionStateSchema = z.object({
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

export const credentialSchema = z.object({
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
  return apiFetch('/auth/unlock-state', unlockStateSchema);
}

export function getSession(): Promise<SessionState> {
  return apiFetch('/auth/session', sessionStateSchema);
}

export function startRegistration(body: {
  registrationToken?: string;
}): Promise<{ userId: string; options: WebauthnPayload }> {
  return apiFetch(
    '/auth/register/options',
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
    '/auth/register/verify',
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
  return apiFetch('/auth/login/options', z.object({ options: webauthnPayloadSchema }), {
    method: 'POST',
  });
}

export function finishLogin(body: {
  response: WebauthnPayload;
  trustedDevice?: boolean;
}): Promise<{ ok: true }> {
  return apiFetch('/auth/login/verify', okSchema, { method: 'POST', body: JSON.stringify(body) });
}

export function loginWithTotp(body: {
  token: string;
  trustedDevice?: boolean;
}): Promise<{ ok: true }> {
  return apiFetch('/auth/totp/verify', okSchema, { method: 'POST', body: JSON.stringify(body) });
}

export function loginWithRecoveryCode(body: {
  code: string;
}): Promise<{ ok: true; remainingCodes: number }> {
  return apiFetch(
    '/auth/recovery-code/verify',
    z.object({ ok: z.literal(true), remainingCodes: z.number().int() }),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function startStepUp(): Promise<{ options: WebauthnPayload }> {
  return apiFetch('/auth/step-up/options', z.object({ options: webauthnPayloadSchema }), {
    method: 'POST',
  });
}

export function finishStepUp(body: { response: WebauthnPayload }): Promise<{ freshUntil: string }> {
  return apiFetch('/auth/step-up/verify', z.object({ freshUntil: z.string() }), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch('/auth/logout', okSchema, { method: 'POST' });
}

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
    queryKey: ['auth', 'session'],
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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}

export function useStartLoginMutation() {
  return useMutation({ mutationFn: startLogin });
}

export function useFinishLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finishLogin,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}

export function useTotpLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: loginWithTotp,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}

export function useRecoveryCodeLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: loginWithRecoveryCode,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}

export function useStartStepUpMutation() {
  return useMutation({ mutationFn: startStepUp });
}

export function useFinishStepUpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finishStepUp,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auth', 'session'] }),
  });
}
