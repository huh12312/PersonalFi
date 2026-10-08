// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  generateRecoveryCodesMutation,
  removeTotpMutation,
  revokeOtherSessionsMutation,
  revokeSessionMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { sessionQueryKey } from '../../api/pending-contracts.ts';

// `GET /auth/sessions` is not a `useQuery` on purpose: it needs a fresh passkey assertion, the answer
// is the list of every signed-in session, and nothing about it belongs in a long-lived cache.
// `SecurityScreen` fetches it through `useStepUpRetry().run` and keeps it in component state.

/** `DELETE /auth/sessions/{familyId}` — signs one session out (step-up gated). */
export function useRevokeSessionMutation() {
  return useMutation(revokeSessionMutation());
}

/** `DELETE /auth/sessions` — signs every other session out (step-up gated). */
export function useRevokeOtherSessionsMutation() {
  return useMutation(revokeOtherSessionsMutation());
}

/** `DELETE /auth/totp` — revokes the authenticator-code seed (step-up gated); the session view then reads `totpEnrolled: false`. */
export function useRemoveTotpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...removeTotpMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}

/**
 * `POST /auth/recovery-codes` — step-up gated. Replaces any existing set and returns the ten codes
 * once; the session view is refetched so the "remaining" count follows the server.
 */
export function useGenerateRecoveryCodesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...generateRecoveryCodesMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });
}
