// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createConnectionMutation,
  disconnectConnectionMutation,
  getConnectionOptions,
  getNetWorthOptions,
  listAccountsOptions,
  listConnectionsOptions,
  listConnectorsOptions,
  listSyncRunsOptions,
  reconnectConnectionMutation,
  syncConnectionMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/** `GET /connectors` — the "add a connection" screen, as data (wp1.5-api.md §4). */
export function useConnectorsQuery() {
  return useQuery({ ...listConnectorsOptions(), staleTime: 5 * 60_000 });
}

/** `GET /connections` — every linked connection, no credential in the payload. */
export function useConnectionsQuery() {
  return useQuery({ ...listConnectionsOptions(), staleTime: 10_000 });
}

/** `GET /connections/{id}` — accounts + recent sync runs for the detail panel. */
export function useConnectionQuery(connectionId: string | null) {
  return useQuery({
    ...getConnectionOptions({ path: { connectionId: connectionId ?? '' } }),
    enabled: connectionId !== null,
  });
}

/** `GET /connections/{id}/sync-runs` — every attempt, including failures before page one. */
export function useSyncRunsQuery(connectionId: string | null, limit = 10) {
  return useQuery({
    ...listSyncRunsOptions({ path: { connectionId: connectionId ?? '' }, query: { limit } }),
    enabled: connectionId !== null,
  });
}

function useInvalidateConnections() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: listConnectionsOptions().queryKey });
    void queryClient.invalidateQueries({ queryKey: listAccountsOptions().queryKey });
    void queryClient.invalidateQueries({ queryKey: getNetWorthOptions().queryKey });
  };
}

/** `POST /connections` — step-up gated (wp1.5-api.md §1). Creates a connection outright for `manual_entry`/`credential_form` adapters, or the first half of a `provider_hosted` link. */
export function useCreateConnectionMutation() {
  const invalidate = useInvalidateConnections();
  return useMutation({ ...createConnectionMutation(), onSuccess: invalidate });
}

/** `POST /connections/{id}/reconnect` — step-up gated. Cursor and account identity survive (wp1.5-api.md §1). */
export function useReconnectConnectionMutation() {
  const invalidate = useInvalidateConnections();
  return useMutation({ ...reconnectConnectionMutation(), onSuccess: invalidate });
}

/** `POST /connections/{id}/sync` — session + CSRF only (not step-up: it moves no credential). 202 either way; `mode` says queued vs inline. */
export function useSyncConnectionMutation() {
  const invalidate = useInvalidateConnections();
  return useMutation({ ...syncConnectionMutation(), onSuccess: invalidate });
}

/** `DELETE /connections/{id}` — step-up gated. Keeps data; reports `providerSlotMayRemain`. */
export function useDisconnectConnectionMutation() {
  const invalidate = useInvalidateConnections();
  return useMutation({ ...disconnectConnectionMutation(), onSuccess: invalidate });
}
