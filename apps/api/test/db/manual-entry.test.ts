// SPDX-License-Identifier: MIT
/**
 * `POST /accounts/{id}/balance` and `POST /accounts/{id}/transactions` — the
 * wp1.6 §7 carry-over: "Manual balance / manual transaction entry has no
 * route (`ManualAccountForm` reads 'No balance yet')".
 *
 * Both write straight through `@ctx/ledger`'s own writers —
 * `recordBalance` and `applyProviderTransactions` — the same functions every
 * provider's sync uses, with `source`/`provider: 'manual'` and
 * `@connector/manual`'s `manualTransaction()` computing the mandatory
 * fingerprint. Neither touches `ManualConnector`/`ManualStore`: see
 * `routes/accounts.ts`'s module comment for why.
 *
 * The claims:
 *
 * 1. **A manual balance appears in `GET /accounts` and in net worth** — the
 *    exit test, verbatim.
 * 2. **Only a `provider: "manual"` account accepts either write.** A Plaid or
 *    CSV account's numbers arrive from that adapter, not by hand.
 * 3. **Both need a step-up assertion**, matching `connections.ts`'s policy: a
 *    manual entry changes net worth exactly the way linking a connection
 *    does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CHECKING = 'checking';

interface WireAccount {
  readonly id: string;
  readonly provider: string;
  readonly currency: string;
  readonly balance: { current: { minor: string; currency: string }; source: string } | null;
}

describe.skipIf(NO_DATABASE)('manual balance and transaction entry (WP 2.5)', () => {
  let h: ApiHarness;
  let manualAccountId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'manualentry' });

    const link = await linkManual(h, {
      providerConnectionId: 'manual-entry-conn',
      displayName: 'My Own Records',
      accounts: [
        { providerAccountId: CHECKING, name: 'Cash Envelope', type: 'depository', currency: 'USD' },
      ],
    });
    const accountId = link.accountIds[0];
    if (accountId === undefined) throw new Error('linkManual returned no account');
    manualAccountId = accountId;
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a manual balance appears in GET /accounts and in net worth', async () => {
    const before = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(before, 200);
    const beforeAccount = (before.json() as { accounts: WireAccount[] }).accounts.find(
      (a) => a.id === manualAccountId,
    );
    expect(beforeAccount?.balance).toBeNull();

    const response = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/balance`,
      session: h.fresh,
      body: { current: { minor: '150000', currency: 'USD' } },
    });
    expectStatus(response, 200);
    const body = response.json() as { account: WireAccount; recorded: boolean };
    expect(body.recorded).toBe(true);
    expect(body.account.balance?.current).toEqual({ minor: '150000', currency: 'USD' });
    expect(body.account.balance?.source).toBe('manual');

    // It shows up in a fresh GET /accounts, not just in this call's response.
    const after = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const afterAccount = (after.json() as { accounts: WireAccount[] }).accounts.find(
      (a) => a.id === manualAccountId,
    );
    expect(afterAccount?.balance?.current.minor).toBe('150000');
    expect(afterAccount?.balance?.source).toBe('manual');

    // And it contributes to net worth, per the currency it was entered in.
    const netWorth = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
    expectStatus(netWorth, 200);
    const nw = netWorth.json() as {
      totals: { currency: string; assets: { minor: string } }[];
      inputs: { accountId: string; included: boolean; balance: { minor: string } | null }[];
    };
    const input = nw.inputs.find((i) => i.accountId === manualAccountId);
    expect(input?.included).toBe(true);
    expect(input?.balance?.minor).toBe('150000');
    const usdTotal = nw.totals.find((t) => t.currency === 'USD');
    expect(usdTotal).toBeDefined();
    expect(BigInt(usdTotal?.assets.minor ?? '0')).toBeGreaterThanOrEqual(150000n);
  });

  it('a manual transaction is added through applyProviderTransactions, bigint minor units, mandatory fingerprint', async () => {
    const response = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          {
            amount: { minor: '-2599', currency: 'USD' },
            postedDate: '2026-03-14',
            name: 'Hand-typed lunch',
          },
        ],
      },
    });
    expectStatus(response, 201);
    const body = response.json() as {
      addedTransactionIds: string[];
      updatedTransactionIds: string[];
    };
    expect(body.addedTransactionIds).toHaveLength(1);
    expect(body.updatedTransactionIds).toHaveLength(0);

    const list = await h.request({
      method: 'GET',
      url: `/transactions?accountIds=${manualAccountId}`,
      session: h.stale,
    });
    expectStatus(list, 200);
    const items = (
      list.json() as { items: { id: string; name: string; amount: { minor: string } }[] }
    ).items;
    const found = items.find((t) => t.id === body.addedTransactionIds[0]);
    expect(found).toBeDefined();
    expect(found?.name).toBe('Hand-typed lunch');
    expect(found?.amount.minor).toBe('-2599');

    // Re-submitting the identical row is the same fingerprint and the same
    // computed id (`manualTransaction`'s content hash) — an upsert, not a
    // second row.
    const again = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          {
            amount: { minor: '-2599', currency: 'USD' },
            postedDate: '2026-03-14',
            name: 'Hand-typed lunch',
          },
        ],
      },
    });
    expectStatus(again, 201);
    const againBody = again.json() as {
      addedTransactionIds: string[];
      updatedTransactionIds: string[];
    };
    expect(againBody.addedTransactionIds).toHaveLength(0);
    // `content_hash` matches too, so this is neither added nor updated —
    // `applyProviderTransactions` only bumps `last_seen_at`.
    expect(againBody.updatedTransactionIds).toHaveLength(0);
  });

  it('refuses a currency that does not match the account', async () => {
    const balanceMismatch = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/balance`,
      session: h.fresh,
      body: { current: { minor: '100', currency: 'EUR' } },
    });
    expect(balanceMismatch.statusCode).toBe(409);
    expect(problemOf(balanceMismatch)['code']).toBe('ledger.currency_mismatch');

    const txnMismatch = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          { amount: { minor: '-100', currency: 'EUR' }, postedDate: '2026-03-15', name: 'x' },
        ],
      },
    });
    expect(txnMismatch.statusCode).toBe(409);
    expect(problemOf(txnMismatch)['code']).toBe('ledger.currency_mismatch');
  });

  it('refuses both writes on a non-manual (provider) account', async () => {
    const csv = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: {
        displayName: 'Not manual',
        files: [
          {
            name: 'x.csv',
            content: 'Date,Description,Amount\n2026-01-01,X,-1.00',
            format: 'csv',
            presetId: 'iso_signed',
            account: {
              providerAccountId: 'not-manual',
              name: 'Not Manual',
              type: 'depository',
              currency: 'USD',
            },
          },
        ],
      },
    });
    expectStatus(csv, 200);
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const providerAccount = (accounts.json() as { accounts: WireAccount[] }).accounts.find(
      (a) => a.provider === 'file_import',
    );
    expect(providerAccount).toBeDefined();

    const balance = await h.request({
      method: 'POST',
      url: `/accounts/${providerAccount?.id ?? ''}/balance`,
      session: h.fresh,
      body: { current: { minor: '100', currency: 'USD' } },
    });
    expect(balance.statusCode).toBe(422);
    expect(problemOf(balance)['code']).toBe('ledger.account_not_manual');

    const txn = await h.request({
      method: 'POST',
      url: `/accounts/${providerAccount?.id ?? ''}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          { amount: { minor: '-100', currency: 'USD' }, postedDate: '2026-01-02', name: 'x' },
        ],
      },
    });
    expect(txn.statusCode).toBe(422);
    expect(problemOf(txn)['code']).toBe('ledger.account_not_manual');
  });

  it('needs a step-up assertion, and refuses both a stale session and no session at all', async () => {
    const stale = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/balance`,
      session: h.stale,
      body: { current: { minor: '1', currency: 'USD' } },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const staleTxn = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/transactions`,
      session: h.stale,
      body: {
        transactions: [
          { amount: { minor: '-1', currency: 'USD' }, postedDate: '2026-01-01', name: 'x' },
        ],
      },
    });
    expect(staleTxn.statusCode).toBe(403);
    expect(problemOf(staleTxn)['code']).toBe('step_up_required');

    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: true,
    };
    const anon = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/balance`,
      session: noSession,
      body: { current: { minor: '1', currency: 'USD' } },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('another user cannot write a balance or transaction onto this account', async () => {
    const otherUserId = await h.database.createUser('Manual Entry Interloper');
    const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });

    const balance = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/balance`,
      session: otherSession,
      body: { current: { minor: '1', currency: 'USD' } },
    });
    expect(balance.statusCode).toBe(404);

    const txn = await h.request({
      method: 'POST',
      url: `/accounts/${manualAccountId}/transactions`,
      session: otherSession,
      body: {
        transactions: [
          { amount: { minor: '-1', currency: 'USD' }, postedDate: '2026-01-01', name: 'x' },
        ],
      },
    });
    expect(txn.statusCode).toBe(404);
  });
});
