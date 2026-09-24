// SPDX-License-Identifier: MIT
/**
 * `PlaidConnector` end to end over `FakePlaidApi`.
 *
 * The suite is organised by the thing that would break rather than by method:
 * the sign inversion, the pending → posted hand-off, multi-page sync, the two
 * failures that are *specific* to `/transactions/sync`, and the lifecycle calls
 * that cost money.
 */
import { Money } from '@core/kernel';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvestmentTransaction, TransactionsSyncResponse } from 'plaid';
import { describe, expect, it } from 'vitest';
import { PLAID_ACCESS_TOKEN, plaidCapabilities } from '../src/provider.ts';
import { PLAID_ERRORS } from './fake.ts';
import {
  ACCESS_TOKEN,
  ACCOUNTS,
  INVESTMENTS,
  ITEM,
  PUBLIC_TOKEN,
  SYNC_PAGES,
  handleFor,
  harness,
  syncOptions,
} from './harness.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The fixture Item with Investments and Liabilities stripped from every list. */
function transactionsOnlyItem(): typeof ITEM {
  const transactionsOnly = ['transactions'] as typeof ITEM.billed_products;
  return {
    ...ITEM,
    item_id: 'item-northwind-txn-only',
    products: transactionsOnly,
    billed_products: transactionsOnly,
    consented_products: transactionsOnly,
    available_products: [],
  };
}

// ---------------------------------------------------------------------------
// The sign inversion
// ---------------------------------------------------------------------------

describe('the sign inversion happens here and nowhere else', () => {
  it('turns a Plaid-positive purchase into a negative outflow', async () => {
    // 01 §5.3 / 08 §2.5: Plaid is positive for an outflow, we are negative, and
    // "that inversion lives in the Plaid adapter and nowhere else". The fixture
    // charge is `amount: 4.5`.
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, null, options);

    const coffee = page.added.find((f) => f.providerTransactionId === 'txn-0001-pending-coffee');
    expect(coffee?.amount).toEqual(Money.parseAmount('-4.50', 'USD'));
    expect(coffee?.amount.minor).toBe(-450n);
    expect(coffee?.amount.currency).toBe('USD');
  });

  it('turns a Plaid-negative deposit into a positive inflow', async () => {
    // The payroll row is `amount: -2100.00`.
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, null, options);

    const payroll = page.added.find((f) => f.providerTransactionId === 'txn-0002-payroll');
    expect(payroll?.amount.minor).toBe(210_000n);
  });

  it('inverts every amount on every page, with no row left in Plaid sign', async () => {
    const { connector, handle, options } = harness();
    const plaidAmounts = new Map(
      SYNC_PAGES.flatMap((page) => [...page.added, ...page.modified]).map((t) => [
        t.transaction_id,
        t.amount,
      ]),
    );

    let cursor = null as Parameters<typeof connector.syncTransactions>[1];
    let seen = 0;
    for (;;) {
      const page = await connector.syncTransactions(handle, cursor, options);
      for (const fact of [...page.added, ...page.modified]) {
        const original = plaidAmounts.get(fact.providerTransactionId);
        expect(original).toBeDefined();
        expect(fact.amount.minor).toBe(-BigInt(Math.round((original ?? 0) * 100)));
        seen += 1;
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    // Six facts across five distinct ids: `txn-0004-water` is `added` on page
    // two and `modified` on page three, which is what makes the modified path
    // part of this assertion rather than an untested branch.
    expect(seen).toBe(6);
    expect(plaidAmounts.size).toBe(5);
  });

  it('signs a balance as a contribution to net worth, and leaves limits positive', async () => {
    // The port: `current` is "the account's contribution to net worth, so a card
    // you owe $420 on reports -42000n". Plaid reports that card as a positive
    // amount *owed*. `available` on a card is available *credit* — a magnitude —
    // and inverting it would produce a number that looks like money and means
    // nothing.
    const { connector, handle, options } = harness();
    const balances = await connector.syncBalances(handle, options);
    const byAccount = new Map(balances.map((b) => [b.providerAccountId, b]));

    expect(byAccount.get('acct-checking-001')?.current.minor).toBe(421_055n);
    expect(byAccount.get('acct-card-002')?.current.minor).toBe(-81_240n);
    expect(byAccount.get('acct-card-002')?.available?.minor).toBe(418_760n);
    expect(byAccount.get('acct-card-002')?.limit?.minor).toBe(500_000n);
    expect(byAccount.get('acct-mortgage-004')?.current.minor).toBe(-24_390_011n);
    expect(byAccount.get('acct-brokerage-003')?.current.minor).toBe(1_845_032n);
  });
});

// ---------------------------------------------------------------------------
// pending -> posted
// ---------------------------------------------------------------------------

describe('pending → posted is passed through, never inferred', () => {
  it('carries pendingTransactionId verbatim beside the removal of the pending row', async () => {
    // 01 §5.2, the highest-risk modelling detail in the integration: when a
    // pending transaction posts, Plaid puts the *old* id in `removed[]` and the
    // new row in `added[]` pointing back at it. Decision D10's "one transaction,
    // not two" depends entirely on this field surviving the boundary.
    const { connector, handle, options } = harness();
    const first = await connector.syncTransactions(handle, null, options);
    const second = await connector.syncTransactions(handle, first.nextCursor, options);

    const pending = first.added.find((f) => f.providerTransactionId === 'txn-0001-pending-coffee');
    expect(pending?.pending).toBe(true);
    expect(pending?.pendingTransactionId).toBeNull();

    expect(second.removed).toContainEqual({
      providerAccountId: 'acct-checking-001',
      providerTransactionId: 'txn-0001-pending-coffee',
    });

    const posted = second.added.find((f) => f.providerTransactionId === 'txn-0003-posted-coffee');
    expect(posted?.pending).toBe(false);
    expect(posted?.pendingTransactionId).toBe('txn-0001-pending-coffee');
    // The settled amount differs from the authorisation — $4.50 held, $4.87
    // charged — which is exactly why keeping one row rather than two matters.
    expect(posted?.amount.minor).toBe(-487n);
  });

  it('removed[] carries ids only, plus the account that routes the removal', async () => {
    const { connector, handle, options } = harness();
    const first = await connector.syncTransactions(handle, null, options);
    const second = await connector.syncTransactions(handle, first.nextCursor, options);

    for (const ref of second.removed) {
      // 01 §5.1: "removed[] contains IDs only, not objects".
      expect(Object.keys(ref).sort()).toEqual(['providerAccountId', 'providerTransactionId']);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-page sync
// ---------------------------------------------------------------------------

describe('multi-page /transactions/sync', () => {
  it('returns one page per call and lets the caller own the commit boundary', async () => {
    // The adapter must not accumulate: 01 §5.1's "retrieve all available updates
    // before persisting" is a rule about the *commit* boundary, which belongs to
    // the orchestrator (cursor contract rule 2).
    const { api, connector, handle, options } = harness();

    const one = await connector.syncTransactions(handle, null, options);
    expect(one.added).toHaveLength(2);
    expect(one.hasMore).toBe(true);
    expect(one.nextCursor).toBe('cursor-page-1');
    expect(api.countOf('transactions/sync')).toBe(1);

    const two = await connector.syncTransactions(handle, one.nextCursor, options);
    expect(two.added).toHaveLength(2);
    expect(two.removed).toHaveLength(1);
    expect(two.hasMore).toBe(true);

    const three = await connector.syncTransactions(handle, two.nextCursor, options);
    expect(three.added).toHaveLength(1);
    expect(three.modified).toHaveLength(1);
    expect(three.hasMore).toBe(false);
    expect(three.nextCursor).toBe('cursor-page-3');
    expect(api.countOf('transactions/sync')).toBe(3);
  });

  it('passes the cursor through verbatim, with no wrapping or encoding', async () => {
    // Cursor contract rule 1: it is opaque. The fastest way to break a resumable
    // sync is to invent a format a later version of the adapter cannot parse.
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, null, options);
    expect(page.nextCursor).toBe(SYNC_PAGES[0]?.next_cursor);
  });

  it('volunteers the full account list on every page, not just the first', async () => {
    // An institution can add an account mid-backfill, and a page naming an
    // account the connection has never mapped is a hard MALFORMED_RESPONSE in
    // the orchestrator.
    const { connector, handle, options } = harness();
    let cursor = null as Parameters<typeof connector.syncTransactions>[1];
    let pages = 0;
    for (;;) {
      const page = await connector.syncTransactions(handle, cursor, options);
      expect(page.accounts.map((a) => a.providerAccountId)).toEqual(
        ACCOUNTS.map((a) => a.account_id),
      );
      pages += 1;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The historical extract has not finished — found live, not in a fixture
// ---------------------------------------------------------------------------

describe('a page that arrives before the historical extract has finished', () => {
  // Live Sandbox smoke (WP 1.3 §7, 2026-09-14) found real Plaid behaviour no
  // fixture had recorded: a freshly-linked Item's /transactions/sync does not
  // throw PRODUCT_NOT_READY while the extract is running. It answers 200 with
  // an empty page (has_more: false) and transactions_update_status: 'NOT_READY',
  // then 'INITIAL_UPDATE_COMPLETE', before 'HISTORICAL_UPDATE_COMPLETE' once real
  // rows exist. Both not-finished statuses must classify exactly like the
  // PRODUCT_NOT_READY row every caller's retry loop already knows how to handle.

  function emptyPage(
    status: 'NOT_READY' | 'INITIAL_UPDATE_COMPLETE' | 'HISTORICAL_UPDATE_COMPLETE',
  ): TransactionsSyncResponse {
    return {
      accounts: [],
      added: [],
      modified: [],
      removed: [],
      next_cursor: '',
      has_more: false,
      transactions_update_status: status as never,
      request_id: `req-sync-${status.toLowerCase()}`,
    };
  }

  it.each(['NOT_READY', 'INITIAL_UPDATE_COMPLETE'] as const)(
    'classifies an empty, not-has_more page as PRODUCT_NOT_READY when the status is %s',
    async (status) => {
      const { connector, handle, options } = harness({ pages: [emptyPage(status)] });
      const failure = await connector
        .syncTransactions(handle, null, options)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: 'ConnectorError',
        kind: 'transient',
        providerCode: 'PRODUCT_NOT_READY',
      });
    },
  );

  it('returns normally for an empty page once the status is HISTORICAL_UPDATE_COMPLETE', async () => {
    // The steady state after backfill: a genuinely empty, finished account must
    // not retry forever just because its page is empty.
    const { connector, handle, options } = harness({
      pages: [emptyPage('HISTORICAL_UPDATE_COMPLETE')],
    });
    const page = await connector.syncTransactions(handle, null, options);
    expect(page.added).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });

  it('returns real rows without retrying even while the status is still INITIAL_UPDATE_COMPLETE', async () => {
    // A page with actual content is real data, not a not-ready signal — the
    // check only fires on an empty, non-has_more page.
    const withData: TransactionsSyncResponse = {
      ...SYNC_PAGES[0]!,
      transactions_update_status: 'INITIAL_UPDATE_COMPLETE' as never,
    };
    const { connector, handle, options } = harness({ pages: [withData] });
    const page = await connector.syncTransactions(handle, null, options);
    expect(page.added.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The two failures that are specific to the sync loop
// ---------------------------------------------------------------------------

describe('mutation during pagination', () => {
  it('fails page two with restart: page_one, then succeeds on the restart', async () => {
    // 01 §5.1: an institution posted something while we were paging, so "the
    // entire pagination request loop must be restarted beginning with the cursor
    // for the first page". Retrying the single failed call would splice two
    // inconsistent snapshots together.
    const { connector, handle, options } = harness({ mutateAtPage: 1 });

    const first = await connector.syncTransactions(handle, null, options);
    expect(first.nextCursor).toBe('cursor-page-1');

    const failure = await connector
      .syncTransactions(handle, first.nextCursor, options)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'ConnectorError',
      kind: 'transient',
      condition: 'MUTATION_DURING_PAGINATION',
      restart: 'page_one',
      providerCode: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    });

    // The fake raises it once, as the real condition does. Restarting the loop
    // from the run's first cursor gets all the way to the end.
    const restarted = await connector.syncTransactions(handle, null, options);
    const two = await connector.syncTransactions(handle, restarted.nextCursor, options);
    const three = await connector.syncTransactions(handle, two.nextCursor, options);
    expect(three.hasMore).toBe(false);
  });
});

describe('an Item that has stopped working', () => {
  it('stops the sync with AUTH_REQUIRED and asks the user to reconnect', async () => {
    const { connector, handle, options } = harness({
      failWith: { error: PLAID_ERRORS.ITEM_LOGIN_REQUIRED },
    });
    const thrown = await connector
      .syncTransactions(handle, null, options)
      .catch((error: unknown) => error);
    expect(thrown).toMatchObject({ kind: 'auth_required', condition: 'AUTH_REQUIRED' });
  });

  it('is still reachable through /item/get, which is what makes health useful', async () => {
    // An Item in ITEM_LOGIN_REQUIRED is reachable in the network sense and
    // useless in every other sense. `health` reports which, rather than throwing.
    const { connector, handle } = harness({
      failWith: { error: PLAID_ERRORS.ITEM_LOGIN_REQUIRED },
    });
    const health = await connector.health(handle);
    expect(health.reachable).toBe(false);
    expect(health.detail).toBe('ITEM_ERROR/ITEM_LOGIN_REQUIRED');
  });

  it('reports a healthy Item as reachable without touching the institution', async () => {
    // 08 §2.3: the probe "must not consume refresh budget". /item/get does not
    // reach the bank, so it costs nothing there and nothing in latency.
    const { api, connector, handle, clock } = harness();
    const health = await connector.health(handle);
    expect(health).toEqual({ reachable: true, checkedAt: clock.now(), detail: null });
    expect(api.countOf('item/get')).toBe(1);
    expect(api.countOf('accounts/balance/get')).toBe(0);
    expect(api.countOf('transactions/sync')).toBe(0);
  });

  it('reports rather than throws when the probe itself fails', async () => {
    const { connector, options } = harness();
    const unknownItem = handleFor('access-sandbox-NEVER-REAL-NO-SUCH-ITEM');
    const health = await connector.health(unknownItem);
    expect(health.reachable).toBe(false);
    expect(health.detail).toBe('INVALID_ACCESS_TOKEN');
    expect(options.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The hard budget
// ---------------------------------------------------------------------------

describe('the hard budget: raise, never truncate', () => {
  it('refuses to send a request once the run is aborted', async () => {
    // A truncated page looks exactly like a provider with no more data, and the
    // orchestrator would commit the cursor and move on — the one failure mode
    // that loses transactions permanently and without a trace.
    const { api, connector, handle, clock } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      connector.syncTransactions(handle, null, syncOptions(clock, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'ConnectorError', kind: 'transient' });
    expect(api.countOf('transactions/sync')).toBe(0);
  });

  it('refuses to send a request once the run is past its deadline', async () => {
    const { api, connector, handle, clock } = harness();
    await expect(
      connector.syncTransactions(
        handle,
        null,
        syncOptions(clock, { deadline: new Date(clock.nowMs() - 1) }),
      ),
    ).rejects.toMatchObject({ name: 'ConnectorError', kind: 'transient' });
    expect(api.countOf('transactions/sync')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('exchanges the public token, hands the access token back once, and keeps none of it', async () => {
    const { api, connector } = harness();
    const result = await connector.connect({ publicToken: PUBLIC_TOKEN });

    expect(result.providerConnectionId).toBe(ITEM.item_id);
    expect(result.credentials).toEqual({ [PLAID_ACCESS_TOKEN]: ACCESS_TOKEN });
    expect(result.accounts).toHaveLength(ACCOUNTS.length);
    expect(result.consentExpiresAt).toBeNull();
    expect(api.countOf('item/public_token/exchange')).toBe(1);

    // Nothing retained: a second, tokenless handle must fail rather than reuse
    // something the connector squirrelled away during linking.
    await expect(
      connector.syncTransactions({ ...handleFor(), secret: () => null }, null, harness().options),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('prefers the name Link reported, then the Item, then the manifest', async () => {
    const { connector } = harness();
    const fromLink = await connector.connect({
      publicToken: PUBLIC_TOKEN,
      institutionName: 'Northwind Mutual',
    });
    expect(fromLink.displayName).toBe('Northwind Mutual');

    const fromItem = await connector.connect({ publicToken: PUBLIC_TOKEN });
    expect(fromItem.displayName).toBe(ITEM.institution_name);
  });

  it('narrows the declared capabilities to what this Item actually has', async () => {
    // ConnectResult.observedCapabilities "narrows, never widens, the declared
    // set": a Plaid product we have not built support for cannot appear.
    const { connector } = harness();
    const result = await connector.connect({ publicToken: PUBLIC_TOKEN });
    const declared = new Set(plaidCapabilities().supports);

    expect(result.observedCapabilities).not.toBeNull();
    for (const capability of result.observedCapabilities ?? []) {
      expect(declared.has(capability)).toBe(true);
    }
    expect([...(result.observedCapabilities ?? [])].sort()).toEqual([...declared].sort());
  });

  it('drops investment and liability capabilities for a transactions-only Item', async () => {
    const transactionsOnly = harness({
      items: [
        {
          accessToken: 'access-sandbox-NEVER-REAL-TXN-ONLY-0011',
          publicToken: 'public-sandbox-NEVER-REAL-TXN-ONLY-0011',
          item: transactionsOnlyItem(),
          accounts: ACCOUNTS,
          pages: SYNC_PAGES,
        },
      ],
    });
    const result = await transactionsOnly.connector.connect({
      publicToken: 'public-sandbox-NEVER-REAL-TXN-ONLY-0011',
    });
    expect([...(result.observedCapabilities ?? [])].sort()).toEqual([
      'accounts',
      'balances',
      'historical_backfill',
      'incremental_sync',
      'transactions',
    ]);
  });

  it('rejects a malformed link payload as invalid_input without echoing it', async () => {
    // A malformed Link payload can still contain a real public token, so the
    // message must not repeat the input.
    const { connector } = harness();
    const thrown = await connector
      .connect({ publicToken: '', leaked: PUBLIC_TOKEN })
      .catch((error: unknown) => error);
    expect(thrown).toMatchObject({ kind: 'invalid_input', condition: 'CONFIG_ERROR' });
    expect(String(thrown)).not.toContain(PUBLIC_TOKEN);
    expect(JSON.stringify((thrown as { redactedContext: unknown }).redactedContext)).not.toContain(
      PUBLIC_TOKEN,
    );
  });

  it('classifies a spent or expired public token as our mistake, not a retry', async () => {
    // 01 §1.5: the public token is single-use and expires in 30 minutes. The fix
    // is for the user to re-run Link, not for us to try again.
    const { connector } = harness();
    await expect(
      connector.connect({ publicToken: 'public-sandbox-NEVER-REAL-NOT-ISSUED' }),
    ).rejects.toMatchObject({ kind: 'invalid_input', providerCode: 'INVALID_PUBLIC_TOKEN' });
  });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('calls /item/remove exactly once', async () => {
    // On Production every call is one of ten Trial Items, permanently: D16 —
    // "the 10-Item cap is a ratchet (/item/remove does not free slots)". An
    // adapter that retried this internally would burn the cap.
    const { api, connector, handle } = harness();
    await connector.disconnect(handle);
    expect(api.countOf('item/remove')).toBe(1);
    expect(api.requestsTo('item/remove')).toEqual([{ access_token: ACCESS_TOKEN }]);
  });

  it('documents that /item/remove does not free a Trial slot', () => {
    // Not a style check. This warning is the difference between "we removed a
    // connection" and "we permanently spent one of ten Production slots", and it
    // exists nowhere the type system can see it.
    const source = readFileSync(join(SRC, 'connector.ts'), 'utf8');
    expect(source).toMatch(/does not free/i);
    expect(source).toMatch(/Trial/);
  });

  it('is idempotent for an Item that is already gone, and says so in the log', async () => {
    // "Already revoked" is the outcome the caller asked for. `@ctx/connections`
    // can then record `revokedAtProvider: true` honestly.
    const { api, connector, handle, logger } = harness();
    await connector.disconnect(handle);
    await expect(connector.disconnect(handle)).resolves.toBeUndefined();
    expect(api.countOf('item/remove')).toBe(2);
    expect(logger.lines.map((line) => line.message)).toContain('plaid item was already removed');
  });

  it('raises anything that is not "already gone", so we cannot claim a revocation we did not get', async () => {
    // Only ITEM_NOT_FOUND and INVALID_ACCESS_TOKEN mean "already revoked".
    // Everything else has to reach `disconnectConnection` in @ctx/connections so
    // it can record `revokedAtProvider: false` instead of telling the user we
    // revoked something we did not.
    const { api, connector, handle } = harness({
      failRemoveWith: { error: PLAID_ERRORS.PLAID_INTERNAL, status: 500 },
    });
    await expect(connector.disconnect(handle)).rejects.toMatchObject({
      condition: 'PROVIDER_DOWN',
      providerCode: 'INTERNAL_SERVER_ERROR',
    });
    expect(api.countOf('item/remove')).toBe(1);
  });

  it('succeeds while the institution is down, because /item/remove never touches the bank', async () => {
    const { connector, handle } = harness({ failWith: { error: PLAID_ERRORS.INSTITUTION_DOWN } });
    await expect(connector.disconnect(handle)).resolves.toBeUndefined();
  });

  it('makes revocation observable: a removed Item refuses to sync', async () => {
    const { connector, handle, options } = harness();
    await connector.disconnect(handle);
    await expect(connector.syncTransactions(handle, null, options)).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'ITEM_NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// The datasets that are not transactions
// ---------------------------------------------------------------------------

describe('the other datasets', () => {
  it('lists accounts', async () => {
    const { connector, handle } = harness();
    const accounts = await connector.listAccounts(handle);
    expect(accounts.map((a) => a.providerAccountId)).toEqual(ACCOUNTS.map((a) => a.account_id));
  });

  it('pages /investments/transactions/get on offset, because it caps at 500', async () => {
    // 01 §5.5: there is no /investments/transactions/sync, so these arrive by
    // date window with offset paging. Silently truncating a brokerage's history
    // is the failure this whole package exists to avoid.
    const first = INVESTMENTS.investment_transactions[0];
    expect(first).toBeDefined();
    const many: InvestmentTransaction[] = Array.from({ length: 501 }, (_unused, index) => ({
      ...(first as InvestmentTransaction),
      investment_transaction_id: `ivt-bulk-${String(index).padStart(4, '0')}`,
    }));

    const { api, connector, handle, options } = harness({ investmentTransactions: many });
    const facts = await connector.syncInvestmentTransactions(handle, options);

    expect(facts).toHaveLength(501);
    expect(new Set(facts.map((f) => f.providerTransactionId)).size).toBe(501);
    const requests = api.requestsTo('investments/transactions/get') as {
      options?: { offset?: number; count?: number };
    }[];
    expect(requests).toHaveLength(2);
    expect(requests[0]?.options).toEqual({ count: 500, offset: 0 });
    expect(requests[1]?.options).toEqual({ count: 500, offset: 500 });
  });

  it('syncs holdings and liabilities', async () => {
    const { connector, handle, options } = harness();
    const holdings = await connector.syncHoldings(handle, options);
    expect(holdings.map((h) => h.security.providerSecurityId)).toEqual([
      'sec-vti-0001',
      'sec-cash-0002',
      'sec-btc-0003',
    ]);

    const liabilities = await connector.syncLiabilities(handle, options);
    expect(liabilities.map((l) => l.providerAccountId).sort()).toEqual([
      'acct-card-002',
      'acct-mortgage-004',
      'acct-student-005',
    ]);
  });

  it('raises INSUFFICIENT_SCOPE when the Item was never linked for the product', async () => {
    // Not an empty array. An empty holdings list is indistinguishable from "this
    // brokerage holds nothing", which is how an account drops out of net worth
    // for three weeks without anyone noticing.
    const { connector, handle, options } = harness({
      withoutHoldings: true,
      withoutLiabilities: true,
    });
    await expect(connector.syncHoldings(handle, options)).rejects.toMatchObject({
      condition: 'INSUFFICIENT_SCOPE',
      kind: 'permanent',
    });
    await expect(connector.syncLiabilities(handle, options)).rejects.toMatchObject({
      condition: 'INSUFFICIENT_SCOPE',
    });
  });

  it('treats /accounts/balance/get as the expensive call it is and does not call it on sync', async () => {
    // 01 §1.8: 5/min and 30/hr per Item, by far the tightest limit we touch, and
    // it forces a real-time extraction at the institution (p95 ~11 s).
    const { api, connector, handle, options } = harness();
    await connector.syncTransactions(handle, null, options);
    expect(api.countOf('accounts/balance/get')).toBe(0);

    await connector.syncBalances(handle, options);
    expect(api.countOf('accounts/balance/get')).toBe(1);
  });
});
