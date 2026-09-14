// SPDX-License-Identifier: MIT
/**
 * Connection lifecycle against a real database.
 *
 * Every claim here is a claim about Postgres or about `SecretBox`: that the
 * credential column holds ciphertext and nothing else, that the natural key
 * makes a re-link an update rather than a second connection, that a disconnect
 * destroys the secret in the same transaction as the status change. A fake would
 * only assert that the fake works.
 */
import { ConnectorError } from '@connector/port';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnection,
  disconnectConnection,
  getConnection,
  listConnections,
  listSyncableConnections,
  openHandle,
  requireConnection,
  setConnectionStatus,
} from '../../src/connections.ts';
import { ConnectionsError } from '../../src/errors.ts';
import { getConnectionDetail, listConnectionSummaries } from '../../src/read.ts';
import {
  CORRELATION_ID,
  ManualConnector,
  ManualStore,
  NO_DATABASE,
  connectionsDatabase,
  recordingLedgerWriter,
  testClock,
  unlockedSecretBox,
  type TestDatabase,
} from '../harness.ts';

const ACCOUNTS = [
  { providerAccountId: 'acct-1', name: 'Everyday Checking', type: 'depository', currency: 'USD' },
  { providerAccountId: 'acct-2', name: 'Rainy Day', type: 'depository', currency: 'USD' },
];

/**
 * An adapter that reports a credential, so the sealing path is exercised.
 * `ManualConnector` deliberately has none, which is exactly why it cannot be
 * the subject of the "no plaintext in the column" test.
 */
class TokenConnector extends ManualConnector {
  override async connect(input: unknown): Promise<Awaited<ReturnType<ManualConnector['connect']>>> {
    const result = await super.connect(input);
    return { ...result, credentials: { access_token: ACCESS_TOKEN } };
  }
}

const ACCESS_TOKEN = 'access-sandbox-8d41f2b0-never-a-real-token';

describe.skipIf(NO_DATABASE)('connection lifecycle', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await connectionsDatabase('lifecycle');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    await database.truncate();
  });

  async function link(
    options: { connector?: ManualConnector; providerConnectionId?: string } = {},
  ): Promise<{ connectionId: string; accountIds: readonly string[] }> {
    const clock = testClock();
    const connector = options.connector ?? new TokenConnector({ store: new ManualStore() });
    const secretBox = await unlockedSecretBox(database);
    const ledgerWriter = recordingLedgerWriter();

    return database.db.transaction((tx) =>
      createConnection(
        tx,
        {
          connector,
          secretBox,
          ledgerWriter,
          input: {
            displayName: 'Big Bank',
            providerConnectionId: options.providerConnectionId ?? 'item-1',
            accounts: ACCOUNTS,
          },
        },
        { userId: database.userId, clock, correlationId: CORRELATION_ID },
      ),
    );
  }

  it('seals the credential and stores no plaintext in the column', async () => {
    const { connectionId } = await link();

    const raw = await database.db.execute<{ sealed: Buffer | null }>(
      sql`SELECT sealed_credentials AS sealed FROM connections WHERE id = ${connectionId}::uuid`,
    );
    const bytes = raw.rows[0]?.sealed;
    expect(bytes).not.toBeNull();
    // P0-1, asserted the only way it can be: read the raw column and look.
    const asText = Buffer.from(bytes ?? Buffer.alloc(0)).toString('utf8');
    expect(asText).not.toContain(ACCESS_TOKEN);
    expect(asText).not.toContain('access_token');
  });

  it('opens the credential back out, through a closure and not a field', async () => {
    const { connectionId } = await link();
    const secretBox = await unlockedSecretBox(database);
    const row = await requireConnection(database.db, database.userId, connectionId);
    const handle = await openHandle(row, secretBox, database.userId);

    expect(handle.secret('access_token')).toBe(ACCESS_TOKEN);
    expect(handle.secret('nothing_by_that_name')).toBeNull();
    // The whole reason `secret` is a function: this is what a log line sees.
    expect(JSON.stringify(handle)).not.toContain(ACCESS_TOKEN);
  });

  it('refuses a ciphertext moved from another row', async () => {
    const first = await link({ providerConnectionId: 'item-1' });
    const second = await link({ providerConnectionId: 'item-2' });

    // The AAD binds the envelope to (connections, sealed_credentials, id).
    await database.db.execute(sql`
      UPDATE connections SET sealed_credentials =
        (SELECT sealed_credentials FROM connections WHERE id = ${first.connectionId}::uuid)
      WHERE id = ${second.connectionId}::uuid
    `);

    const secretBox = await unlockedSecretBox(database);
    const row = await requireConnection(database.db, database.userId, second.connectionId);
    await expect(openHandle(row, secretBox, database.userId)).rejects.toMatchObject({
      code: 'decrypt_failed',
    });
  });

  it('maps every provider account to a ledger account exactly once', async () => {
    const { connectionId, accountIds } = await link();
    expect(accountIds).toHaveLength(2);

    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM connection_accounts WHERE connection_id = ${connectionId}::uuid`,
    );
    expect(Number(rows.rows[0]?.count)).toBe(2);
  });

  it('re-links in place, preserving the cursor and the account mapping', async () => {
    const first = await link();
    await database.db.execute(sql`
      UPDATE connections SET transactions_cursor = 'cursor-47', status = 'reauth_required'
      WHERE id = ${first.connectionId}::uuid
    `);

    const second = await link();

    // 08 §3.9: reconnect never deletes data, and never creates a duplicate
    // account. Losing either is how an app silently doubles a user's net worth.
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.relinked).toBe(true);
    expect(second.accountIds).toEqual(first.accountIds);

    const row = await requireConnection(database.db, database.userId, first.connectionId);
    expect(row.transactionsCursor).toBe('cursor-47');
    expect(row.status).toBe('active');

    const connections = await listConnections(database.db, database.userId);
    expect(connections).toHaveLength(1);
  });

  it('announces a link once, with the account count and whether it was a re-link', async () => {
    await link();
    await link();

    const events = await database.db.execute<{ payload: { relinked: boolean; accountCount: number } }>(
      sql`SELECT payload FROM domain_events WHERE event_type = 'connections.ConnectionCreated' ORDER BY seq`,
    );
    expect(events.rows.map((row) => row.payload.relinked)).toEqual([false, true]);
    expect(events.rows[0]?.payload.accountCount).toBe(2);
  });

  it('emits a status change once, not on every repeat of the same failure', async () => {
    const { connectionId } = await link();
    const context = { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID };
    const error = ConnectorError.fromCondition('PROVIDER_DOWN', '503 from the institution');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await database.db.transaction((tx) =>
        setConnectionStatus(
          tx,
          { connectionId, to: 'error', reason: error.kind, lastError: { kind: error.kind } },
          context,
        ),
      );
    }

    const events = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM domain_events WHERE event_type = 'connections.ConnectionStatusChanged'`,
    );
    // A nightly failure that keeps a connection in `error` must not notify the
    // user every night. The error detail is still refreshed.
    expect(Number(events.rows[0]?.count)).toBe(1);

    const row = await requireConnection(database.db, database.userId, connectionId);
    expect(row.lastError).toMatchObject({ kind: 'provider_unavailable' });
    expect(row.errorSince).not.toBeNull();
  });

  it('keeps error_since at when the trouble started, not when we last noticed', async () => {
    const { connectionId } = await link();
    const clock = testClock();
    const context = { userId: database.userId, clock, correlationId: CORRELATION_ID };

    await database.db.transaction((tx) =>
      setConnectionStatus(tx, { connectionId, to: 'error', reason: 'provider_unavailable' }, context),
    );
    const first = await requireConnection(database.db, database.userId, connectionId);

    clock.advance(6 * 60 * 60 * 1_000);
    await database.db.transaction((tx) =>
      setConnectionStatus(tx, { connectionId, to: 'error', reason: 'provider_unavailable' }, context),
    );
    const later = await requireConnection(database.db, database.userId, connectionId);

    expect(later.errorSince?.toISOString()).toBe(first.errorSince?.toISOString());
  });

  it('clears error_since when the connection recovers', async () => {
    const { connectionId } = await link();
    const context = { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID };

    await database.db.transaction((tx) =>
      setConnectionStatus(tx, { connectionId, to: 'error', reason: 'transient' }, context),
    );
    await database.db.transaction((tx) =>
      setConnectionStatus(tx, { connectionId, to: 'active' }, context),
    );

    const row = await requireConnection(database.db, database.userId, connectionId);
    expect(row.errorSince).toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('destroys the secret on disconnect and keeps the history', async () => {
    const store = new ManualStore();
    const connector = new TokenConnector({ store });
    const { connectionId } = await link({ connector });
    const secretBox = await unlockedSecretBox(database);

    const result = await disconnectConnection(
      database.db,
      { connectionId, connector, secretBox },
      { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID },
    );

    expect(result.revokedAtProvider).toBe(true);
    const row = await requireConnection(database.db, database.userId, connectionId);
    expect(row.status).toBe('disconnected');
    expect(row.sealedCredentials).toBeNull();

    // "Disconnect" and "delete my data" are different requests, and only one of
    // them is reversible. The account mapping survives.
    const mapped = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM connection_accounts WHERE connection_id = ${connectionId}::uuid`,
    );
    expect(Number(mapped.rows[0]?.count)).toBe(2);
  });

  it('disconnects locally even when the provider refuses', async () => {
    const store = new ManualStore();
    const connector = new TokenConnector({ store });
    const { connectionId } = await link({ connector });
    const secretBox = await unlockedSecretBox(database);

    // A provider that is down must not be able to stop a user disconnecting.
    const failing = Object.assign(Object.create(Object.getPrototypeOf(connector) as object), connector, {
      disconnect: () => Promise.reject(ConnectorError.fromCondition('PROVIDER_DOWN', '503')),
    }) as ManualConnector;

    const result = await disconnectConnection(
      database.db,
      { connectionId, connector: failing, secretBox },
      { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID },
    );

    expect(result.revokedAtProvider).toBe(false);
    const row = await requireConnection(database.db, database.userId, connectionId);
    expect(row.sealedCredentials).toBeNull();
  });

  it('refuses to disconnect twice', async () => {
    const store = new ManualStore();
    const connector = new TokenConnector({ store });
    const { connectionId } = await link({ connector });
    const secretBox = await unlockedSecretBox(database);
    const context = { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID };

    await disconnectConnection(database.db, { connectionId, connector, secretBox }, context);
    await expect(
      disconnectConnection(database.db, { connectionId, connector, secretBox }, context),
    ).rejects.toBeInstanceOf(ConnectionsError);
  });

  it('skips reauth_required connections when listing what to sync', async () => {
    const first = await link({ providerConnectionId: 'item-1' });
    const second = await link({ providerConnectionId: 'item-2' });
    const context = { userId: database.userId, clock: testClock(), correlationId: CORRELATION_ID };

    await database.db.transaction((tx) =>
      setConnectionStatus(
        tx,
        { connectionId: second.connectionId, to: 'reauth_required', reason: 'auth_required' },
        context,
      ),
    );

    // 04 §4.5: retrying is guaranteed to fail and burns the rate limit the
    // reconnect itself will need.
    const syncable = await listSyncableConnections(database.db, database.userId);
    expect(syncable.map((row) => row.id)).toEqual([first.connectionId]);
  });

  it('hides another user\'s connections', async () => {
    const { connectionId } = await link();
    const otherUser = await database.createUser('Someone else');

    expect(await getConnection(database.db, otherUser, connectionId)).toBeNull();
    expect(await listConnections(database.db, otherUser)).toHaveLength(0);
  });

  it('renders a summary and a detail view with no cursor and no credential in them', async () => {
    const { connectionId } = await link();

    const summaries = await listConnectionSummaries(database.db, database.userId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ provider: 'manual', status: 'active', accountCount: 2 });

    const detail = await getConnectionDetail(database.db, database.userId, connectionId);
    expect(detail.accounts).toHaveLength(2);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain(ACCESS_TOKEN);
    // The cursor is opaque to us and meaningless to a client; a value that
    // appears in a response is a value somebody will eventually parse.
    expect(serialised).not.toContain('transactionsCursor');
  });
});
