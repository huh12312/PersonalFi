// SPDX-License-Identifier: MIT
/**
 * A holder's provider API credentials against a real database (WP 10.1,
 * migration 0041).
 *
 * Every claim here is a claim about Postgres or about `SecretBox`: that the two
 * columns hold ciphertext and nothing else, that a ciphertext opens only for the
 * holder, the provider and the field it was sealed as, that a second holder's row
 * is unreachable by every scoping predicate alone and together, and that the
 * change and the event announcing it commit or roll back as one.
 *
 * The Plaid key canaries are synthetic and distinctive on purpose, so an absence
 * assertion cannot pass by accident.
 */
import { describeAad, SecretBox } from '@core/secretbox';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  credentialRef,
  eraseCredentialKey,
  getProviderCredentialStatus,
  openProviderCredentials,
  removeProviderCredentials,
  setProviderCredentials,
} from '../../src/provider-credentials.ts';
import {
  CORRELATION_ID,
  connectionsDatabase,
  NO_DATABASE,
  testClock,
  unlockedSecretBox,
  type TestDatabase,
} from '../harness.ts';

const CLIENT_ID = 'canary5c1ie47idA1b2c3d4e5f6a7b8'; // gitleaks:allow — synthetic canary for absence assertions, not a credential
const SECRET = 'canary53cr3tZq9f8e7d6c5b4a39281706'; // gitleaks:allow — synthetic canary for absence assertions, not a credential

const OTHER_CLIENT_ID = 'otherholderclientid0001'; // gitleaks:allow — synthetic canary, not a credential
const OTHER_SECRET = 'otherholdersecret000000000000002'; // gitleaks:allow — synthetic canary, not a credential
const REPLACEMENT_SECRET = 'canary53cr3tReplacement0000000000b'; // gitleaks:allow — synthetic canary, not a credential

const KDF = { memoryKiB: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

describe.skipIf(NO_DATABASE)('provider credentials (migration 0041)', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;

  beforeAll(async () => {
    database = await connectionsDatabase('provcred');
    secretBox = await unlockedSecretBox(database);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    await database.truncate(['provider_credentials', 'domain_events']);
  });

  function contextFor(userId: string) {
    return { userId, clock: testClock(), correlationId: CORRELATION_ID };
  }

  async function store(
    userId: string,
    box: SecretBox,
    values: { clientId?: string; secret?: string; env?: 'sandbox' | 'production' } = {},
  ) {
    return database.db.transaction((tx) =>
      setProviderCredentials(
        tx,
        {
          provider: 'plaid',
          clientId: values.clientId ?? CLIENT_ID,
          secret: values.secret ?? SECRET,
          env: values.env ?? 'sandbox',
          secretBox: box,
        },
        contextFor(userId),
      ),
    );
  }

  async function rawRow(userId: string) {
    const raw = await database.db.execute<{
      client_id_sealed: Buffer;
      secret_sealed: Buffer;
      client_id_hint: string;
    }>(
      sql`SELECT client_id_sealed, secret_sealed, client_id_hint FROM provider_credentials WHERE user_id = ${userId}::uuid`,
    );
    return raw.rows[0];
  }

  async function secondHolder(): Promise<{ userId: string; box: SecretBox }> {
    const userId = await database.createUser('Second Holder');
    const box = new SecretBox({
      db: database.pool,
      userId,
      clock: testClock(),
      kdfParams: KDF,
      kdfFloor: KDF,
    });
    await box.unlock('the second holder has a passphrase that exists only in this test');
    return { userId, box };
  }

  it('credentials are sealed under the KEK with an AAD bound to the holder and field, and open only for that holder', async () => {
    await store(database.userId, secretBox);

    // P0-1, asserted the only way it can be: read the raw columns as psql would.
    const row = await rawRow(database.userId);
    expect(row).toBeDefined();
    for (const column of [row?.client_id_sealed, row?.secret_sealed]) {
      const bytes = Buffer.from(column ?? Buffer.alloc(0));
      expect(bytes.length).toBeGreaterThan(41 + 16); // header + tag at least
      expect(bytes.includes(Buffer.from(SECRET))).toBe(false);
      expect(bytes.includes(Buffer.from(CLIENT_ID))).toBe(false);
      expect(bytes[0]).toBe(1); // envelope version
    }
    // The hint is the one plaintext derivative: four characters, display only.
    expect(row?.client_id_hint).toBe(CLIENT_ID.slice(-4));

    // The AAD names the table, the column and `<user>.<provider>`, per field.
    expect(describeAad(credentialRef(database.userId, 'plaid', 'secret'), 1)).toBe(
      `personalfi/v1|provider_credentials|secret_sealed|${database.userId}.plaid|1`,
    );
    expect(describeAad(credentialRef(database.userId, 'plaid', 'client_id'), 1)).toBe(
      `personalfi/v1|provider_credentials|client_id_sealed|${database.userId}.plaid|1`,
    );

    // The DEK is a per-record key under the KEK, scoped to this holder's row.
    const keys = await database.db.execute<{ scope: string; kind: string }>(
      sql`SELECT scope, kind FROM encryption_keys WHERE scope LIKE 'provider_credentials:%'`,
    );
    expect(keys.rows).toEqual([
      { scope: `provider_credentials:${database.userId}.plaid`, kind: 'dek' },
    ]);

    // Opens for the holder, to exactly what was sealed — behind closures, not fields.
    const opened = await openProviderCredentials(database.db, secretBox, database.userId, 'plaid');
    expect(opened?.clientId()).toBe(CLIENT_ID);
    expect(opened?.secret()).toBe(SECRET);
    expect(opened?.env).toBe('sandbox');
    expect(JSON.stringify(opened)).not.toContain(SECRET);
    expect(JSON.stringify(opened)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(opened)).toBe('{"provider":"plaid","env":"sandbox"}');

    // Bound to its field: the client id's bytes opened as the secret do not authenticate.
    await expect(
      secretBox.openText(
        credentialRef(database.userId, 'plaid', 'secret'),
        new Uint8Array(row?.client_id_sealed ?? []),
      ),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });

    // Bound to its holder: the same bytes under another holder's reference do not open.
    const other = await secondHolder();
    await expect(
      other.box.openText(
        credentialRef(other.userId, 'plaid', 'secret'),
        new Uint8Array(row?.secret_sealed ?? []),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/unknown_key|decrypt_failed/u) });

    // And bound to its table: lifted into connections.sealed_credentials's reference, no.
    await expect(
      secretBox.openText(
        { table: 'connections', column: 'sealed_credentials', rowId: `${database.userId}.plaid` },
        new Uint8Array(row?.secret_sealed ?? []),
      ),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it("another holder's credentials are never readable or writable", async () => {
    const other = await secondHolder();
    await store(database.userId, secretBox);

    // Every scoping predicate alone and together, for every reader. The table's
    // CHECK admits only 'plaid', so a wrong provider is probed by the readers,
    // which take the provider as an argument.
    const wrongProvider = 'coinbase' as unknown as 'plaid';
    const probes = [
      {
        name: 'right holder, right provider',
        userId: database.userId,
        provider: 'plaid' as const,
        visible: true,
      },
      {
        name: 'wrong holder alone',
        userId: other.userId,
        provider: 'plaid' as const,
        visible: false,
      },
      {
        name: 'wrong provider alone',
        userId: database.userId,
        provider: wrongProvider,
        visible: false,
      },
      {
        name: 'wrong holder and wrong provider',
        userId: other.userId,
        provider: wrongProvider,
        visible: false,
      },
    ];
    for (const probe of probes) {
      const status = await getProviderCredentialStatus(database.db, probe.userId, probe.provider);
      expect(status !== null, `status: ${probe.name}`).toBe(probe.visible);
      const box = probe.userId === database.userId ? secretBox : other.box;
      const opened = await openProviderCredentials(database.db, box, probe.userId, probe.provider);
      expect(opened !== null, `open: ${probe.name}`).toBe(probe.visible);
    }

    // A foreign remove removes nothing, and says so.
    for (const probe of probes.filter((p) => !p.visible)) {
      const removed = await database.db.transaction((tx) =>
        removeProviderCredentials(tx, { provider: probe.provider }, contextFor(probe.userId)),
      );
      expect(removed, `remove: ${probe.name}`).toBe(false);
    }
    const stillThere = await openProviderCredentials(
      database.db,
      secretBox,
      database.userId,
      'plaid',
    );
    expect(stillThere?.secret()).toBe(SECRET);

    // A foreign write is the foreign holder's own row; it never touches the first.
    await store(other.userId, other.box, {
      clientId: OTHER_CLIENT_ID,
      secret: OTHER_SECRET,
    });
    const theirs = await openProviderCredentials(database.db, other.box, other.userId, 'plaid');
    expect(theirs?.clientId()).toBe(OTHER_CLIENT_ID);
    const mine = await openProviderCredentials(database.db, secretBox, database.userId, 'plaid');
    expect(mine?.clientId()).toBe(CLIENT_ID);
    const count = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provider_credentials`,
    );
    expect(count.rows[0]?.n).toBe(2);

    // Neither holder's box can open the other's row, even handed the bytes.
    const rows = await database.db.execute<{ user_id: string; secret_sealed: Buffer }>(
      sql`SELECT user_id, secret_sealed FROM provider_credentials`,
    );
    const mineBytes = rows.rows.find((r) => r.user_id === database.userId)?.secret_sealed;
    await expect(
      other.box.openText(
        credentialRef(other.userId, 'plaid', 'secret'),
        new Uint8Array(mineBytes ?? []),
      ),
    ).rejects.toBeDefined();

    // The database refuses a second row for one holder and provider (the natural key).
    await expect(
      database.db.execute(sql`
        INSERT INTO provider_credentials (id, user_id, provider, client_id_sealed, secret_sealed, env, client_id_hint)
        VALUES (gen_random_uuid(), ${database.userId}::uuid, 'plaid', '\\x01'::bytea, '\\x01'::bytea, 'sandbox', 'abcd')
      `),
    ).rejects.toThrow();
  });

  it('replaces in place, marks the rotation, and announces each change without a secret in the event', async () => {
    const first = await store(database.userId, secretBox);
    expect(first.rotated).toBe(false);
    expect(first.status.rotatedAt).toBeNull();

    const second = await store(database.userId, secretBox, {
      secret: REPLACEMENT_SECRET,
    });
    expect(second.rotated).toBe(true);
    expect(second.status.rotatedAt).not.toBeNull();
    const opened = await openProviderCredentials(database.db, secretBox, database.userId, 'plaid');
    expect(opened?.secret()).toBe(REPLACEMENT_SECRET);

    const removed = await database.db.transaction((tx) =>
      removeProviderCredentials(tx, { provider: 'plaid' }, contextFor(database.userId)),
    );
    expect(removed).toBe(true);

    const events = await database.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM domain_events WHERE event_type = 'connections.ProviderCredentialsChanged' ORDER BY seq`,
    );
    expect(events.rows.map((e) => e.payload)).toEqual([
      { provider: 'plaid', change: 'set', env: 'sandbox' },
      { provider: 'plaid', change: 'rotated', env: 'sandbox' },
      { provider: 'plaid', change: 'removed', env: null },
    ]);
    const serialised = JSON.stringify(events.rows);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(CLIENT_ID);
  });

  it('commits the credential and its event together, or neither', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await setProviderCredentials(
          tx,
          { provider: 'plaid', clientId: CLIENT_ID, secret: SECRET, env: 'sandbox', secretBox },
          contextFor(database.userId),
        );
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');
    expect(await getProviderCredentialStatus(database.db, database.userId, 'plaid')).toBeNull();
    const events = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'connections.ProviderCredentialsChanged'`,
    );
    expect(events.rows[0]?.n).toBe(0);
  });

  it('erasing the key makes the removed ciphertext permanently unreadable, and a later set starts a new key', async () => {
    await store(database.userId, secretBox);
    const before = await rawRow(database.userId);
    await database.db.transaction((tx) =>
      removeProviderCredentials(tx, { provider: 'plaid' }, contextFor(database.userId)),
    );
    expect(await eraseCredentialKey(secretBox, database.userId, 'plaid')).toBe(true);

    // The row is gone, and the old bytes (from a backup, say) no longer open anywhere.
    await expect(
      secretBox.openText(
        credentialRef(database.userId, 'plaid', 'secret'),
        new Uint8Array(before?.secret_sealed ?? []),
      ),
    ).rejects.toMatchObject({ code: 'key_retired' });

    // Setting again works: the retired scope gets a fresh key version.
    await store(database.userId, secretBox);
    const opened = await openProviderCredentials(database.db, secretBox, database.userId, 'plaid');
    expect(opened?.secret()).toBe(SECRET);
  });
});
