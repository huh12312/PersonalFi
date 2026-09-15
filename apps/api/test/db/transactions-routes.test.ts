// SPDX-License-Identifier: MIT
/**
 * `/transactions`, `/transfers` and the CSV export, over a real database.
 *
 * The dataset is staged into a `ManualConnector` and applied by the real
 * `SyncOrchestrator`, so every row under test came through
 * `applyProviderTransactions` exactly as a bank's would. Nothing here inserts
 * into `transactions` directly.
 *
 * The claims, in the order they appear:
 *
 * 1. **Keyset pagination is stable under concurrent writes.** A full walk visits
 *    every row exactly once even when a sync inserts a transaction *into the
 *    middle* of the ordering between two pages. This is the property offset
 *    pagination does not have, and it is the reason 04 §6.3 calls offset not
 *    slow but wrong.
 * 2. **The summary is first-page-only** and is computed over the filter, not
 *    the page.
 * 3. **Filters compose** and each one narrows what it claims to narrow.
 * 4. **The overlay outlives a provider restatement.** The single most important
 *    promise the ledger makes to a user: they categorise a row once.
 * 5. **A bulk patch is one transaction.** A bad id fails the whole batch rather
 *    than leaving half of it applied.
 * 6. **Splits must sum to the cent**, in the parent's currency.
 * 7. **Transfer pair and reject** round-trip.
 * 8. **The export needs a step-up** and is RFC 4180.
 * 9. **Problem shapes** are RFC 9457 and carry the domain's own `code`.
 */
import { DateOnly, money } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
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

const CHECKING = 'checking';
const CARD = 'card';
/** Opaque to the ledger — `transactions.user_category_id` has no foreign key. */
const CATEGORY_A = '01920000-0000-7000-8000-00000000ca01';
const CATEGORY_B = '01920000-0000-7000-8000-00000000ca02';

/** 24 ordinary outflows, one per day. `-100 * (i + 1)` minor, so each is distinct. */
function ordinaryBatch(): ReturnType<typeof manualTransaction>[] {
  return Array.from({ length: 24 }, (_unused, index) =>
    manualTransaction({
      providerAccountId: CHECKING,
      providerTransactionId: `txn-${String(index).padStart(4, '0')}`,
      amount: money(BigInt(-100 * (index + 1)), 'USD'),
      postedDate: DateOnly.addDays(DateOnly.parse('2026-05-01'), index),
      name: `MERCHANT ${String(index)}`,
      merchantName: `Merchant ${String(index)}`,
    }),
  );
}

interface Listed {
  readonly items: { id: string; date: string; amount: { minor: string }; name: string }[];
  readonly nextCursor: string | null;
  readonly summary: { count: number; totals: { minor: string; currency: string }[] } | null;
}

describe.skipIf(NO_DATABASE)('transaction routes', () => {
  let h: ApiHarness;
  let link: LinkedConnection;
  /** provider transaction id → ledger transaction id, for the tests that pick rows. */
  const ids = new Map<string, string>();

  async function list(query: string, session = h.stale): Promise<Listed> {
    const response = await h.request({ method: 'GET', url: `/transactions?${query}`, session });
    expectStatus(response, 200);
    return response.json() as Listed;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'txn' });

    link = await linkManual(h, {
      providerConnectionId: 'txn-conn',
      displayName: 'Everyday Bank',
      accounts: [
        {
          providerAccountId: CHECKING,
          name: 'Everyday Checking',
          type: 'depository',
          currency: 'USD',
        },
        { providerAccountId: CARD, name: 'Rewards Card', type: 'credit', currency: 'USD' },
      ],
      batch: {
        added: [
          ...ordinaryBatch(),
          // A pending row, so `?pending=` has something to select.
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'txn-pending',
            amount: money(-550n, 'USD'),
            postedDate: DateOnly.parse('2026-05-25'),
            name: 'PENDING COFFEE',
            pending: true,
          }),
          // A name that is a CSV minefield: a comma and an embedded quote.
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'txn-csv',
            amount: money(-1234n, 'USD'),
            postedDate: DateOnly.parse('2026-05-26'),
            name: 'ACME, "THE" STORE',
          }),
          // An inflow, so an amount filter can distinguish a sign.
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'txn-salary',
            amount: money(250_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-27'),
            name: 'ACME PAYROLL',
          }),
          // The two legs of one movement of money, for pair/reject.
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'txn-xfer-out',
            amount: money(-50_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-10'),
            name: 'TRANSFER TO CARD',
          }),
          manualTransaction({
            providerAccountId: CARD,
            providerTransactionId: 'txn-xfer-in',
            amount: money(50_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-11'),
            name: 'PAYMENT RECEIVED',
          }),
        ],
      },
    });

    // Map provider ids to ledger ids once, so the tests below can name a row
    // without re-deriving it from a list response every time.
    const page = await list('limit=200');
    for (const item of page.items) {
      const detail = await h.request({
        method: 'GET',
        url: `/transactions/${item.id}`,
        session: h.stale,
      });
      const body = detail.json() as { provenance: { providerTransactionId: string } };
      ids.set(body.provenance.providerTransactionId, item.id);
    }
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  // ------------------------------------------------------------- pagination

  it('walks every row exactly once, newest first', async () => {
    const seen: string[] = [];
    const dates: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Listed = await list(
        `limit=10${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      pages += 1;
      for (const item of page.items) {
        seen.push(item.id);
        dates.push(item.date);
      }
      // `summary` is the first page's alone: it is an aggregate over the whole
      // filter and the slow half of the query.
      expect(page.summary === null).toBe(cursor !== null);
      cursor = page.nextCursor;
    } while (cursor !== null && pages < 20);

    // 24 ordinary + pending + csv + salary + the two transfer legs.
    expect(seen).toHaveLength(29);
    expect(new Set(seen).size).toBe(29);
    expect(pages).toBe(3);
    // Descending by effective date. The tiebreaker is the id, which is why two
    // rows may share a date without the walk becoming unstable.
    expect([...dates]).toEqual([...dates].sort().reverse());
  });

  it('does not repeat or skip a row when a sync inserts into the middle of the walk', async () => {
    // The whole reason the cursor is keyset. With an offset, inserting a row
    // dated between page one and page two shifts every later row down by one
    // and the walk returns one of them twice.
    const firstPage = await list('limit=10');
    expect(firstPage.nextCursor).not.toBeNull();

    h.manualStore.append(link.providerConnectionId, {
      added: [
        manualTransaction({
          providerAccountId: CHECKING,
          providerTransactionId: 'txn-interloper',
          amount: money(-777n, 'USD'),
          // Dated squarely inside the range page two will cover.
          postedDate: DateOnly.parse('2026-05-12'),
          name: 'INTERLOPER',
        }),
      ],
    });
    await syncConnection(h, link.connectionId);

    const seen = firstPage.items.map((item) => item.id);
    let cursor = firstPage.nextCursor;
    let pages = 1;
    while (cursor !== null && pages < 20) {
      const page: Listed = await list(`limit=10&cursor=${encodeURIComponent(cursor)}`);
      pages += 1;
      for (const item of page.items) seen.push(item.id);
      cursor = page.nextCursor;
    }

    // No duplicate anywhere in the walk, which is the invariant. The interloper
    // itself may or may not appear — it sorts below the first page's cursor, so
    // it does — but nothing already returned is returned again.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(ids.get('txn-csv'));
    // 29 before, plus the row the sync inserted mid-walk.
    expect(seen).toHaveLength(30);
  });

  it('summarises the filter rather than the page', async () => {
    const page = await list('limit=5');
    expect(page.items).toHaveLength(5);
    expect(page.summary?.count).toBe(30);
    const usd = page.summary?.totals.find((total) => total.currency === 'USD');
    expect(usd).toBeDefined();
    // A total over 30 rows, returned on a page of 5: the point of the assertion.
    expect(BigInt(usd?.minor ?? '0')).not.toBe(0n);
  });

  it('rejects a cursor it did not mint', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/transactions?cursor=not-a-cursor',
      session: h.stale,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemOf(response)['code']).toBe('ledger.cursor_invalid');
  });

  // ---------------------------------------------------------------- filters

  it('filters by account, date, amount, text and pending state', async () => {
    // Names on the wire are the ledger's *resolved* display name, which is the
    // normalised merchant string and not the provider's raw descriptor:
    // `PAYMENT RECEIVED` is stored as the fact and read back as `Payment
    // Received`. Asserting the raw form here would be asserting that
    // normalisation had stopped working.
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountList = (accounts.json() as { accounts: { id: string; name: string }[] }).accounts;
    const card = accountList.find((account) => account.name === 'Rewards Card');
    expect(card).toBeDefined();

    const byAccount = await list(`accountIds=${card?.id ?? ''}&limit=200`);
    expect(byAccount.items).toHaveLength(1);
    expect(byAccount.items[0]?.name).toBe('Payment Received');

    const byDate = await list('from=2026-05-01&to=2026-05-03&limit=200');
    expect(byDate.items.map((item) => item.date).sort()).toEqual([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
    ]);

    // Minor units, as a string, because an IEEE-754 number cannot hold a cent.
    // Both inflows are above 1; 100_000 selects the salary alone.
    const everyInflow = await list('amountMin=1&limit=200');
    expect(everyInflow.items).toHaveLength(2);
    const byAmount = await list('amountMin=100000&limit=200');
    expect(byAmount.items).toHaveLength(1);
    expect(byAmount.items[0]?.name).toBe('Acme Payroll');

    const byText = await list('q=PAYROLL&limit=200');
    expect(byText.items).toHaveLength(1);
    expect(byText.items[0]?.name).toBe('Acme Payroll');

    const pending = await list('pending=true&limit=200');
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.name).toBe('Pending Coffee');

    const notPending = await list('pending=false&limit=200');
    expect(notPending.items).toHaveLength(29);
  });

  it('accepts a repeated id parameter in either spelling', async () => {
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    const accountList = (accounts.json() as { accounts: { id: string }[] }).accounts;
    const both = accountList.map((account) => account.id);

    const repeated = await list(`${both.map((id) => `accountIds=${id}`).join('&')}&limit=200`);
    const commaJoined = await list(`accountIds=${both.join(',')}&limit=200`);
    expect(repeated.items).toHaveLength(30);
    expect(commaJoined.items).toHaveLength(30);
  });

  // ---------------------------------------------------------------- overlay

  it('keeps the user overlay when the provider restates the row', async () => {
    const transactionId = ids.get('txn-0005');
    expect(transactionId).toBeDefined();

    const patched = await h.request({
      method: 'PATCH',
      url: `/transactions/${transactionId ?? ''}`,
      session: h.stale,
      body: {
        note: 'reimbursable — filed 2026-06-02',
        excluded: true,
        categoryId: CATEGORY_A,
        payeeName: 'The Corner Shop',
      },
    });
    expectStatus(patched, 200);
    const afterPatch = patched.json() as Record<string, unknown>;
    expect(afterPatch['name']).toBe('The Corner Shop');
    expect(afterPatch['excluded']).toBe(true);
    expect(afterPatch['categoryId']).toBe(CATEGORY_A);

    // The provider restates the same natural key with a different name and a
    // different amount — a correction, which is an ordinary thing for a bank.
    h.manualStore.append(link.providerConnectionId, {
      modified: [
        manualTransaction({
          providerAccountId: CHECKING,
          providerTransactionId: 'txn-0005',
          amount: money(-999n, 'USD'),
          postedDate: DateOnly.addDays(DateOnly.parse('2026-05-01'), 5),
          name: 'SQ *CORNER SHOP 4471',
          merchantName: 'Corner Shop',
        }),
      ],
    });
    await syncConnection(h, link.connectionId);

    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId ?? ''}`,
      session: h.stale,
    });
    expectStatus(detail, 200);
    const body = detail.json() as {
      name: string;
      note: string | null;
      excluded: boolean;
      categoryId: string | null;
      amount: { minor: string };
      provenance: { providerName: string; providerAmount: { minor: string }; revision: number };
    };

    // Every user-owned field survived.
    expect(body.name).toBe('The Corner Shop');
    expect(body.note).toBe('reimbursable — filed 2026-06-02');
    expect(body.excluded).toBe(true);
    expect(body.categoryId).toBe(CATEGORY_A);
    // And the provider's correction landed underneath it, visible in provenance.
    expect(body.provenance.providerName).toBe('SQ *CORNER SHOP 4471');
    expect(body.provenance.providerAmount.minor).toBe('-999');
    expect(body.provenance.revision).toBeGreaterThan(1);
    // The amount has no user override, so the correction shows through.
    expect(body.amount.minor).toBe('-999');
  });

  it('restores the provider’s own payee when the override is set back to null', async () => {
    // `null` is "forget my override", not "set my override to nothing". What
    // shows through is the resolved provider value — the normalised merchant
    // name (`Corner Shop`), not the raw descriptor, which stays in provenance.
    const transactionId = ids.get('txn-0005') ?? '';
    const response = await h.request({
      method: 'PATCH',
      url: `/transactions/${transactionId}`,
      session: h.stale,
      body: { payeeName: null },
    });
    expectStatus(response, 200);
    expect((response.json() as { name: string }).name).toBe('Corner Shop');

    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: h.stale,
    });
    const body = detail.json() as { provenance: { providerName: string } };
    expect(body.provenance.providerName).toBe('SQ *CORNER SHOP 4471');
  });

  // ------------------------------------------------------------------- bulk

  it('applies one patch to many rows in a single transaction', async () => {
    const targets = ['txn-0010', 'txn-0011', 'txn-0012'].map((key) => ids.get(key) ?? '');
    const response = await h.request({
      method: 'POST',
      url: '/transactions/bulk',
      session: h.stale,
      body: { transactionIds: targets, patch: { categoryId: CATEGORY_B } },
    });
    expectStatus(response, 200);
    const body = response.json() as { updated: number; items: { categoryId: string }[] };
    expect(body.updated).toBe(3);
    expect(body.items.every((item) => item.categoryId === CATEGORY_B)).toBe(true);
  });

  it('fails a bulk patch whole when one id does not exist, leaving nothing applied', async () => {
    const good = ids.get('txn-0013') ?? '';
    const missing = '01920000-0000-7000-8000-0000000fffff';

    const response = await h.request({
      method: 'POST',
      url: '/transactions/bulk',
      session: h.stale,
      body: {
        transactionIds: [good, missing],
        patch: { note: 'this note must not survive' },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('ledger.transaction_not_found');

    // The rollback is the claim: the good id was patched first and must have
    // been undone when the second one threw.
    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${good}`,
      session: h.stale,
    });
    expect((detail.json() as { note: string | null }).note).toBeNull();
  });

  // ----------------------------------------------------------------- splits

  it('refuses a split set that does not sum to the transaction', async () => {
    const transactionId = ids.get('txn-0020') ?? '';
    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: h.stale,
    });
    const amount = (detail.json() as { amount: { minor: string } }).amount.minor;

    const response = await h.request({
      method: 'POST',
      url: `/transactions/${transactionId}/splits`,
      session: h.stale,
      body: {
        splits: [
          { amount: { minor: '-100', currency: 'USD' }, userCategoryId: CATEGORY_A },
          { amount: { minor: '-100', currency: 'USD' }, userCategoryId: CATEGORY_B },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    const problem = problemOf(response);
    expect(problem['code']).toBe('ledger.splits_do_not_sum');
    expect(problem['detail']).toContain(amount);
  });

  it('refuses a split in a currency the transaction is not in', async () => {
    const transactionId = ids.get('txn-0020') ?? '';
    const response = await h.request({
      method: 'POST',
      url: `/transactions/${transactionId}/splits`,
      session: h.stale,
      body: {
        splits: [
          { amount: { minor: '-1000', currency: 'EUR' }, userCategoryId: CATEGORY_A },
          { amount: { minor: '-1100', currency: 'EUR' }, userCategoryId: CATEGORY_B },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(problemOf(response)['code']).toBe('ledger.currency_mismatch');
  });

  it('writes a split set that sums exactly, and clears it again', async () => {
    const transactionId = ids.get('txn-0020') ?? '';
    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: h.stale,
    });
    const total = BigInt((detail.json() as { amount: { minor: string } }).amount.minor);
    const first = total / 2n;
    const second = total - first;

    const written = await h.request({
      method: 'POST',
      url: `/transactions/${transactionId}/splits`,
      session: h.stale,
      body: {
        splits: [
          { amount: { minor: first.toString(), currency: 'USD' }, userCategoryId: CATEGORY_A },
          { amount: { minor: second.toString(), currency: 'USD' }, userCategoryId: CATEGORY_B },
        ],
      },
    });
    expectStatus(written, 200);
    const splits = (written.json() as { splits: { position: number; amount: { minor: string } }[] })
      .splits;
    expect(splits).toHaveLength(2);
    expect(splits.map((split) => split.position)).toEqual([0, 1]);
    expect(splits.reduce((sum, split) => sum + BigInt(split.amount.minor), 0n)).toBe(total);

    // And they are on the detail payload, which is what the drawer renders.
    const reread = await h.request({
      method: 'GET',
      url: `/transactions/${transactionId}`,
      session: h.stale,
    });
    expect((reread.json() as { splits: unknown[] }).splits).toHaveLength(2);

    const cleared = await h.request({
      method: 'DELETE',
      url: `/transactions/${transactionId}/splits`,
      session: h.stale,
    });
    expectStatus(cleared, 200);
    expect((cleared.json() as { removed: number }).removed).toBe(2);
  });

  it('refuses a split set of fewer than two lines at the schema', async () => {
    const transactionId = ids.get('txn-0020') ?? '';
    const response = await h.request({
      method: 'POST',
      url: `/transactions/${transactionId}/splits`,
      session: h.stale,
      body: { splits: [{ amount: { minor: '-2100', currency: 'USD' } }] },
    });
    expect(response.statusCode).toBe(400);
  });

  // -------------------------------------------------------------- transfers

  it('pairs two legs and then rejects the pairing', async () => {
    const out = ids.get('txn-xfer-out') ?? '';
    const inflow = ids.get('txn-xfer-in') ?? '';

    const paired = await h.request({
      method: 'POST',
      url: '/transfers/pair',
      session: h.stale,
      body: { outflowTransactionId: out, inflowTransactionId: inflow },
    });
    expectStatus(paired, 200);
    const linkId = (paired.json() as { transferLinkId: string }).transferLinkId;
    expect(linkId).toEqual(expect.any(String));

    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${out}`,
      session: h.stale,
    });
    const body = detail.json() as {
      isTransfer: boolean;
      transfer: { otherTransactionId: string; direction: string; confidence: number } | null;
    };
    expect(body.isTransfer).toBe(true);
    expect(body.transfer?.otherTransactionId).toBe(inflow);
    expect(body.transfer?.direction).toBe('outflow');
    // Confirmed by a person, not guessed by a heuristic.
    expect(body.transfer?.confidence).toBe(1);

    // `transfers=only` and `exclude` are complementary over the same filter.
    const only = await list('transfers=only&limit=200');
    const excluded = await list('transfers=exclude&limit=200');
    expect(only.items).toHaveLength(2);
    expect(only.items.map((item) => item.id).sort()).toEqual([out, inflow].sort());
    expect(excluded.items).toHaveLength(28);

    // Either leg may be named; the other is read from the link.
    const rejected = await h.request({
      method: 'POST',
      url: `/transfers/${inflow}/reject`,
      session: h.stale,
      body: { reason: 'these are different accounts at different banks' },
    });
    expectStatus(rejected, 200);
    expect((rejected.json() as { unlinked: boolean }).unlinked).toBe(true);

    const after = await h.request({ method: 'GET', url: `/transactions/${out}`, session: h.stale });
    expect((after.json() as { transfer: unknown }).transfer).toBeNull();
  });

  it('refuses to reject a pairing that never existed without naming the other leg', async () => {
    const lonely = ids.get('txn-0002') ?? '';
    const response = await h.request({
      method: 'POST',
      url: `/transfers/${lonely}/reject`,
      session: h.stale,
      body: {},
    });
    expect(response.statusCode).toBe(409);
    expect(problemOf(response)['code']).toBe('ledger.transfer_not_linked');
  });

  // ----------------------------------------------------------------- export

  it('refuses the CSV export to a session without a step-up assertion', async () => {
    // The class of attack: a stolen session cookie must not be enough to walk
    // out with the complete transaction history (decision D21).
    const response = await h.request({
      method: 'GET',
      url: '/transactions/export.csv',
      session: h.stale,
    });
    expect(response.statusCode).toBe(403);
    const problem = problemOf(response);
    expect(problem['code']).toBe('step_up_required');
    expect(problem['detail']).toContain('/auth/step-up/options');
    expect(response.body).not.toContain('MERCHANT');
  });

  it('exports RFC 4180 CSV to a stepped-up session', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/transactions/export.csv',
      session: h.fresh,
    });
    expectStatus(response, 200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('transactions.csv');

    const lines = response.body.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'date,name,amount_minor,currency,account_id,category_id,pending,excluded,transfer,note',
    );
    expect(lines).toHaveLength(31); // header + 30 rows

    // The minefield row: a comma inside the field and an embedded quote doubled.
    const tricky = lines.find((line) => line.includes('THE'));
    expect(tricky).toContain('"Acme, ""THE"" Store"');
  });

  it('honours the same filters on the export as on the list', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/transactions/export.csv?from=2026-05-01&to=2026-05-03',
      session: h.fresh,
    });
    expectStatus(response, 200);
    expect(response.body.trimEnd().split('\n')).toHaveLength(4); // header + 3
  });

  // --------------------------------------------------------- problem shapes

  it('answers 401 with a problem document when no session is presented', async () => {
    const response = await h.request({ method: 'GET', url: '/transactions' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = problemOf(response);
    expect(problem['code']).toBe('not_authenticated');
    expect(problem['status']).toBe(401);
    expect(problem['type']).toBe('https://personalfi.local/problems/not_authenticated');
    expect(problem['correlationId']).toEqual(expect.any(String));
  });

  it('answers 404 with the ledger’s own code for a transaction that is not there', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/transactions/01920000-0000-7000-8000-0000000fffff',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('ledger.transaction_not_found');
  });

  it('rejects a mutation whose CSRF header does not echo the cookie', async () => {
    // The gate is mounted at the root of the application, so it applies to a
    // transaction patch exactly as it does to a logout.
    const response = await h.request({
      method: 'PATCH',
      url: `/transactions/${ids.get('txn-0003') ?? ''}`,
      session: h.stale,
      body: { note: 'written by another origin' },
      omitCsrfHeader: true,
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('csrf_failed');
  });

  it('rejects a body that does not match the schema before it reaches the ledger', async () => {
    const response = await h.request({
      method: 'PATCH',
      url: `/transactions/${ids.get('txn-0003') ?? ''}`,
      session: h.stale,
      body: { excluded: 'yes please' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});
