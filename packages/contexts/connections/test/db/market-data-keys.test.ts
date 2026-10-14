// SPDX-License-Identifier: MIT
/**
 * A holder's market-data keys in `provider_credentials` (WP 10.4, migration
 * 0043): one value per provider, sealed exactly as Plaid's pair is, an env that
 * is NULL and must be, a four-character hint of a key that is at least sixteen
 * long, and the same scoping and event discipline as WP 10.1.
 *
 * The key canaries are synthetic and distinctive so an absence assertion
 * cannot pass by accident.
 */
import { SecretBox } from '@core/secretbox';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listMarketDataKeyStatuses,
  marketDataKeyHintOf,
  MARKET_DATA_KEY_SENTINEL,
  openMarketDataKeys,
  removeProviderCredentials,
  setMarketDataKey,
  credentialRef,
} from '../../src/provider-credentials.ts';
import {
  CORRELATION_ID,
  connectionsDatabase,
  NO_DATABASE,
  testClock,
  unlockedSecretBox,
  type TestDatabase,
} from '../harness.ts';

const TIINGO_KEY = 'canaryT11ng0key0000000000000000000009f2c'; // gitleaks:allow — synthetic canary, not a credential
const OPENFIGI_KEY = 'canary0pen-f1g1-0000-0000-00000000a1b2'; // gitleaks:allow — synthetic canary, not a credential
const REPLACEMENT = 'canaryT11ng0replacement00000000000000ffff'; // gitleaks:allow — synthetic canary, not a credential

const KDF = { memoryKiB: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

/** The constraint Postgres named when it refused a statement (Drizzle wraps the error). */
async function violatedConstraint(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
    return 'none';
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
}

describe.skipIf(NO_DATABASE)('market-data keys in provider_credentials (migration 0043)', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;

  beforeAll(async () => {
    database = await connectionsDatabase('mdkeys');
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
    provider: 'tiingo' | 'fred' | 'coingecko' | 'openfigi',
    key: string,
  ) {
    return database.db.transaction((tx) =>
      setMarketDataKey(tx, { provider, key, secretBox: box }, contextFor(userId)),
    );
  }

  it('a key is sealed, the hint is its last four characters, env is NULL, and the client-id column holds a sealed sentinel', async () => {
    const result = await store(database.userId, secretBox, 'tiingo', TIINGO_KEY);
    expect(result.rotated).toBe(false);
    expect(result.status.keyHint).toBe('9f2c');

    const raw = await database.db.execute<{
      client_id_sealed: Buffer;
      secret_sealed: Buffer;
      client_id_hint: string;
      env: string | null;
    }>(sql`
      SELECT client_id_sealed, secret_sealed, client_id_hint, env
        FROM provider_credentials
       WHERE user_id = ${database.userId}::uuid AND provider = 'tiingo'
    `);
    const row = raw.rows[0];
    expect(row?.env).toBeNull();
    expect(row?.client_id_hint).toBe('9f2c');
    for (const column of [row?.client_id_sealed, row?.secret_sealed]) {
      const bytes = Buffer.from(column ?? Buffer.alloc(0));
      expect(bytes[0], 'a SecretBox envelope, version 1').toBe(1);
      expect(bytes.includes(Buffer.from(TIINGO_KEY))).toBe(false);
      expect(bytes.includes(Buffer.from(MARKET_DATA_KEY_SENTINEL))).toBe(false);
    }
    // The sentinel really is what client_id_sealed holds, under its own AAD.
    const sentinel = await secretBox.openText(
      credentialRef(database.userId, 'tiingo', 'client_id'),
      new Uint8Array(row?.client_id_sealed ?? Buffer.alloc(0)),
    );
    expect(sentinel).toBe(MARKET_DATA_KEY_SENTINEL);

    const opened = await openMarketDataKeys(database.db, secretBox, database.userId);
    expect(opened.keys.get('tiingo')?.key()).toBe(TIINGO_KEY);
    expect(opened.unopenable).toEqual([]);
    // The opened object prints the provider and never the key.
    expect(JSON.stringify(opened.keys.get('tiingo'))).toBe('{"provider":"tiingo"}');
    expect(JSON.stringify([...opened.keys.values()])).not.toContain(TIINGO_KEY);
  });

  it('a short key has no hint: the store refuses it rather than show more than a quarter of it', () => {
    expect(() => marketDataKeyHintOf('short-key-12345')).toThrow(RangeError);
    expect(marketDataKeyHintOf('exactly-16-chars')).toBe('hars');
  });

  it('the event carries the provider and the change, env null, never the key; replacing rotates', async () => {
    await store(database.userId, secretBox, 'openfigi', OPENFIGI_KEY);
    const second = await store(database.userId, secretBox, 'openfigi', REPLACEMENT);
    expect(second.rotated).toBe(true);
    expect(second.status.rotatedAt).not.toBeNull();

    const events = await database.db.execute<{ payload: unknown }>(sql`
      SELECT payload FROM domain_events
       WHERE event_type = 'connections.ProviderCredentialsChanged'
       ORDER BY seq
    `);
    expect(events.rows.map((row) => row.payload)).toEqual([
      { provider: 'openfigi', change: 'set', env: null },
      { provider: 'openfigi', change: 'rotated', env: null },
    ]);
    const dump = JSON.stringify(events.rows);
    expect(dump).not.toContain(OPENFIGI_KEY);
    expect(dump).not.toContain(REPLACEMENT);
  });

  it("another holder's keys are never listed or opened, and the CHECKs tie env to the provider", async () => {
    const otherId = await database.createUser('Second Holder');
    const otherBox = new SecretBox({
      db: database.pool,
      userId: otherId,
      clock: testClock(),
      kdfParams: KDF,
      kdfFloor: KDF,
    });
    await otherBox.unlock('the second holder has a passphrase that exists only in this test');
    await store(otherId, otherBox, 'coingecko', TIINGO_KEY);

    expect([...(await listMarketDataKeyStatuses(database.db, database.userId)).keys()]).toEqual([]);
    expect([...(await listMarketDataKeyStatuses(database.db, otherId)).keys()]).toEqual([
      'coingecko',
    ]);
    const mine = await openMarketDataKeys(database.db, secretBox, database.userId);
    expect(mine.keys.size).toBe(0);

    // A row moved into the first holder's name does not authenticate for them.
    await database.db.execute(sql`
      UPDATE provider_credentials SET user_id = ${database.userId}::uuid WHERE user_id = ${otherId}::uuid
    `);
    const moved = await openMarketDataKeys(database.db, secretBox, database.userId);
    expect(moved.keys.size).toBe(0);
    expect(moved.unopenable).toEqual(['coingecko']);

    // 0043's CHECKs: a market-data row with an env, a provider outside the list.
    expect(
      await violatedConstraint(
        database.db.execute(sql`
          UPDATE provider_credentials SET env = 'sandbox' WHERE provider = 'coingecko'
        `),
      ),
    ).toBe('provider_credentials_env_by_provider');
    expect(
      await violatedConstraint(
        database.db.execute(sql`
          UPDATE provider_credentials SET provider = 'yfinance' WHERE provider = 'coingecko'
        `),
      ),
    ).toBe('provider_credentials_provider_check');
  });

  it('remove deletes the row and announces it; the status list is empty after', async () => {
    await store(database.userId, secretBox, 'fred', TIINGO_KEY);
    const removed = await database.db.transaction((tx) =>
      removeProviderCredentials(tx, { provider: 'fred' }, contextFor(database.userId)),
    );
    expect(removed).toBe(true);
    expect((await listMarketDataKeyStatuses(database.db, database.userId)).size).toBe(0);
  });
});
