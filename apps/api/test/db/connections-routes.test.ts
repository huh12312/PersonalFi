// SPDX-License-Identifier: MIT
/**
 * `/connectors`, `/connections`, `/imports/csv`, `/accounts` and `/net-worth`.
 *
 * The claims:
 *
 * 1. **The "add a connection" screen is data.** `GET /connectors` returns the
 *    registry verbatim, so a new adapter reaches the UI by being registered at
 *    the composition root (08 §2.7) and by nothing else.
 * 2. **Step-up guards the three dangerous verbs.** Adding a connection,
 *    completing or reconnecting one, and removing one all need a WebAuthn
 *    assertion from the last five minutes; reading does not. The class of
 *    attack is a stolen session cookie (decision D21).
 * 3. **No credential appears in any payload** — not as a field, not as a
 *    redacted placeholder, not as a boolean called `hasToken`.
 * 4. **Re-linking preserves account identity.** 08 §3.9 calls losing it "the
 *    classic way a personal finance app silently doubles a user's net worth",
 *    so the reconnect test asserts the account ids are the *same* ids.
 * 5. **Disconnect keeps the data.** "Disconnect" and "delete my data" are
 *    different requests and only one of them is reversible.
 * 6. **Net worth never lies by omission**: an account that cannot be counted
 *    appears in `inputs` with a reason, rather than vanishing.
 */
import { DateOnly, money, systemClock } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
import { recordBalance } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  syncConnection,
  type ApiHarness,
  type LinkedConnection,
} from '../helpers/api-harness.ts';

const SAVINGS = 'savings';

interface ConnectionSummary {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly status: string;
}

describe.skipIf(NO_DATABASE)('connection and account routes', () => {
  let h: ApiHarness;
  let link: LinkedConnection;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'conn' });
    link = await linkManual(h, {
      providerConnectionId: 'conn-1',
      displayName: 'Big Bank',
      accounts: [
        { providerAccountId: SAVINGS, name: 'Rainy Day', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: SAVINGS,
            providerTransactionId: 'save-1',
            amount: money(150_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-02'),
            name: 'OPENING DEPOSIT',
          }),
        ],
        balances: [
          {
            providerAccountId: SAVINGS,
            current: money(150_000n, 'USD'),
            available: null,
            limit: null,
            asOf: new Date('2026-05-03T00:00:00.000Z'),
          },
        ],
      },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  // ------------------------------------------------------------- connectors

  it('renders the add-a-connection screen from the registry', async () => {
    const response = await h.request({ method: 'GET', url: '/connectors', session: h.stale });
    expectStatus(response, 200);
    const connectors = (
      response.json() as {
        connectors: {
          provider: string;
          displayName: string;
          iconKey: string;
          linkKind: string;
          capabilities: { supports: string[]; reconnectFlow: string };
        }[];
      }
    ).connectors;

    expect(connectors.map((connector) => connector.provider).sort()).toEqual([
      'file_import',
      'manual',
      'seed',
    ]);

    const manual = connectors.find((connector) => connector.provider === 'manual');
    expect(manual?.capabilities.supports).toContain('transactions');
    // Nothing to reconnect: a manual account has no credential that can expire.
    expect(manual?.capabilities.reconnectFlow).toBe('none');
    // An asset key, never a URL: this payload is server-controlled and the
    // browser must not be tellable to fetch something arbitrary from it.
    for (const connector of connectors) {
      expect(connector.iconKey).not.toMatch(/^https?:/);
    }
  });

  it('requires a session to see the connector list', async () => {
    const response = await h.request({ method: 'GET', url: '/connectors' });
    expect(response.statusCode).toBe(401);
  });

  // ---------------------------------------------------------------- step-up

  it('refuses to link a provider without a step-up assertion', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/connections',
      session: h.stale,
      body: {
        provider: 'manual',
        input: {
          displayName: 'Sneaky Bank',
          providerConnectionId: 'conn-sneaky',
          accounts: [{ providerAccountId: 'x', name: 'X', type: 'depository', currency: 'USD' }],
        },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');

    // And nothing was created: the guard runs before the handler, so a refused
    // link must leave no row behind.
    const list = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    const connections = (list.json() as { connections: ConnectionSummary[] }).connections;
    expect(connections.map((connection) => connection.displayName)).not.toContain('Sneaky Bank');
  });

  it('refuses to disconnect without a step-up assertion', async () => {
    const response = await h.request({
      method: 'DELETE',
      url: `/connections/${link.connectionId}`,
      session: h.stale,
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');
  });

  it('refuses to reconnect without a step-up assertion', async () => {
    const response = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/reconnect`,
      session: h.stale,
      body: { input: {} },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');
  });

  // ------------------------------------------------------------ reading them

  it('lists connections with status and freshness and no credential anywhere', async () => {
    const response = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    expectStatus(response, 200);
    const body = response.json() as { connections: ConnectionSummary[] };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.provider).toBe('manual');
    expect(body.connections[0]?.displayName).toBe('Big Bank');
    expect(body.connections[0]?.status).toBe('active');

    // The negative assertion that matters, over the whole serialised payload.
    const raw = response.body.toLowerCase();
    for (const forbidden of ['access_token', 'accesstoken', 'credential', 'secret', 'hastoken']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('returns one connection with its accounts and its recent runs', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/connections/${link.connectionId}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      accounts: { accountId: string }[];
      recentRuns: { status: string; trigger: string }[];
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.recentRuns.length).toBeGreaterThanOrEqual(1);
    // Every attempt leaves a row, including the initial backfill.
    expect(body.recentRuns[0]?.trigger).toBe('initial');
  });

  it('answers 404 with the context’s own code for a connection that is not there', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/connections/01920000-0000-7000-8000-0000000fffff',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('connections.not_found');
  });

  // ------------------------------------------------------------------- sync

  it('accepts a sync with 202 and runs a process-local adapter inline', async () => {
    h.manualStore.append(link.providerConnectionId, {
      added: [
        manualTransaction({
          providerAccountId: SAVINGS,
          providerTransactionId: 'save-2',
          amount: money(-2_500n, 'USD'),
          postedDate: DateOnly.parse('2026-05-04'),
          name: 'TRANSFER OUT',
        }),
      ],
    });

    const body = await syncConnection(h, link.connectionId);
    // `inline`, because `ManualConnector` stages in *this* process: a job the
    // API enqueued would be picked up by a worker with an empty store and would
    // report a successful sync of nothing.
    expect(body['mode']).toBe('inline');
    expect(body['jobId']).toBeNull();
    expect(body['syncRunId']).toEqual(expect.any(String));
    expect(body['status']).toBe('success');

    const list = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it('records every attempt in the sync history', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/connections/${link.connectionId}/sync-runs?limit=10`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const runs = (
      response.json() as { runs: { status: string; trigger: string; startedAt: string }[] }
    ).runs;
    // The initial backfill and the manual sync above.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.map((run) => run.trigger)).toContain('manual');
    expect(runs.every((run) => run.status === 'success')).toBe(true);
  });

  // -------------------------------------------------------------- reconnect

  it('preserves account identity across a reconnect', async () => {
    // 08 §3.9: losing account identity on reconnect is the classic way a
    // personal finance app silently doubles a user's net worth. The assertion
    // is that the ids are the *same* ids, not merely that there are as many.
    const before = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const beforeIds = (before.json() as { accounts: { id: string }[] }).accounts
      .map((account) => account.id)
      .sort();

    const response = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/reconnect`,
      session: h.fresh,
      body: {
        input: {
          displayName: 'Big Bank',
          providerConnectionId: link.providerConnectionId,
          accounts: [
            { providerAccountId: SAVINGS, name: 'Rainy Day', type: 'depository', currency: 'USD' },
          ],
        },
      },
    });
    expectStatus(response, 200);
    const body = response.json() as {
      connectionId: string;
      relinked: boolean;
      accountIds: string[];
      reconnectFlow: string;
    };
    expect(body.connectionId).toBe(link.connectionId);
    expect(body.relinked).toBe(true);
    expect(body.reconnectFlow).toBe('none');

    const after = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const afterIds = (after.json() as { accounts: { id: string }[] }).accounts
      .map((account) => account.id)
      .sort();
    expect(afterIds).toEqual(beforeIds);

    // And still exactly one connection: a re-link updates the row, it never
    // creates a second one.
    const list = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    expect((list.json() as { connections: unknown[] }).connections).toHaveLength(1);
  });

  // --------------------------------------------------------------- accounts

  /**
   * **A gap in `@ctx/connections`, closed.**
   *
   * `SyncOrchestrator` used to never call `connector.syncBalances`, so nothing
   * in the context ever called the `LedgerWriter.recordBalance` port it
   * declares, and every account linked through a provider had `balance: null`
   * forever. The orchestrator now runs a balances step (invariant 6, see its
   * header comment) after the transactions half of a sync has committed or
   * definitively failed, and the initial backfill on `POST /connections` above
   * ran that step against the balance staged in `beforeAll`'s batch. This test
   * asserts the account the read model renders carries exactly that
   * observation — the one `@ctx/connections`'s own `test/db/orchestrator.test.ts`
   * proves the orchestrator recorded, seen here through the route a user
   * actually hits.
   */
  it('records a balance from a sync, and the accounts route renders it', async () => {
    const response = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(response, 200);
    const accounts = (
      response.json() as {
        accounts: {
          classification: string;
          balance: { current: { minor: string }; asOf: string; source: string } | null;
        }[];
      }
    ).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.classification).toBe('asset');
    // The exact observation staged on `beforeAll`'s initial batch, carried
    // through the real orchestrator and the real `recordBalance` — not a
    // balance this test wrote itself.
    expect(accounts[0]?.balance?.current.minor).toBe('150000');
    expect(accounts[0]?.balance?.asOf).toBe('2026-05-03T00:00:00.000Z');
    expect(accounts[0]?.balance?.source).toBe('provider');
  });

  it('renders a later balance that says when, and nets it per currency', async () => {
    // A second observation, later than the one the sync above already
    // recorded, written through `@ctx/ledger`'s real `recordBalance` — the
    // exact function the `LedgerWriter` port hands to `@ctx/connections` — and
    // then asserts what the *routes* do with it. That keeps the
    // serialisation, the "latest observation wins" read and the per-currency
    // netting under test independently of the sync path above.
    const accountsBefore = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountId =
      (accountsBefore.json() as { accounts: { id: string }[] }).accounts[0]?.id ?? '';

    await recordBalance(
      h.database.db,
      {
        userId: h.userId,
        accountId,
        current: money(147_500n, 'USD'),
        available: money(147_500n, 'USD'),
        limit: null,
        asOf: new Date('2026-05-05T00:00:00.000Z'),
        source: 'provider',
      },
      { clock: systemClock, correlationId: '01920000-0000-7000-8000-0000000000c5' },
    );

    const response = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(response, 200);
    const account = (
      response.json() as {
        accounts: {
          classification: string;
          balance: { current: { minor: string }; asOf: string; source: string } | null;
        }[];
      }
    ).accounts[0];
    expect(account?.balance?.current.minor).toBe('147500');
    // Every balance answers "as of when?" — 04 §4.5, 05 §4.4. An account whose
    // institution needs re-authentication shows its last known balance with an
    // "as of" caption rather than being hidden or zeroed.
    expect(account?.balance?.asOf).toBe('2026-05-05T00:00:00.000Z');
    expect(account?.balance?.source).toBe('provider');

    const netWorth = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
    expectStatus(netWorth, 200);
    const body = netWorth.json() as {
      asOf: string | null;
      totals: { currency: string; assets: { minor: string }; net: { minor: string } }[];
    };
    expect(body.totals).toHaveLength(1);
    expect(body.totals[0]?.currency).toBe('USD');
    expect(body.totals[0]?.net.minor).toBe('147500');
    expect(body.asOf).toBe('2026-05-05T00:00:00.000Z');
  });

  it('refuses a PATCH that says nothing', async () => {
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountId = (accounts.json() as { accounts: { id: string }[] }).accounts[0]?.id ?? '';
    const response = await h.request({
      method: 'PATCH',
      url: `/accounts/${accountId}`,
      session: h.stale,
      body: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('takes an account out of net worth and puts it back', async () => {
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountId = (accounts.json() as { accounts: { id: string }[] }).accounts[0]?.id ?? '';

    const off = await h.request({
      method: 'PATCH',
      url: `/accounts/${accountId}`,
      session: h.stale,
      body: { includeInNetWorth: false },
    });
    expectStatus(off, 200);
    expect((off.json() as { changed: boolean }).changed).toBe(true);

    const excluded = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
    const body = excluded.json() as {
      totals: unknown[];
      inputs: { included: boolean; excludedReason: string | null }[];
    };
    expect(body.totals).toHaveLength(0);
    // Net worth does not lie by omission: the account is still in `inputs`,
    // with the reason it did not count.
    expect(body.inputs).toHaveLength(1);
    expect(body.inputs[0]?.included).toBe(false);
    expect(body.inputs[0]?.excludedReason).toBe('opted_out');

    const on = await h.request({
      method: 'PATCH',
      url: `/accounts/${accountId}`,
      session: h.stale,
      body: { includeInNetWorth: true },
    });
    expectStatus(on, 200);
    const restored = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
    expect((restored.json() as { totals: { net: { minor: string } }[] }).totals[0]?.net.minor).toBe(
      '147500',
    );
  });

  it('hides a closed account from the list but keeps its transactions', async () => {
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountId = (accounts.json() as { accounts: { id: string }[] }).accounts[0]?.id ?? '';

    const closed = await h.request({
      method: 'PATCH',
      url: `/accounts/${accountId}`,
      session: h.stale,
      body: { closed: true },
    });
    expectStatus(closed, 200);
    const body = closed.json() as { account: { closedAt: string | null } };
    expect(body.account.closedAt).toEqual(expect.any(String));

    const hidden = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expect((hidden.json() as { accounts: unknown[] }).accounts).toHaveLength(0);

    const shown = await h.request({
      method: 'GET',
      url: '/accounts?includeClosed=true',
      session: h.stale,
    });
    expect((shown.json() as { accounts: unknown[] }).accounts).toHaveLength(1);

    // "Delete the account" and "stop showing me this account" are different
    // requests: every transaction it ever had is still there.
    const transactions = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expect((transactions.json() as { items: unknown[] }).items).toHaveLength(2);

    await h.request({
      method: 'PATCH',
      url: `/accounts/${accountId}`,
      session: h.stale,
      body: { closed: false, includeInNetWorth: true },
    });
  });

  // ----------------------------------------------------------- file imports

  it('imports a CSV onto a new connection, and skips the same rows on re-upload', async () => {
    const content = [
      'Date,Description,Amount',
      '2026-04-01,COFFEE BAR,-4.50',
      '2026-04-02,BOOK SHOP,-22.00',
      '2026-04-03,REFUND,12.00',
    ].join('\n');

    const file = {
      name: 'april.csv',
      content,
      format: 'csv' as const,
      presetId: 'iso_signed',
      account: {
        providerAccountId: 'csv-checking',
        name: 'Imported Checking',
        type: 'depository' as const,
        currency: 'USD',
      },
    };

    const first = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: { displayName: 'April statement', files: [file] },
    });
    expectStatus(first, 200);
    const created = first.json() as { connectionId: string; syncRunId: string | null };
    expect(created.connectionId).toEqual(expect.any(String));

    const imported = await h.request({
      method: 'GET',
      url: '/transactions?q=COFFEE',
      session: h.stale,
    });
    expect((imported.json() as { items: unknown[] }).items).toHaveLength(1);

    // Re-importing the same file changes nothing: every row is identified by a
    // hash of its own content, and the ledger's natural key catches whatever
    // the staging layer misses.
    const second = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: { connectionId: created.connectionId, files: [file] },
    });
    expectStatus(second, 200);
    const again = second.json() as { staged: number; skipped: number; status: string | null };
    expect(again.skipped).toBe(3);
    expect(again.staged).toBe(0);

    const all = await h.request({
      method: 'GET',
      url: '/transactions?limit=200',
      session: h.stale,
    });
    // Two manual rows plus the three imported ones, and no duplicates.
    expect((all.json() as { items: unknown[] }).items).toHaveLength(5);
  });

  it('rejects an anonymous import at the CSRF gate, before any handler sees it', async () => {
    // Uploading a statement is not adding a provider credential, so D21's
    // step-up does not apply — but an anonymous upload must not work, and the
    // control that stops it first is the root CSRF hook, not the route's guard:
    // a caller with no cookies at all can prove neither origin nor token. That
    // ordering is deliberate (the gate is an `onRequest` hook on the whole
    // application), so the status is 403 and not 401.
    const response = await h.request({
      method: 'POST',
      url: '/imports/csv',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { files: [{ name: 'x.csv', content: 'Date,Description,Amount\n' }] },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('csrf_failed');
  });

  it('rejects a same-origin import that carries a CSRF pair but no session', async () => {
    // Past the gate, the route's own guard is what answers — and it answers
    // 401, without leaking whether the connection in the body exists.
    const response = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false },
      body: {
        files: [
          {
            name: 'x.csv',
            content: 'Date,Description,Amount\n2026-04-01,X,-1.00',
            presetId: 'iso_signed',
            account: {
              providerAccountId: 'nope',
              name: 'Nope',
              type: 'depository',
              currency: 'USD',
            },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(problemOf(response)['code']).toBe('not_authenticated');
  });

  // ------------------------------------------------------------- disconnect

  it('disconnects, keeps the data, and reports whether the provider slot remains', async () => {
    const response = await h.request({
      method: 'DELETE',
      url: `/connections/${link.connectionId}`,
      session: h.fresh,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      revokedAtProvider: boolean;
      providerSlotMayRemain: boolean;
    };
    // `ManualConnector.disconnect` succeeds locally, so there is no stranded
    // provider item. With Plaid a `false` here means the Item still occupies a
    // billing slot until it is removed there, and the UI has to say so.
    expect(body.revokedAtProvider).toBe(true);
    expect(body.providerSlotMayRemain).toBe(false);

    // Accounts, transactions and the sync history are kept.
    const accounts = await h.request({
      method: 'GET',
      url: '/accounts?includeClosed=true',
      session: h.stale,
    });
    expect((accounts.json() as { accounts: unknown[] }).accounts.length).toBeGreaterThanOrEqual(1);

    const transactions = await h.request({
      method: 'GET',
      url: '/transactions?limit=200',
      session: h.stale,
    });
    expect((transactions.json() as { items: unknown[] }).items).toHaveLength(5);

    const runs = await h.request({
      method: 'GET',
      url: `/connections/${link.connectionId}/sync-runs`,
      session: h.stale,
    });
    expectStatus(runs, 200);
    expect((runs.json() as { runs: unknown[] }).runs.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to disconnect the same connection twice', async () => {
    const response = await h.request({
      method: 'DELETE',
      url: `/connections/${link.connectionId}`,
      session: h.fresh,
    });
    expect(response.statusCode).toBe(409);
    expect(problemOf(response)['code']).toBe('connections.already_disconnected');
  });
});
