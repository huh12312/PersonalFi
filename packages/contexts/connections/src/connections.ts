// SPDX-License-Identifier: MIT
/**
 * Connection lifecycle: link, re-link, map accounts, change status, disconnect.
 *
 * Two invariants run through this file, and both are the kind that cost real
 * user data the first time they are missing.
 *
 * **Re-linking never creates a second connection, and never a second account.**
 * The natural key is `(user_id, provider, provider_connection_id)`. A re-link
 * updates that row — new credential, status back to `active`, **cursor and
 * `connection_accounts` untouched**. 08 §3.9: "reconnect never deletes data, and
 * reconnect never creates duplicate accounts. Losing account identity on
 * reconnect is the classic way a personal finance app silently doubles a user's
 * net worth."
 *
 * **A credential exists in exactly one form: sealed.** It arrives from
 * `connector.connect`, goes straight into `SecretBox.sealText` with an AAD bound
 * to this row, and is never held anywhere else. Opening it produces a closure,
 * not a field (see `ConnectionHandle.secret`), so the value cannot reach a log
 * line by being part of an object somebody serialised.
 */
import { newId } from '@core/kernel';
import { appendEvent } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import { and, desc, eq } from 'drizzle-orm';
import {
  connectionAccounts,
  connections,
  type ConnectionRow,
  type ConnectionStatus,
} from '../schema/index.ts';
import { platformOf, type ConnectionsContext, type ConnectionsExecutor } from './db.ts';
import { ConnectionsError } from './errors.ts';
import { ConnectionCreated, ConnectionStatusChanged } from './events.ts';
import type { LedgerWriter } from './ledger-writer.ts';
import type {
  ConnectionHandle,
  Connector,
  ConnectorErrorKind,
  ProviderAccountFact,
} from './port.ts';

const TABLE = 'connections';
const CREDENTIALS_COLUMN = 'sealed_credentials';

export interface CreateConnectionInput {
  /** Whatever the adapter's link flow produced. Opaque to this context. */
  readonly input: unknown;
  readonly connector: Connector;
  readonly secretBox: SecretBox;
  readonly ledgerWriter: LedgerWriter;
  /** Non-secret per-connection settings: a CSV mapping profile, say. */
  readonly config?: Record<string, unknown>;
}

export interface CreateConnectionResult {
  readonly connectionId: string;
  readonly relinked: boolean;
  readonly accountIds: readonly string[];
}

/**
 * Link a provider, map its accounts into the ledger, and announce it.
 *
 * Call inside a transaction. Everything here — the connection row, the ledger's
 * accounts, the mapping rows, the event — commits together or not at all, so a
 * crash cannot leave a connection whose accounts do not exist or accounts no
 * connection owns.
 */
export async function createConnection(
  executor: ConnectionsExecutor,
  input: CreateConnectionInput,
  context: ConnectionsContext,
): Promise<CreateConnectionResult> {
  const now = context.clock.now();
  const result = await input.connector.connect(input.input);

  const existing = await findByProviderKey(
    executor,
    context.userId,
    input.connector.provider,
    result.providerConnectionId,
  );
  const connectionId = existing?.id ?? newId();
  const relinked = existing !== null;

  const sealed =
    Object.keys(result.credentials).length === 0
      ? null
      : await input.secretBox.sealText(
          { table: TABLE, column: CREDENTIALS_COLUMN, rowId: connectionId },
          JSON.stringify(result.credentials),
        );

  const columns = {
    displayName: result.displayName,
    // A re-link with no credential must not silently wipe the one we hold: an
    // adapter that returns `{}` is saying "nothing changed", not "revoke it".
    ...(sealed === null && relinked ? {} : { sealedCredentials: sealed }),
    status: 'active' as const,
    capabilities: capabilitiesJson(input.connector, result.observedCapabilities),
    config: input.config ?? {},
    lastError: null,
    errorSince: null,
    consentExpiresAt: result.consentExpiresAt,
    updatedAt: now,
  };

  if (relinked) {
    // Note what is absent: `transactionsCursor`. Preserving it is the whole
    // point of a re-link — the sync after a reconnect resumes rather than
    // re-pulling 24 months (08 §3.9).
    await executor.update(connections).set(columns).where(eq(connections.id, connectionId));
  } else {
    await executor.insert(connections).values({
      id: connectionId,
      userId: context.userId,
      provider: input.connector.provider,
      providerConnectionId: result.providerConnectionId,
      transactionsCursor: null,
      lastSyncedAt: null,
      createdAt: now,
      ...columns,
    });
  }

  const accountIds = await linkAccounts(executor, {
    connectionId,
    provider: input.connector.provider,
    accounts: result.accounts,
    ledgerWriter: input.ledgerWriter,
    context,
  });

  await appendEvent(
    platformOf(executor),
    ConnectionCreated.create(
      {
        connectionId,
        provider: input.connector.provider,
        accountCount: accountIds.length,
        relinked,
      },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: connectionId },
      context.clock,
    ),
  );

  return { connectionId, relinked, accountIds };
}

export interface LinkAccountsInput {
  readonly connectionId: string;
  readonly provider: string;
  readonly accounts: readonly ProviderAccountFact[];
  readonly ledgerWriter: LedgerWriter;
  readonly context: ConnectionsContext;
}

/**
 * Upsert each provider account into the ledger and record the mapping.
 *
 * Idempotent on both halves: the ledger's own natural key
 * `(user_id, provider, provider_account_id)` decides whether an account is new,
 * and `connection_accounts`'s unique index decides whether the mapping is. So
 * running this on every sync — which 08 §2.3 says to do, because an institution
 * can add an account at any time — costs two upserts and changes nothing.
 */
export async function linkAccounts(
  executor: ConnectionsExecutor,
  input: LinkAccountsInput,
): Promise<string[]> {
  const { context } = input;
  const now = context.clock.now();
  const writeContext = {
    clock: context.clock,
    correlationId: context.correlationId,
    causationId: context.causationId ?? null,
  };

  const accountIds: string[] = [];
  for (const account of input.accounts) {
    const upserted = await input.ledgerWriter.upsertAccount(
      executor,
      {
        userId: context.userId,
        provider: input.provider,
        providerAccountId: account.providerAccountId,
        connectionId: input.connectionId,
        name: account.name,
        officialName: account.officialName,
        type: account.type,
        subtype: account.subtype,
        currency: account.currency,
        mask: account.mask,
      },
      writeContext,
    );
    accountIds.push(upserted.accountId);

    await executor
      .insert(connectionAccounts)
      .values({
        id: newId(),
        userId: context.userId,
        connectionId: input.connectionId,
        providerAccountId: account.providerAccountId,
        accountId: upserted.accountId,
        providerName: account.name,
        currency: account.currency,
        capabilities: [...account.capabilities],
        enabled: true,
        linkedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectionAccounts.connectionId, connectionAccounts.providerAccountId],
        set: {
          providerName: account.name,
          currency: account.currency,
          capabilities: [...account.capabilities],
          updatedAt: now,
        },
      });
  }
  return accountIds;
}

/** `providerAccountId` → ledger `accountId`, for the accounts still enabled. */
export async function accountMap(
  executor: ConnectionsExecutor,
  connectionId: string,
): Promise<Map<string, string>> {
  const rows = await executor
    .select({
      providerAccountId: connectionAccounts.providerAccountId,
      accountId: connectionAccounts.accountId,
      enabled: connectionAccounts.enabled,
    })
    .from(connectionAccounts)
    .where(eq(connectionAccounts.connectionId, connectionId));
  return new Map(
    rows.filter((row) => row.enabled).map((row) => [row.providerAccountId, row.accountId]),
  );
}

export interface SetStatusInput {
  readonly connectionId: string;
  readonly to: ConnectionStatus;
  /** The `ConnectorError` kind that caused it, when a failure did. */
  readonly reason?: ConnectorErrorKind | null;
  readonly providerCode?: string | null;
  readonly lastError?: Record<string, unknown> | null;
}

/**
 * Move a connection between states, and say so.
 *
 * A no-op when the status is already what it would become: an event is a *fact
 * that happened*, and a nightly failure that keeps a connection in `error`
 * should not produce a notification every night. The error detail is still
 * refreshed, so the history stays current without the noise.
 */
export async function setConnectionStatus(
  executor: ConnectionsExecutor,
  input: SetStatusInput,
  context: ConnectionsContext,
): Promise<{ changed: boolean }> {
  const now = context.clock.now();
  const row = await requireConnection(executor, context.userId, input.connectionId);
  const changed = row.status !== input.to;

  await executor
    .update(connections)
    .set({
      status: input.to,
      lastError: input.lastError ?? null,
      // `error_since` starts when the trouble started, not when we last noticed:
      // "degraded for 26 hours" is the figure 08 §2.4's escalation thresholds are
      // measured against.
      errorSince: input.to === 'active' ? null : (row.errorSince ?? now),
      ...(input.to === 'disconnected' ? { sealedCredentials: null } : {}),
      updatedAt: now,
    })
    .where(eq(connections.id, input.connectionId));

  if (!changed) return { changed: false };

  await appendEvent(
    platformOf(executor),
    ConnectionStatusChanged.create(
      {
        connectionId: input.connectionId,
        provider: row.provider,
        from: row.status,
        to: input.to,
        reason: input.reason ?? null,
        providerCode: input.providerCode ?? null,
      },
      {
        userId: context.userId,
        correlationId: context.correlationId,
        aggregateId: input.connectionId,
      },
      context.clock,
    ),
  );
  return { changed: true };
}

export interface DisconnectInput {
  readonly connectionId: string;
  readonly connector: Connector;
  readonly secretBox: SecretBox;
}

/**
 * Revoke at the provider, then destroy the local secret.
 *
 * The remote call is **best effort and deliberately outside the transaction**:
 * a provider that is down must not be able to stop a user from disconnecting.
 * The local half always happens. `accounts`, `transactions` and the sync history
 * are all kept — "disconnect" and "delete my data" are different requests, and
 * only one of them is reversible.
 */
export async function disconnectConnection(
  database: { transaction<T>(fn: (tx: ConnectionsExecutor) => Promise<T>): Promise<T> },
  input: DisconnectInput,
  context: ConnectionsContext,
): Promise<{ revokedAtProvider: boolean }> {
  const row = await database.transaction((tx) =>
    requireConnection(tx, context.userId, input.connectionId),
  );
  if (row.status === 'disconnected') {
    throw new ConnectionsError(
      'connections.already_disconnected',
      `connection ${input.connectionId} is already disconnected`,
    );
  }

  let revokedAtProvider = false;
  try {
    await input.connector.disconnect(await openHandle(row, input.secretBox, context.userId));
    revokedAtProvider = true;
  } catch {
    // Swallowed on purpose, and recorded as `revokedAtProvider: false` so the UI
    // can say "we could not tell Plaid; revoke it there too if you want to be
    // sure". Rethrowing would leave a live token on this machine because a
    // remote was unreachable.
  }

  await database.transaction(async (tx) => {
    await setConnectionStatus(tx, { connectionId: input.connectionId, to: 'disconnected' }, context);
  });
  return { revokedAtProvider };
}

/**
 * Open the sealed credential and build the handle an adapter is called with.
 *
 * The plaintext exists only inside the closure this returns. It is not a field
 * on the handle, not a property of any object the orchestrator holds, and not
 * reachable from `JSON.stringify(handle)` — which is asserted by the conformance
 * suite, because P0-1 ("no token in logs") is worth a test and not just a habit.
 */
export async function openHandle(
  row: ConnectionRow,
  secretBox: SecretBox,
  userId: string,
): Promise<ConnectionHandle> {
  const credentials =
    row.sealedCredentials === null
      ? {}
      : (JSON.parse(
          await secretBox.openText(
            { table: TABLE, column: CREDENTIALS_COLUMN, rowId: row.id },
            row.sealedCredentials,
          ),
        ) as Record<string, string>);

  return {
    connectionId: row.id,
    userId,
    provider: row.provider,
    providerConnectionId: row.providerConnectionId,
    secret: (name) => credentials[name] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getConnection(
  executor: ConnectionsExecutor,
  userId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const rows = await executor
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)));
  return rows[0] ?? null;
}

export async function requireConnection(
  executor: ConnectionsExecutor,
  userId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const row = await getConnection(executor, userId, connectionId);
  if (row === null) {
    throw new ConnectionsError('connections.not_found', `no connection ${connectionId}`);
  }
  return row;
}

export async function listConnections(
  executor: ConnectionsExecutor,
  userId: string,
  options: { readonly includeDisconnected?: boolean } = {},
): Promise<readonly ConnectionRow[]> {
  const rows = await executor
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .orderBy(desc(connections.createdAt));
  return options.includeDisconnected === true
    ? rows
    : rows.filter((row) => row.status !== 'disconnected');
}

/** Connections the nightly schedule should touch. `reauth_required` is skipped. */
export async function listSyncableConnections(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<readonly ConnectionRow[]> {
  const rows = await listConnections(executor, userId, { includeDisconnected: false });
  // 04 §4.5: reauth_required "stops scheduled syncs for that item (retrying is
  // guaranteed to fail and burns rate limit)". `error` is still tried: it is a
  // transient condition the job queue is already backing off from.
  return rows.filter((row) => row.status !== 'reauth_required');
}

async function findByProviderKey(
  executor: ConnectionsExecutor,
  userId: string,
  provider: string,
  providerConnectionId: string,
): Promise<ConnectionRow | null> {
  const rows = await executor
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.provider, provider),
        eq(connections.providerConnectionId, providerConnectionId),
      ),
    );
  return rows[0] ?? null;
}

/**
 * What the UI renders the connection from, stored so it need not instantiate an
 * adapter. Narrowed by what the provider actually granted, never widened.
 */
function capabilitiesJson(
  connector: Connector,
  observed: readonly string[] | null,
): Record<string, unknown> {
  const declared = connector.capabilities();
  const supports =
    observed === null
      ? declared.supports
      : declared.supports.filter((capability) => observed.includes(capability));
  return { ...declared, supports };
}
