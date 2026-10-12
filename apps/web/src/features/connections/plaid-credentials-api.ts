// SPDX-License-Identifier: MIT
/**
 * `/connections/providers/plaid/credentials` (WP 10.1) - a holder's own Plaid keys, kept by the product.
 *
 * Typed locally with `apiFetch` (CSRF header, `credentials: 'include'`, the problem body as an `ApiError`
 * whose `.code` is what `isStepUpRequiredError` reads) until the generated client carries the three
 * operations (`getPlaidCredentials`, `putPlaidCredentials`, `deletePlaidCredentials`); the schema below is
 * the route's own response, hand-copied from `apps/api/src/routes/provider-credentials.ts`.
 *
 * **Nothing here can hold a secret in a response**: the status has no field for one. The secret travels
 * once, in the `PUT` body, and the form clears it from its own state before the request is sent.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch } from '../../api/pending-contracts.ts';
import { listConnectorsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';

const PATH = '/api/connections/providers/plaid/credentials';

export const plaidCredentialsStatusSchema = z.object({
  configured: z.boolean(),
  source: z.enum(['files', 'stored', 'none']),
  env: z.enum(['sandbox', 'production']).nullable(),
  clientIdHint: z.string().nullable(),
  rotatedAt: z.string().nullable(),
  productionAllowed: z.boolean(),
});

export type PlaidCredentialsStatus = z.infer<typeof plaidCredentialsStatusSchema>;

export interface PlaidCredentialsInput {
  readonly clientId: string;
  readonly secret: string;
  readonly env: 'sandbox' | 'production';
}

export const PLAID_CREDENTIALS_KEY = ['plaid-credentials'] as const;

/**
 * `GET` - session only. `retry: false`: a deployment or a build that does not answer this route (an older
 * api during an upgrade) must degrade to "no Plaid setup offered", not spin on retries inside the dialog.
 */
export function usePlaidCredentialsQuery() {
  return useQuery({
    queryKey: PLAID_CREDENTIALS_KEY,
    queryFn: () => apiFetch(PATH, plaidCredentialsStatusSchema),
    staleTime: 30_000,
    retry: false,
  });
}

/** Both the status and the connector list change when credentials do: Plaid appears in, or leaves, `GET /connectors`. */
function useInvalidateAfterChange() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PLAID_CREDENTIALS_KEY }),
      queryClient.invalidateQueries({ queryKey: listConnectorsOptions().queryKey }),
    ]);
  };
}

/** `PUT` - step-up gated; the api checks the keys with Plaid before storing them. */
export function useSavePlaidCredentialsMutation() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (body: PlaidCredentialsInput) =>
      apiFetch(PATH, plaidCredentialsStatusSchema, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

/** `DELETE` - step-up gated; revokes nothing at Plaid. */
export function useRemovePlaidCredentialsMutation() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: () => apiFetch(PATH, plaidCredentialsStatusSchema, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
