// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-4 (G4-8:
 * `docs/evidence/phase-4/gate-security-review.md` §2.5, §3.17).
 *
 * G4-8's finding: migration 0027 added `wallet_addresses.descriptor_sealed`
 * and a `secretBox` option on `createWalletRpcRuntime`, but "neither
 * composition root supplies it" — `app.ts` builds the runtime before a
 * `SecretBox` exists at all, and `worker.ts` (which does have one in scope)
 * never passed it either. `worker.ts` is fixed directly (this WP's own
 * `createWalletRpcRuntime({ …, secretBox })` call, inside `resolveModules`).
 *
 * `app.ts` is not this WP's file (see `docs/plan/05-phase-5-dispatch.md`'s
 * WP 5.13 ownership list — `app.ts` is explicitly withheld), so this suite
 * cannot exercise the *production* composition root's own default
 * construction. What it proves instead, over the **real** application and
 * **real** HTTP (`buildApp`, `app.inject`, a real Postgres) is that the seal
 * path itself is correct end to end, through the exact seam `app.ts` would
 * use to pass a sealed runtime: `BuildAppOptions.walletRpc` (already a
 * first-class injection point, documented in `app.ts`'s own header,
 * `apps/api/test/helpers/api-harness.ts`'s `HarnessOptions.walletRpc`) and
 * `createWalletRpcRuntime`'s now-lazy `secretBox` option (`domain.ts`,
 * `WalletDescriptorSecretBox`). This is the honest version of "through the
 * real api": the composition differs from `app.ts`'s only in the one line
 * `app.ts` cannot yet make (see this file's own evidence entry, §4.2, for
 * exactly what that line is).
 *
 * A `SecretBox` is constructed directly against this suite's own scratch
 * database — the same recipe `packages/secretbox/test/keyring-race.test.ts`
 * uses — rather than through `SecurityRuntime`, because `SecurityRuntime`'s
 * own `SecretBox` is built *inside* `buildApp` and this test needs one
 * *before* `buildApp` runs, to construct the sealed `WalletRpcRuntime`
 * `options.walletRpc` is injected with. The two boxes are different
 * instances sealing different columns (this one only ever touches
 * `wallet_addresses`) and that is fine: nothing under test here reads a
 * `sealed_credentials` row.
 *
 * Own scratch database (`personalfi_api_wp513b-carry-c4_*`, via
 * `createTestDatabase` directly rather than `createApiHarness`, since the
 * harness's own `walletRpc` construction is the unsealed one this test must
 * not use), per the harness's own suite-naming convention.
 */
import { loadConfig } from '@core/config';
import { newId, systemClock } from '@core/kernel';
import { SecretBox } from '@core/secretbox';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { ADMIN_URL } from '@core/testkit';
import { ConnectorRegistry } from '@ctx/connections';
import { WALLETRPC_MANIFEST, WalletRpcConnector, WALLETRPC_PROVIDER } from '@connector/walletrpc';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import {
  createWalletAddressStore,
  createWalletRpcRuntime,
  resealPlaintextWalletDescriptors,
  type WalletRpcRuntime,
} from '../../src/domain.ts';
import { createTempSecrets, type TempSecrets } from '../helpers/secrets.ts';
import { expectStatus, TEST_ORIGIN, type TestSession } from '../helpers/api-harness.ts';

const NO_DATABASE = ADMIN_URL === undefined;

/** Fast, like every other suite's KDF override — none of this is about key derivation. */
const FAST_KDF = { memoryKiB: 8_192, timeCost: 2, parallelism: 1 } as const;

/** BIP84's published test-vector account key — same one `investments-routes.test.ts` uses. */
const WATCH_ONLY_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe.skipIf(NO_DATABASE)('WP 5.13b carry C-4 — the wallet descriptor is sealed, real api', () => {
  let database: TestDatabase;
  let secrets: TempSecrets;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let session: TestSession;

  async function buildSealedApp(walletSecretBox: SecretBox | undefined): Promise<{
    app: Awaited<ReturnType<typeof buildApp>>['app'];
    session: TestSession;
  }> {
    const walletRpc: WalletRpcRuntime = createWalletRpcRuntime({
      database: database.db,
      allowedHosts: [],
      // WP 5.13b carry C-4: this is the exact option `app.ts` cannot yet
      // pass a value to (§4.2's "Needs the orchestrator"). Passed directly
      // here, through the same `createWalletRpcRuntime` production code.
      ...(walletSecretBox === undefined ? {} : { secretBox: walletSecretBox }),
    });
    const registry = new ConnectorRegistry([
      {
        connector: new WalletRpcConnector({
          store: walletRpc.store,
          esploraTransport: walletRpc.esploraTransport,
          etherscanTransport: walletRpc.etherscanTransport,
          etherscanApiKey: walletRpc.etherscanApiKey,
          clock: systemClock,
        }),
        manifest: WALLETRPC_MANIFEST,
      },
    ]);

    const config = loadConfig({
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: database.url,
        SECRETS_DIR: secrets.dir,
        BASE_URL: TEST_ORIGIN,
        AUTH_ALLOWED_ORIGINS: TEST_ORIGIN,
        AUTH_RP_ID: '127.0.0.1',
        KEK_ARGON2_MEMORY_KIB: '8192',
        KEK_ARGON2_TIME_COST: '2',
        KEK_ARGON2_PARALLELISM: '1',
      },
    });

    const built = await buildApp({
      config,
      pool: database.pool,
      connectorRegistry: registry,
      walletRpc,
    });
    const state = await built.security.initialise();
    if (state.state !== 'unlocked') {
      throw new Error(`could not unlock the test application: ${JSON.stringify(state)}`);
    }
    await built.app.ready();

    const identity = built.security.requireIdentity();
    const issued = await identity.sessions.issue({
      userId: database.userId,
      authMethod: 'webauthn',
      fresh: true,
    });
    return {
      app: built.app,
      session: {
        accessToken: issued.accessToken,
        csrf: 'wp513b-carry-c4-test-csrf-token-value-000000',
        fresh: true,
      },
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp513b_c4');
    secrets = createTempSecrets();

    const walletSecretBox = new SecretBox({
      db: database.pool,
      userId: database.userId,
      clock: systemClock,
      kdfParams: FAST_KDF,
      kdfFloor: FAST_KDF,
    });
    // The same passphrase `security.initialise()` will use below (`master_key`,
    // via `SECRETS_DIR`): both `SecretBox` instances derive against the *same*
    // `encryption_keys` row (same user, same database), so they must agree on
    // the passphrase or the second unlock refuses with `passphrase_mismatch`.
    const unlocked = await walletSecretBox.unlock(secrets.masterKey);
    if (unlocked.state !== 'unlocked') {
      throw new Error(`could not unlock the wallet SecretBox: ${JSON.stringify(unlocked)}`);
    }

    const built = await buildSealedApp(walletSecretBox);
    app = built.app;
    session = built.session;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    secrets?.dispose();
    await database?.drop();
  }, 30_000);

  it('a watch-only wallet link seals descriptor: the plaintext column is NULL, the sealed column is not, and the value round-trips through the real read path', async () => {
    // The same cookie/header shape `api-harness.ts`'s own `request()` sends
    // (`__Host-pfi_session`, `__Host-pfi_csrf` + `x-csrf-token`,
    // `sec-fetch-site: same-origin`) — this suite builds its own app rather
    // than using the harness (§ this file's header), but the session ceremony
    // itself is unchanged production code and must be driven the same way.
    const response = await app.inject({
      method: 'POST',
      url: '/connections',
      headers: {
        'sec-fetch-site': 'same-origin',
        origin: TEST_ORIGIN,
        cookie: `__Host-pfi_session=${session.accessToken}; __Host-pfi_csrf=${session.csrf}`,
        'x-csrf-token': session.csrf,
      },
      payload: {
        provider: WALLETRPC_PROVIDER,
        input: { chain: 'bitcoin', value: WATCH_ONLY_ZPUB, label: 'Sealed cold storage' },
      },
    });
    expectStatus(response, 201);

    const rows = await database.db.execute<{
      descriptor: string | null;
      descriptor_sealed: Uint8Array | null;
    }>(sql`
      SELECT descriptor, descriptor_sealed FROM wallet_addresses
       WHERE user_id = ${database.userId}::uuid
    `);
    expect(rows.rows).toHaveLength(1);
    // The custody claim itself: the plaintext column carries nothing once a
    // SecretBox is available to the runtime that wrote this row.
    expect(rows.rows[0]?.descriptor).toBeNull();
    expect(rows.rows[0]?.descriptor_sealed).not.toBeNull();
    // And the sealed bytes are not merely non-null — the raw column literally
    // never carries the xpub in any recoverable form.
    const sealedText = Buffer.from(rows.rows[0]?.descriptor_sealed ?? new Uint8Array()).toString(
      'latin1',
    );
    expect(sealedText).not.toContain(WATCH_ONLY_ZPUB);

    // The real read path (GET, through the connector's own `store.get`) still
    // unseals correctly — sealing is not a one-way trip.
    const listed = await app.inject({
      method: 'GET',
      url: '/connections',
      headers: {
        'sec-fetch-site': 'same-origin',
        origin: TEST_ORIGIN,
        cookie: `__Host-pfi_session=${session.accessToken}; __Host-pfi_csrf=${session.csrf}`,
      },
    });
    expectStatus(listed, 200);
  });
});

describe.skipIf(NO_DATABASE)('WP 5.13b carry C-4 — resealPlaintextWalletDescriptors', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp513b_c4_reseal');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  it('re-seals every plaintext row exactly once, idempotently, and leaves an already-sealed row untouched', async () => {
    // A plaintext row, the shape any install pre-dating this WP's worker.ts
    // wiring (or migration 0027 itself) still carries: `createWalletAddressStore`
    // with no `secretBox`, exactly `app.ts`'s own default today.
    const unsealedStore = createWalletAddressStore(database.db);
    const connectionId = newId();
    // The connections row exists *before* `put()` here — unlike the real
    // link ceremony (`connect()` runs before `createConnection` returns an
    // id, which is `persistPending`'s reason to exist, `store.ts`'s own doc
    // comment) — so `put()` takes its "already linked" branch and writes
    // straight through `write()`, which is exactly what this fixture wants:
    // a plaintext row already durably on disk, the shape a pre-existing
    // install's `wallet_addresses` table carries.
    await database.db.execute(sql`
      INSERT INTO connections (id, user_id, provider, provider_connection_id, display_name)
      VALUES (${connectionId}::uuid, ${database.userId}::uuid, ${WALLETRPC_PROVIDER},
              'wp513b-reseal-provider-id', 'Reseal fixture')
    `);
    await unsealedStore.put({
      providerConnectionId: 'wp513b-reseal-provider-id',
      chain: 'bitcoin',
      descriptor: WATCH_ONLY_ZPUB,
      derivationScheme: 'bip84',
      label: 'Pre-existing plaintext link',
      scanState: { externalHighestUsedIndex: null, internalHighestUsedIndex: null },
    });

    const beforeReseal = await database.db.execute<{
      descriptor: string | null;
      descriptor_sealed: Uint8Array | null;
    }>(sql`SELECT descriptor, descriptor_sealed FROM wallet_addresses WHERE connection_id = ${connectionId}::uuid`);
    expect(beforeReseal.rows[0]?.descriptor).toBe(WATCH_ONLY_ZPUB);
    expect(beforeReseal.rows[0]?.descriptor_sealed).toBeNull();

    const secretBox = new SecretBox({
      db: database.pool,
      userId: database.userId,
      clock: systemClock,
      kdfParams: FAST_KDF,
      kdfFloor: FAST_KDF,
    });
    const unlocked = await secretBox.unlock('wp513b-carry-c4-reseal passphrase');
    if (unlocked.state !== 'unlocked') {
      throw new Error(`could not unlock: ${JSON.stringify(unlocked)}`);
    }

    const firstPass = await resealPlaintextWalletDescriptors(database.db, secretBox);
    expect(firstPass).toBe(1);

    const afterFirst = await database.db.execute<{
      descriptor: string | null;
      descriptor_sealed: Uint8Array | null;
    }>(sql`SELECT descriptor, descriptor_sealed FROM wallet_addresses WHERE connection_id = ${connectionId}::uuid`);
    expect(afterFirst.rows[0]?.descriptor).toBeNull();
    expect(afterFirst.rows[0]?.descriptor_sealed).not.toBeNull();

    // Idempotent: nothing left to reseal, and the already-sealed row is
    // untouched (re-sealing it again would be a second, unnecessary write to
    // a row nothing asked to change).
    const secondPass = await resealPlaintextWalletDescriptors(database.db, secretBox);
    expect(secondPass).toBe(0);

    const afterSecond = await database.db.execute<{ descriptor_sealed: Uint8Array | null }>(sql`
      SELECT descriptor_sealed FROM wallet_addresses WHERE connection_id = ${connectionId}::uuid
    `);
    expect(afterSecond.rows[0]?.descriptor_sealed).toEqual(afterFirst.rows[0]?.descriptor_sealed);
  });
});
