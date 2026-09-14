// SPDX-License-Identifier: MIT
/**
 * This context's own errors, which are the ones that are *not* a `ConnectorError`.
 *
 * 08 §6.4: three taxonomies exist system-wide and must not blur —
 * `ConnectorError` (something outside our boundary failed), `DomainError` (an
 * invariant we refuse to violate), `UserError` (the request was wrong). Only
 * `ConnectorError` gets retries.
 *
 * So a provider being down is a `ConnectorError` and lives in `@connector/port`;
 * "there is no connection with that id" and "this connection is already
 * disconnected" are domain facts and live here. Keeping them apart is what stops
 * the orchestrator from backing off and retrying for six hours because a row was
 * missing.
 */
export const CONNECTIONS_ERROR_CODES = [
  'connections.not_found',
  'connections.account_not_linked',
  'connections.already_disconnected',
  'connections.locked',
  'connections.unknown_provider',
  'connections.sync_exhausted',
] as const;

export type ConnectionsErrorCode = (typeof CONNECTIONS_ERROR_CODES)[number];

export class ConnectionsError extends Error {
  override readonly name = 'ConnectionsError';
  readonly code: ConnectionsErrorCode;

  constructor(code: ConnectionsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export function isConnectionsError(value: unknown): value is ConnectionsError {
  return value instanceof ConnectionsError;
}
