// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-13 (G4-20,
 * `docs/evidence/phase-4/gate-security-review.md` §3.17).
 *
 * G4-20's finding, quoted: "a connection whose balances/holdings legs fail
 * `CONFIG_ERROR` reads 'Connected'. The connection's status is derived
 * without the per-leg outcomes: after two `failed` runs of three, `status`
 * stays `active`, `errorSince`/`lastErrorKind` stay null, and the screen says
 * 'Connected · Synced 1 minute ago' beside an account that will never have a
 * balance… Remedy: a leg failure with a non-retryable condition
 * (`CONFIG_ERROR`) sets the connection's error state and names the missing
 * key."
 *
 * Traced to source (`src/orchestrator.ts`): `#settleStatus` — the only thing
 * that ever called `setConnectionStatus` — has exactly one call site, for the
 * **transactions** leg's own failure, before invariants 6 (balances) and 7
 * (holdings/investment_txns/liabilities) even run. Neither `#syncBalancesIfDue`
 * nor `#datasetLeg` touched the connection's status at all, no matter what
 * they failed with — exactly reproducing the live finding.
 *
 * This WP's fix: `#markLegConfigError`, called from both `#syncBalancesIfDue`
 * and `#datasetLeg`'s `holdings` operation, moves the connection to `error`
 * and writes `lastError` (naming the cause — the provider's own message,
 * carried verbatim through `errorDetailOf`) whenever that leg's failure is
 * `invalid_input` (`CONFIG_ERROR`'s kind) — never for a merely-transient
 * failure (`PROVIDER_DOWN` stays `active`, unchanged from before this WP,
 * proven in `orchestrator.test.ts`'s own pre-existing "records a balances
 * failure…" test), and never for `INSUFFICIENT_SCOPE`/`DATA_UNAVAILABLE`
 * (`permanent`-kind — this file's own header comment: narrowing a capability
 * "is not a broken connection").
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requireConnection } from '../../src/connections.ts';
import { ConnectorError, type Connector } from '../../src/port.ts';
import {
  CORRELATION_ID,
  ManualConnector,
  ManualStore,
  NO_DATABASE,
  connectionsDatabase,
  connectorWith,
  linkFor,
  manualBatch,
  orchestratorFor,
  type OrchestratorFixture,
  type TestDatabase,
} from '../harness.ts';

const ACCOUNTS = [
  {
    providerAccountId: 'acct-checking',
    name: 'Everyday Checking',
    type: 'depository',
    currency: 'USD',
  },
];
const PAGE_SIZE = 3;
const ROW_COUNT = 4;

describe.skipIf(NO_DATABASE)(
  'WP 5.13b carry C-13 (G4-20) — a non-retryable leg failure sets the connection error state and names the cause',
  () => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await connectionsDatabase('wp513b-c13');
    }, 180_000);

    afterAll(async () => {
      await database.drop();
    });

    afterEach(async () => {
      await database.truncate();
    });

    async function linkedManual(patch: (honest: ManualConnector) => Partial<Connector>): Promise<{
      fixture: OrchestratorFixture;
      connectionId: string;
    }> {
      const store = new ManualStore();
      const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
      const connector = connectorWith(honest, patch(honest));
      const fixture = await orchestratorFor(database, connector, {});
      const { connectionId } = await linkFor(database, fixture, connector, {
        displayName: 'Wallet-shaped bank',
        providerConnectionId: 'wp513b-c13-item',
        accounts: ACCOUNTS,
      });
      store.append('wp513b-c13-item', { added: manualBatch(ROW_COUNT) });
      return { fixture, connectionId };
    }

    it(
      'a CONFIG_ERROR balances failure moves the connection to error and names the cause, ' +
        'even though the transactions leg that ran first succeeded',
      async () => {
        const { fixture, connectionId } = await linkedManual(() => ({
          syncBalances: () =>
            Promise.reject(
              ConnectorError.fromCondition(
                'CONFIG_ERROR',
                'no etherscan_api_key is configured. Etherscan v2 requires a key even at the ' +
                  'free tier; set etherscan_api_key and reconnect this wallet.',
              ),
            ),
        }));

        const summary = await fixture.orchestrator.syncConnection({
          connectionId,
          userId: database.userId,
          trigger: 'initial',
          correlationId: CORRELATION_ID,
        });

        // The transactions leg neither knows nor cares that balances will
        // fail afterwards — exactly the live finding's own shape ("syncs
        // `transactions: success`").
        expect(summary.status).toBe('success');

        const row = await requireConnection(database.db, database.userId, connectionId);
        // Before this WP: 'active', errorSince null, lastError null — the
        // connections screen reading "Connected" beside a wallet that will
        // never have a balance. After: the leg's own failure is the
        // connection's own state.
        expect(row.status, 'the connection must not read "Connected" behind this').toBe('error');
        expect(row.errorSince).not.toBeNull();
        expect(row.lastError).toMatchObject({
          kind: 'invalid_input',
          condition: 'CONFIG_ERROR',
          operation: 'balances',
          userActionRequired: true,
          // Names the cause: the provider's own message, verbatim, the same
          // field the live wallet connector actually throws
          // (`packages/connectors/walletrpc/src/eth/etherscan.ts`).
          message: expect.stringContaining('etherscan_api_key') as unknown,
        });

        const events = await database.db.execute<{ payload: { to: string; reason: string } }>(sql`
          SELECT payload FROM domain_events
           WHERE event_type = 'connections.ConnectionStatusChanged' ORDER BY seq
        `);
        expect(events.rows.map((r) => r.payload)).toEqual([
          expect.objectContaining({ to: 'error', reason: 'invalid_input' }),
        ]);
      },
    );

    it('a CONFIG_ERROR holdings failure moves the connection to error and names the cause', async () => {
      const { fixture, connectionId } = await linkedManual((honest) => ({
        capabilities: () => ({
          ...honest.capabilities(),
          supports: [...honest.capabilities().supports, 'holdings'],
        }),
        syncHoldings: () =>
          Promise.reject(
            ConnectorError.fromCondition(
              'CONFIG_ERROR',
              'no etherscan_api_key is configured; positions cannot be read for this wallet.',
            ),
          ),
      }));

      const summary = await fixture.orchestrator.syncConnection({
        connectionId,
        userId: database.userId,
        trigger: 'initial',
        correlationId: CORRELATION_ID,
      });
      expect(summary.status).toBe('success');

      const row = await requireConnection(database.db, database.userId, connectionId);
      expect(row.status).toBe('error');
      expect(row.lastError).toMatchObject({
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        operation: 'holdings',
      });
    });

    it('a merely-transient balances failure (PROVIDER_DOWN) leaves the connection active — unchanged from before this WP', async () => {
      const { fixture, connectionId } = await linkedManual(() => ({
        syncBalances: () =>
          Promise.reject(
            ConnectorError.fromCondition('PROVIDER_DOWN', 'balances endpoint is down'),
          ),
      }));

      const summary = await fixture.orchestrator.syncConnection({
        connectionId,
        userId: database.userId,
        trigger: 'initial',
        correlationId: CORRELATION_ID,
      });
      expect(summary.status).toBe('success');

      const row = await requireConnection(database.db, database.userId, connectionId);
      expect(
        row.status,
        'PROVIDER_DOWN is retryable — the whole point of #markLegConfigError’s own kind guard',
      ).toBe('active');
      expect(row.errorSince).toBeNull();
    });

    it('a scope-narrowing holdings failure (INSUFFICIENT_SCOPE) leaves the connection active — narrowing a capability is not a broken connection', async () => {
      const { fixture, connectionId } = await linkedManual((honest) => ({
        capabilities: () => ({
          ...honest.capabilities(),
          supports: [...honest.capabilities().supports, 'holdings'],
        }),
        syncHoldings: () =>
          Promise.reject(
            ConnectorError.fromCondition('INSUFFICIENT_SCOPE', 'holdings scope not granted'),
          ),
      }));

      const summary = await fixture.orchestrator.syncConnection({
        connectionId,
        userId: database.userId,
        trigger: 'initial',
        correlationId: CORRELATION_ID,
      });
      expect(summary.status).toBe('success');

      const row = await requireConnection(database.db, database.userId, connectionId);
      expect(row.status).toBe('active');
      expect(row.errorSince).toBeNull();
    });
  },
);
