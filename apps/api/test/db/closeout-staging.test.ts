// SPDX-License-Identifier: MIT
/**
 * Phase 1 close-out, D-5: durable staging for Manual/CSV, proved through the
 * real HTTP API rather than through the connector or the store in isolation
 * (`packages/contexts/connections/test/db/staging.test.ts` owns that half).
 *
 * gate-security-review.md §8.6 N-7 / §8.11 D-5: `ManualStore` and
 * `CsvImportConnector`'s own `#staged` map were per-process, in-memory state.
 * That meant a user-triggered sync after an api restart failed
 * (`AUTH_REQUIRED`, "this manual connection has been disconnected"/"this
 * import has been disconnected; upload the file again"), and the worker — a
 * different process — could never sync one of these connections at all.
 * `connection_staged_facts` (migration `0008_connections_staging.sql`) and
 * `apps/api/src/domain.ts`'s `attachDurableStaging` close both gaps. This
 * file proves the closed gap by literally doing the thing that used to fail:
 * building a **second, independent process** — its own connector pool, its
 * own `ManualStore`/`CsvImportConnector`, its own unlocked `SecretBox` — over
 * the *same* database a first process staged and synced through, and showing
 * that process can pick up exactly where the first one left off.
 *
 * `createInstance` below is deliberately not `../helpers/api-harness.ts`'s
 * `createApiHarness`: that helper creates one scratch database per instance,
 * which is correct for every other route suite (they are testing routes, one
 * process at a time) and wrong for this one, whose entire claim is about
 * *two* processes sharing *one* database. `createInstance` takes an existing
 * database's URL and builds everything else — pool, registry, config,
 * `SecurityRuntime`, the app — fresh, the same recipe `createApiHarness` uses
 * for a single instance.
 */
import { CSV_MANIFEST, CsvImportConnector } from '@connector/csv';
import {
  MANUAL_MANIFEST,
  MANUAL_PROVIDER,
  ManualConnector,
  ManualStore,
  manualTransaction,
} from '@connector/manual';
import { loadConfig, type AppConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { silentLogger } from '@core/platform';
import { SecretBox } from '@core/secretbox';
import { ADMIN_URL, createTestDatabase, endPool, type TestDatabase } from '@core/testkit';
import { ConnectorRegistry, listSyncableConnections } from '@ctx/connections';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createConnectorRegistry, createDomainRuntime } from '../../src/domain.ts';
import { createTempSecrets } from '../helpers/secrets.ts';

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
const NO_DATABASE = ADMIN_URL === undefined;

const TEST_ORIGIN = 'http://127.0.0.1:8080';

/**
 * The development KDF floor — matches `../helpers/api-harness.ts`'s `TEST_KDF`
 * exactly, deliberately: every process built below has to derive the *same*
 * KEK from the *same* `master_key` passphrase over the *same* database, and
 * the derivation parameters are part of what has to match.
 */
const TEST_KDF = {
  KEK_ARGON2_MEMORY_KIB: '8192',
  KEK_ARGON2_TIME_COST: '2',
  KEK_ARGON2_PARALLELISM: '1',
} as const;

interface TestSession {
  readonly accessToken: string;
  readonly csrf: string;
}

interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly session?: TestSession;
  readonly body?: unknown;
}

interface Instance {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly manualStore: ManualStore;
  issueSession(userId: string, fresh?: boolean): Promise<TestSession>;
  request(options: ApiRequest): Promise<LightMyRequestResponse>;
  /** Close the app and this instance's own pool. Never touches the database itself. */
  close(): Promise<void>;
}

function configFor(databaseUrl: string, secretsDir: string): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: databaseUrl,
      SECRETS_DIR: secretsDir,
      BASE_URL: TEST_ORIGIN,
      AUTH_ALLOWED_ORIGINS: TEST_ORIGIN,
      AUTH_RP_ID: '127.0.0.1',
      ...TEST_KDF,
    },
  });
}

/**
 * Build one independent "process": its own pool, its own in-memory
 * `ManualStore`/`CsvImportConnector`, its own `SecurityRuntime` deriving the
 * KEK afresh from the same passphrase and the same `encryption_keys` row a
 * prior instance may have created. Nothing here is shared with any other
 * `Instance` except `databaseUrl`.
 */
async function createInstance(databaseUrl: string): Promise<Instance> {
  const secrets = createTempSecrets();
  const pool = createPool({ databaseUrl, applicationName: `closeout-staging-${newId()}`, max: 8 });
  const manualStore = new ManualStore();
  const registry = new ConnectorRegistry([
    { connector: new ManualConnector({ store: manualStore }), manifest: MANUAL_MANIFEST },
    { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
  ]);
  const config = configFor(databaseUrl, secrets.dir);
  const { app, security } = await buildApp({ config, pool, connectorRegistry: registry });

  // `main.ts`'s step, not `buildApp`'s — see `app.ts`'s own comment on why the
  // KEK is derived lazily.
  const state = await security.initialise();
  if (state.state !== 'unlocked') {
    throw new Error(`instance could not unlock: ${JSON.stringify(state)}`);
  }
  await app.ready();

  return {
    app,
    pool,
    manualStore,

    async issueSession(userId, fresh = false) {
      const identity = security.requireIdentity();
      const issued = await identity.sessions.issue({ userId, authMethod: 'webauthn', fresh });
      return {
        accessToken: issued.accessToken,
        csrf: Buffer.from(newId().replaceAll('-', ''), 'hex').toString('base64url').padEnd(40, 'x'),
      };
    },

    async request(req) {
      const cookies: string[] = [];
      const headers: Record<string, string> = {
        'sec-fetch-site': 'same-origin',
        origin: TEST_ORIGIN,
      };
      if (req.session !== undefined) {
        cookies.push(`__Host-pfi_session=${req.session.accessToken}`);
        cookies.push(`__Host-pfi_csrf=${req.session.csrf}`);
        headers['x-csrf-token'] = req.session.csrf;
      }
      if (cookies.length > 0) headers['cookie'] = cookies.join('; ');
      const injectOptions: InjectOptions = {
        method: req.method,
        url: req.url,
        headers,
        ...(req.body === undefined ? {} : { payload: req.body as object }),
      };
      return app.inject(injectOptions);
    },

    async close() {
      await app.close();
      security.destroy();
      secrets.dispose();
      await endPool(pool);
    },
  };
}

function expectStatus(response: LightMyRequestResponse, status: number): void {
  if (response.statusCode !== status) {
    throw new Error(
      `expected ${String(status)}, got ${String(response.statusCode)}: ${response.body}`,
    );
  }
}

interface LinkResult {
  readonly connectionId: string;
  readonly syncRunId: string | null;
}

interface SyncRunView {
  readonly operation: 'transactions' | 'balances' | 'holdings' | 'liabilities';
  readonly status: 'running' | 'success' | 'partial' | 'failed';
  readonly addedCount: number;
  readonly errorKind: string | null;
}

async function transactionsRun(
  instance: Instance,
  connectionId: string,
  session: TestSession,
): Promise<SyncRunView> {
  const response = await instance.request({
    method: 'GET',
    url: `/connections/${connectionId}/sync-runs`,
    session,
  });
  expectStatus(response, 200);
  const { runs } = response.json() as { runs: SyncRunView[] };
  const run = runs.find((r) => r.operation === 'transactions');
  if (run === undefined) throw new Error('no transactions sync run recorded');
  return run;
}

describe.skipIf(NO_DATABASE)('durable staging end to end (decision D-5)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(
      `personalfi_closeout_stg_${newId().replaceAll('-', '').slice(-10)}`,
    );
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it(
    'a Manual connection staged in one process syncs correctly in a second process over the ' +
      'same database — restart survival, and each staged row consumed exactly once',
    async () => {
      const providerConnectionId = `restart-manual-${newId()}`;
      const first = await createInstance(database.url);
      try {
        const sessionA = await first.issueSession(database.userId, true);

        // The opening batch, staged directly into this process's `ManualStore`
        // before the connector has ever seen a `connectionId` — exactly how a
        // real Manual account's first entries are staged (see
        // `@connector/manual/src/connector.ts`'s `#local` doc comment).
        first.manualStore.open(providerConnectionId);
        first.manualStore.append(providerConnectionId, {
          added: [
            manualTransaction({
              providerAccountId: 'checking',
              providerTransactionId: 'txn-batch1-a',
              amount: money(-500n, 'USD'),
              postedDate: DateOnly.parse('2026-06-01'),
              name: 'COFFEE SHOP',
            }),
            manualTransaction({
              providerAccountId: 'checking',
              providerTransactionId: 'txn-batch1-b',
              amount: money(-2_000n, 'USD'),
              postedDate: DateOnly.parse('2026-06-02'),
              name: 'GROCERY STORE',
            }),
          ],
        });

        const linkResponse = await first.request({
          method: 'POST',
          url: '/connections',
          session: sessionA,
          body: {
            provider: MANUAL_PROVIDER,
            input: {
              displayName: 'Everyday Checking',
              providerConnectionId,
              accounts: [
                {
                  providerAccountId: 'checking',
                  name: 'Everyday Checking',
                  type: 'depository',
                  currency: 'USD',
                },
              ],
            },
          },
        });
        expectStatus(linkResponse, 201);
        const linked = linkResponse.json() as LinkResult;
        expect(linked.syncRunId).not.toBeNull();

        // Sync run 1 consumed exactly the two rows staged above.
        const runOne = await transactionsRun(first, linked.connectionId, sessionA);
        expect(runOne.status).toBe('success');
        expect(runOne.addedCount).toBe(2);

        await first.close();

        // A second process. Its `ManualStore` has never heard of this
        // connection — before decision D-5, `POST /connections/:id/sync` here
        // would fail `AUTH_REQUIRED`: "this manual connection has been
        // disconnected" (gate-security-review.md §8.6).
        const second = await createInstance(database.url);
        try {
          const sessionB = await second.issueSession(database.userId, false);

          const syncResponse = await second.request({
            method: 'POST',
            url: `/connections/${linked.connectionId}/sync`,
            session: sessionB,
          });
          expectStatus(syncResponse, 202);
          const syncBody = syncResponse.json() as { mode: string; status: string | null };
          expect(syncBody.mode).toBe('inline');
          expect(syncBody.status).toBe('success');

          // Nothing new was staged, so sync run 2 adds zero — the two rows
          // batch 1 staged were consumed exactly once, by run 1, not again
          // here.
          const runTwo = await transactionsRun(second, linked.connectionId, sessionB);
          expect(runTwo.addedCount).toBe(0);

          // Now stage a second batch directly into the *second* process's
          // (now-hydrated) `ManualStore` and sync again: this proves the
          // cursor genuinely carried across the restart, rather than the
          // second process's zero-added run being a coincidence of hydrating
          // an already-exhausted cursor.
          expect(second.manualStore.has(providerConnectionId)).toBe(true);
          second.manualStore.append(providerConnectionId, {
            added: [
              manualTransaction({
                providerAccountId: 'checking',
                providerTransactionId: 'txn-batch2-a',
                amount: money(-750n, 'USD'),
                postedDate: DateOnly.parse('2026-06-03'),
                name: 'HARDWARE STORE',
              }),
            ],
          });

          const secondSync = await second.request({
            method: 'POST',
            url: `/connections/${linked.connectionId}/sync`,
            session: sessionB,
          });
          expectStatus(secondSync, 202);
          const runThree = await transactionsRun(second, linked.connectionId, sessionB);
          expect(runThree.addedCount).toBe(1);
        } finally {
          await second.close();
        }
      } finally {
        await first.close().catch(() => undefined);
      }
    },
  );

  it('a CSV import staged in one process syncs successfully in a second process over the same database', async () => {
    const content = [
      'Date,Description,Amount',
      '2026-04-01,COFFEE BAR,-4.50',
      '2026-04-02,BOOK SHOP,-22.00',
    ].join('\n');
    const file = {
      name: 'closeout.csv',
      content,
      format: 'csv' as const,
      presetId: 'iso_signed',
      account: {
        providerAccountId: 'csv-closeout-checking',
        name: 'Imported Checking',
        type: 'depository' as const,
        currency: 'USD',
      },
    };

    const first = await createInstance(database.url);
    let connectionId: string;
    try {
      const sessionA = await first.issueSession(database.userId, false);
      const importResponse = await first.request({
        method: 'POST',
        url: '/imports/csv',
        session: sessionA,
        body: { displayName: 'Closeout import', files: [file] },
      });
      expectStatus(importResponse, 200);
      const imported = importResponse.json() as { connectionId: string; syncRunId: string | null };
      expect(imported.syncRunId).not.toBeNull();
      connectionId = imported.connectionId;

      const runOne = await transactionsRun(first, connectionId, sessionA);
      expect(runOne.status).toBe('success');
      expect(runOne.addedCount).toBe(2);
    } finally {
      await first.close();
    }

    // A second process, with an empty `CsvImportConnector`. Before D-5, the
    // route below would fail `AUTH_REQUIRED`: "this import has been
    // disconnected; upload the file again".
    const second = await createInstance(database.url);
    try {
      const sessionB = await second.issueSession(database.userId, false);
      const syncResponse = await second.request({
        method: 'POST',
        url: `/connections/${connectionId}/sync`,
        session: sessionB,
      });
      expectStatus(syncResponse, 202);
      const body = syncResponse.json() as { mode: string; status: string | null };
      expect(body.mode).toBe('inline');
      expect(body.status).toBe('success');
      const runTwo = await transactionsRun(second, connectionId, sessionB);
      expect(runTwo.addedCount).toBe(0);
    } finally {
      await second.close();
    }
  });

  it("a second account holder cannot see or sync the first holder's connection", async () => {
    const providerConnectionId = `scope-manual-${newId()}`;
    const instance = await createInstance(database.url);
    try {
      const ownerSession = await instance.issueSession(database.userId, true);
      instance.manualStore.open(providerConnectionId);
      const linkResponse = await instance.request({
        method: 'POST',
        url: '/connections',
        session: ownerSession,
        body: {
          provider: MANUAL_PROVIDER,
          input: {
            displayName: 'Owner-only account',
            providerConnectionId,
            accounts: [
              {
                providerAccountId: 'owner-checking',
                name: 'Owner Checking',
                type: 'depository',
                currency: 'USD',
              },
            ],
          },
        },
      });
      expectStatus(linkResponse, 201);
      const { connectionId } = linkResponse.json() as LinkResult;

      const otherUserId = await database.createUser('Second Holder');
      const otherSession = await instance.issueSession(otherUserId, false);

      const readAttempt = await instance.request({
        method: 'GET',
        url: `/connections/${connectionId}`,
        session: otherSession,
      });
      expect(readAttempt.statusCode).toBe(404);

      const syncAttempt = await instance.request({
        method: 'POST',
        url: `/connections/${connectionId}/sync`,
        session: otherSession,
      });
      expect(syncAttempt.statusCode).toBe(404);

      // The owner can still reach it — the 404s above are ownership, not a
      // broken connection.
      const ownerRead = await instance.request({
        method: 'GET',
        url: `/connections/${connectionId}`,
        session: ownerSession,
      });
      expectStatus(ownerRead, 200);
    } finally {
      await instance.close();
    }
  });

  it(
    'the nightly fan-out includes a Manual connection with no PROCESS_LOCAL_PROVIDERS filter, ' +
      'and a worker-shaped process completes its sync',
    async () => {
      const providerConnectionId = `fanout-manual-${newId()}`;
      const api = await createInstance(database.url);
      let connectionId: string;
      try {
        const session = await api.issueSession(database.userId, true);
        api.manualStore.open(providerConnectionId);
        api.manualStore.append(providerConnectionId, {
          added: [
            manualTransaction({
              providerAccountId: 'fanout-checking',
              providerTransactionId: 'txn-fanout-a',
              amount: money(-1_500n, 'USD'),
              postedDate: DateOnly.parse('2026-06-10'),
              name: 'UTILITY CO',
            }),
          ],
        });
        const linkResponse = await api.request({
          method: 'POST',
          url: '/connections',
          session,
          body: {
            provider: MANUAL_PROVIDER,
            input: {
              displayName: 'Fan-out account',
              providerConnectionId,
              accounts: [
                {
                  providerAccountId: 'fanout-checking',
                  name: 'Fan-out Checking',
                  type: 'depository',
                  currency: 'USD',
                },
              ],
            },
          },
        });
        expectStatus(linkResponse, 201);
        ({ connectionId } = linkResponse.json() as LinkResult);
      } finally {
        await api.close();
      }

      // The worker's own composition root (`apps/api/src/worker.ts`): its own
      // pool, its own `SecretBox` unlocked the same way `worker.ts` unlocks
      // one, its own registry built by the *same* `createConnectorRegistry`
      // the real worker calls, and `createDomainRuntime` — the one place
      // durable staging is attached (`domain.ts`'s `attachDurableStaging`).
      const workerSecrets = createTempSecrets();
      const workerPool = createPool({
        databaseUrl: database.url,
        applicationName: 'closeout-worker',
        max: 4,
      });
      try {
        const workerConfig = configFor(database.url, workerSecrets.dir);
        const passphrase = workerConfig.secrets.master_key;
        if (passphrase === undefined) throw new Error('worker config has no master_key');
        const box = new SecretBox({
          db: workerPool,
          userId: database.userId,
          clock: systemClock,
          kdfParams: workerConfig.kek.params,
          kdfFloor: workerConfig.kek.floor,
        });
        const unlockState = await box.unlock(passphrase.reveal());
        if (unlockState.state !== 'unlocked') {
          throw new Error(`worker could not unlock: ${JSON.stringify(unlockState)}`);
        }

        const workerDatabase = createDatabase(workerPool);
        const workerRegistry = createConnectorRegistry({ plaid: null, logger: silentLogger });
        const { orchestrator } = createDomainRuntime({
          database: workerDatabase,
          clock: systemClock,
          logger: silentLogger,
          registry: workerRegistry,
          secretBox: box,
        });

        // This is exactly `apps/api/src/modules.ts`'s `syncableConnectionIds`,
        // post re-gate: no `PROCESS_LOCAL_PROVIDERS` filter, so a Manual
        // connection this worker process never linked is still in the list.
        const syncable = await listSyncableConnections(workerDatabase, database.userId);
        expect(syncable.map((row) => row.id)).toContain(connectionId);

        const summary = await orchestrator.syncConnection({
          connectionId,
          userId: database.userId,
          trigger: 'scheduled',
          correlationId: newId(),
        });
        // `status: 'success'` is the claim: before D-5 this call threw
        // `AUTH_REQUIRED` ("this manual connection has been disconnected") —
        // the exact failure gate-security-review.md §8.6 observed on the real
        // worker after the first nightly run. `addedCount` is legitimately 0,
        // not evidence of nothing happening: `POST /connections` above already
        // ran an inline sync (process-local providers always sync inline at
        // link time) that consumed the one staged row, in the *api* process.
        // This call is the worker completing a full, idempotent sync of a
        // connection it never linked — the thing the old filter made
        // impossible to even attempt.
        expect(summary.status).toBe('success');
        expect(summary.error).toBeNull();
        expect(summary.addedCount).toBe(0);
      } finally {
        workerSecrets.dispose();
        await endPool(workerPool);
      }
    },
  );
});
