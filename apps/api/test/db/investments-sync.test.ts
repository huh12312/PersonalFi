// SPDX-License-Identifier: MIT
/**
 * The `holdings`, `investment_txns` and `liabilities` legs, end to end — WP 3.7.
 *
 * Real `SyncOrchestrator`, real `PlaidConnector`, real `map.ts`, real
 * `connection_sync_facts`, real `@ctx/ledger` writer. The only double is the
 * network: `FakePlaidApi` is the same hermetic fake `packages/connectors/plaid`
 * proves itself against (conformance, request pins, error map, log hygiene) and
 * the one the live Sandbox smoke is recorded from, so the fixtures here are
 * Sandbox shapes rather than shapes somebody invented one layer up.
 *
 * The four claims, in the order the dispatch states them:
 *
 * 1. **A leg's failure never relabels or rolls back the transactions delta.**
 *    Each leg writes its own `sync_runs` row with its own `operation`, so "why
 *    is my balance stale", "why is my holding missing" and "why is my last
 *    transaction missing" are three different rows instead of one row lying
 *    about which half failed.
 * 2. **Two syncs of the same window add no investment transactions.** 01 §5.5:
 *    there is no `/investments/transactions/sync`, so the nightly run re-fetches
 *    the whole 24-month window and the *only* protection is the upsert on
 *    `investment_transaction_id`.
 * 3. **A connector without the capability is skipped, not errored.** 08 §2.2:
 *    the orchestrator "skips what isn't advertised rather than catching
 *    `NotImplemented`" — no row, no error, no event.
 * 4. **`institution_value` is reconciliation only.** Valuation comes from our
 *    own `PriceSource`, so two brokerages are comparable; the institution's
 *    figure is kept so a difference can be *explained* rather than discovered.
 *
 * `insufficient-scope.test.ts` carries the fifth.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  ACCESS_TOKEN,
  FakePlaidApi,
  INVESTMENTS,
  PUBLIC_TOKEN,
  defaultItemSpec,
  linkSettings,
  testClock,
} from '@connector/plaid/test';
import { ConnectorError, type Connector } from '@ctx/connections';
import { liabilityTermsFor } from '@ctx/connections';
import { createFakePriceSource } from '@ctx/integrations';
import { Money, Quantity, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

/** One `sync_runs` row, as the history view renders it. */
interface RunRow {
  readonly [column: string]: unknown;
  readonly operation: string;
  readonly status: string;
  readonly error_kind: string | null;
  readonly error_code: string | null;
  readonly added_count: number;
  readonly modified_count: number;
}

/**
 * Wrap a connector so one method can be broken and repaired mid-suite.
 *
 * A forwarding `Proxy` with every method bound back to the real instance, not
 * a spread onto a fresh object: `PlaidConnector` keeps its api client in a
 * `#private` field and a copy inherits the methods without the state, which
 * fails with "cannot read private member" — a failure about the double rather
 * than about the orchestrator. Same reasoning, and same shape, as
 * `connectorWith` in `@ctx/connections`' own test harness.
 */
function breakable(honest: PlaidConnector, failures: Map<string, unknown>): Connector {
  return new Proxy(honest, {
    get(target, property, _receiver) {
      const name = String(property);
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: never[]) => unknown).bind(target);
      return (...args: never[]) => {
        const failure = failures.get(name);
        if (failure !== undefined) throw failure;
        return bound(...args);
      };
    },
  }) as unknown as Connector;
}

/** `quantity × price`, truncated once into minor units. No float, one rounding. */
function valueOf(quantity: string, price: string, currency: string, scale = 2): bigint {
  const shifted = Quantity.multiply(
    Quantity.multiply(Quantity.of(quantity), Quantity.of(price)),
    '1' + '0'.repeat(scale),
  );
  const [whole = '0'] = Quantity.toDatabaseString(shifted).split('.');
  return Money.of(BigInt(whole), currency).minor;
}

describe.skipIf(NO_DATABASE)('plaid investments and liabilities legs (wp3.7)', () => {
  let h: ApiHarness;
  let api: FakePlaidApi;
  let connectionId: string;
  /** Method name → the error it should throw. Cleared between tests. */
  const failures = new Map<string, unknown>();

  async function runsFor(id: string): Promise<RunRow[]> {
    const result = await h.database.db.execute<RunRow>(sql`
      SELECT operation, status, error_kind, error_code, added_count, modified_count
        FROM sync_runs
       WHERE connection_id = ${id}::uuid
       ORDER BY started_at, operation
    `);
    return [...result.rows];
  }

  async function latestRun(id: string, operation: string): Promise<RunRow | undefined> {
    const rows = await runsFor(id);
    return rows.filter((row) => row.operation === operation).at(-1);
  }

  async function factCount(kind: string): Promise<number> {
    const result = await h.database.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM connection_sync_facts WHERE kind = ${kind}
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  async function ledgerTransactionCount(): Promise<number> {
    const result = await h.database.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM transactions WHERE user_id = ${h.userId}::uuid
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  function sync(id: string): Promise<{ status: string; error: unknown }> {
    return h.orchestrator
      .syncConnection({
        connectionId: id,
        userId: h.userId,
        trigger: 'manual',
        correlationId: newId(),
      })
      .then((summary) => ({ status: summary.status, error: summary.error }));
  }

  beforeAll(async () => {
    api = new FakePlaidApi([defaultItemSpec()]);
    const honest = new PlaidConnector({ api, settings: linkSettings(), clock: testClock() });
    h = await createApiHarness({
      suite: 'invsync',
      plaidConnector: breakable(honest, failures) as unknown as PlaidConnector,
    });

    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken: PUBLIC_TOKEN, institutionName: 'Northwind Brokerage' },
    });
    expectStatus(response, 201);
    connectionId = (response.json() as { connectionId: string }).connectionId;
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Failure isolation
  // -------------------------------------------------------------------------

  it('a holdings leg failure leaves the transactions delta committed and correctly labeled', async () => {
    failures.set(
      'syncHoldings',
      ConnectorError.fromCondition('PROVIDER_DOWN', 'the brokerage feed is down', {
        redactedContext: { provider: 'plaid' },
      }),
    );
    const summary = await sync(connectionId);
    failures.delete('syncHoldings');

    // The transactions half is untouched: the orchestrator returns *its*
    // summary, and a leg that ran after it cannot reach back into the value.
    expect(summary.error, 'a holdings failure is not the sync run’s failure').toBeNull();
    expect(summary.status).toBe('success');

    const runs = await runsFor(connectionId);
    const transactions = runs.filter((row) => row.operation === 'transactions').at(-1);
    expect(transactions?.status, 'the transactions run stays successful').toBe('success');
    expect(transactions?.error_kind, 'and is not relabelled with somebody else’s error').toBeNull();
    expect(transactions?.added_count ?? 0).toBeGreaterThan(0);

    // …and the rows are really there, not merely counted.
    expect(await ledgerTransactionCount()).toBeGreaterThan(0);

    const holdings = await latestRun(connectionId, 'holdings');
    expect(holdings?.status, 'the holdings leg failed on its own row').toBe('failed');
    expect(holdings?.error_kind).toBe('provider_unavailable');
    expect(holdings?.error_code).toBe('PROVIDER_DOWN');

    // The other two legs are unaffected by the one that broke. This is the
    // claim that makes the three legs three legs rather than one.
    expect((await latestRun(connectionId, 'investment_txns'))?.status).toBe('success');
    expect((await latestRun(connectionId, 'liabilities'))?.status).toBe('success');

    // Nothing the failed leg would have written exists.
    expect(await factCount('holding'), 'a failed leg stages no facts').toBe(0);
    expect(await factCount('investment_transaction')).toBe(
      INVESTMENTS.investment_transactions.length,
    );
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------

  it('two syncs of the same window add no investment transactions', async () => {
    // The previous test already ran one full sync, so this is the second and
    // third pass over the same 24-month window. That is the real nightly
    // shape: 01 §5.5 has no cursor, so every run re-fetches everything.
    const before = await factCount('investment_transaction');
    expect(before, 'the fixture window').toBe(INVESTMENTS.investment_transactions.length);

    await sync(connectionId);
    const after = await factCount('investment_transaction');

    expect(after, 'a re-fetched window restates rows, it does not add them').toBe(before);

    const run = await latestRun(connectionId, 'investment_txns');
    expect(run?.status).toBe('success');
    // `added_count` is rows this run *created*; `modified_count` is rows it
    // restated. All restated, none created — readable straight off the
    // connections history view, with no row count beside it.
    expect(run?.added_count, 'nothing was created on the second pass').toBe(0);
    expect(run?.modified_count).toBe(before);

    // And a third, to prove the second was not a one-off of the first.
    await sync(connectionId);
    expect(await factCount('investment_transaction')).toBe(before);
    expect(await factCount('holding')).toBe(INVESTMENTS.holdings.length);
  });

  // -------------------------------------------------------------------------
  // The capability gate
  // -------------------------------------------------------------------------

  it('a connector without the holdings capability is skipped, not errored', async () => {
    // `ManualConnector` declares accounts, balances, transactions,
    // incremental_sync and on_demand_refresh — and none of the three dataset
    // capabilities. It also has no `syncHoldings` method at all, so this
    // exercises both halves of the gate.
    const linked = await linkManual(h, {
      providerConnectionId: 'manual-no-holdings',
      displayName: 'A shoebox of receipts',
      accounts: [
        {
          providerAccountId: 'shoebox-001',
          name: 'Shoebox',
          type: 'depository',
          currency: 'USD',
        },
      ],
    });

    const summary = await sync(linked.connectionId);
    expect(summary.error, 'a skipped leg is not an error').toBeNull();

    const runs = await runsFor(linked.connectionId);
    const operations = new Set(runs.map((row) => row.operation));
    expect(operations.has('transactions'), 'the transactions leg still ran').toBe(true);
    // Not "ran and failed with DATA_UNAVAILABLE", and not "ran and returned an
    // empty list" — a `sync_runs` row that says `holdings: success, 0 rows` is
    // indistinguishable from a brokerage that sold everything.
    expect(operations.has('holdings'), 'no holdings row at all').toBe(false);
    expect(operations.has('investment_txns')).toBe(false);
    expect(operations.has('liabilities')).toBe(false);
    expect(
      runs.every((row) => row.error_kind === null),
      'nothing about this connection failed',
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // What the legs actually recorded
  // -------------------------------------------------------------------------

  it('cost_basis is carried as reported, absent where the institution did not report one', async () => {
    const rows = await h.database.db.execute<{
      provider_security_id: string;
      cost_basis_minor: string | bigint | null;
      quantity: string;
    }>(sql`
      SELECT provider_security_id, cost_basis_minor, quantity
        FROM connection_sync_facts
       WHERE kind = 'holding'
       ORDER BY provider_security_id
    `);
    const basis = new Map(
      rows.rows.map((row) => [
        row.provider_security_id,
        row.cost_basis_minor === null ? null : BigInt(row.cost_basis_minor),
      ]),
    );

    expect(basis.size).toBe(3);
    // The one position the Sandbox fixture reports a basis for. Carried
    // verbatim: $14,200.00, and 01 §5.5 warns it may be *total* rather than
    // per-share, which is exactly why WP 3.2 prefers deriving from the
    // transactions and treats this as the fallback.
    expect(basis.get('sec-vti-0001')).toBe(1_420_000n);
    // The two it does not. **Null, never zero** — 04 §5.5: an unknown basis
    // reports `unavailable`, and a zero here would be a 100% unrealised gain
    // fabricated by a coalesce.
    expect(basis.get('sec-cash-0002')).toBeNull();
    expect(basis.get('sec-btc-0003')).toBeNull();
  });

  it('institution_value is kept for reconciliation and our own price source is the valuation', async () => {
    // WP 3.4's fake, standing in for the real `PriceSource`. Two of the three
    // prices deliberately differ from the institution's close, because a
    // reconciliation that can only ever agree proves nothing.
    const priceSource = createFakePriceSource({
      prices: {
        'VTI|2026-05-29|USD': '269.10',
        'BTC|2026-05-29|USD': '64100.50',
      },
    });

    const rows = await h.database.db.execute<{
      provider_security_id: string;
      quantity: string;
      value_minor: string;
      value_currency: string;
    }>(sql`
      SELECT provider_security_id, quantity, value_minor, value_currency
        FROM connection_sync_facts
       WHERE kind = 'holding'
       ORDER BY provider_security_id
    `);

    const byId = new Map(rows.rows.map((row) => [row.provider_security_id, row]));
    const vti = byId.get('sec-vti-0001');
    const btc = byId.get('sec-btc-0003');
    const cash = byId.get('sec-cash-0002');
    expect(vti).toBeDefined();
    expect(btc).toBeDefined();
    expect(cash).toBeDefined();
    if (vti === undefined || btc === undefined || cash === undefined) return;

    const quoted = await priceSource.price({
      subject: { kind: 'ticker', symbol: 'VTI', mic: null },
      date: '2026-05-29',
      currency: 'USD',
    });
    expect(quoted.kind).toBe('ok');
    if (quoted.kind !== 'ok') return;

    // Row 1 — a real, explainable difference. The institution priced VTI at
    // its own 268.40 close; ours is 269.10, and 62.5 units of a $0.70
    // difference is $43.75. Our number is the one that goes into net worth,
    // because it is the number every *other* account is also valued at.
    const ourVti = valueOf(vti.quantity, quoted.value.close, 'USD');
    expect(BigInt(vti.value_minor)).toBe(1_677_500n);
    expect(ourVti).toBe(1_681_875n);
    expect(ourVti - BigInt(vti.value_minor)).toBe(4_375n);

    // Row 2 — agreement to the cent, at the same price. A reconciliation has
    // to be able to say "these agree" as precisely as it says they differ.
    expect(valueOf(btc.quantity, '64100.50', 'USD')).toBe(0n);
    // …and yet the institution says a cent. `0.0000001 × 64100.50` is
    // $0.00641005, which the brokerage rounds *up* to $0.01 and we truncate to
    // $0.00. Sub-cent dust, and the only difference in the table that is about
    // rounding rather than about price.
    expect(BigInt(btc.value_minor)).toBe(1n);

    // Row 3 — a cash sweep at par. No price source is involved and none should
    // be: `is_cash_equivalent` is what WP 3.1 records and $1.00 is not a quote.
    expect(BigInt(cash.value_minor)).toBe(167_532n);
    expect(valueOf(cash.quantity, '1', 'USD')).toBe(167_532n);
  });

  it('the liabilities leg records the APR and statement block liabilities.terms reads', async () => {
    const terms = await liabilityTermsFor(h.database.db, h.userId);
    expect(terms.length, 'one block per liability account in the fixture').toBeGreaterThan(0);

    for (const block of terms) {
      // The join is the point: the block is addressable by `@ctx/ledger`'s
      // account id, which is what lets WP 3.10's `investments.liabilities(...)`
      // port pair it with the ledger's liability accounts and then strip the id
      // through the `liability_ref` tokeniser before anything leaves.
      expect(block.accountId, 'every block resolves to a ledger account').toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(block.provider).toBe('plaid');
    }

    const withApr = terms.filter((block) => block.apr !== null);
    expect(withApr.length, 'the fixture reports at least one APR').toBeGreaterThan(0);
    for (const block of withApr) {
      // A percentage as an exact decimal string — `NUMERIC(9,6)`, never a
      // float, and never money. 4.25% is not $4.25.
      expect(block.apr).toMatch(/^-?\d+\.\d{6}$/u);
    }

    // Re-running the leg restates the block rather than appending a second one:
    // a card has one APR at a time.
    const before = await factCount('liability');
    await sync(connectionId);
    expect(await factCount('liability')).toBe(before);
  });

  it('every dataset leg hit its endpoint exactly once per sync', async () => {
    // The guard against the mistake this file could hide: a leg that never ran
    // would pass "no failures" and "no extra rows" perfectly.
    const before = {
      holdings: api.countOf('investments/holdings/get'),
      transactions: api.countOf('investments/transactions/get'),
      liabilities: api.countOf('liabilities/get'),
    };
    await sync(connectionId);
    expect(api.countOf('investments/holdings/get') - before.holdings).toBe(1);
    expect(api.countOf('liabilities/get') - before.liabilities).toBe(1);
    // One page: five transactions is well under the 500-row `count`, and the
    // adapter stops as soon as `offset >= total_investment_transactions`.
    expect(api.countOf('investments/transactions/get') - before.transactions).toBe(1);

    // The 24-month window, on the wire. 01 §5.5 and D16: Plaid's ceiling is
    // 730 days and accepting the 90-day default silently loses ~21 months.
    const requests = api.requestsTo('investments/transactions/get') as {
      start_date: string;
      end_date: string;
    }[];
    const last = requests.at(-1);
    expect(last).toBeDefined();
    if (last === undefined) return;
    const spanDays =
      (Date.parse(`${last.end_date}T00:00:00Z`) - Date.parse(`${last.start_date}T00:00:00Z`)) /
      86_400_000;
    expect(spanDays, 'a 730-day window, not Plaid’s 90-day default').toBe(730);
  });

  it('the access token never reaches connection_sync_facts', async () => {
    // Every fact carries the provider's verbatim payload in `fact.raw` so a
    // Phase 4 question has a Phase 3 answer. That is exactly the column a
    // credential would hide in.
    const result = await h.database.db.execute<{ blob: string }>(sql`
      SELECT coalesce(string_agg(fact::text, ' '), '') AS blob FROM connection_sync_facts
    `);
    expect(result.rows[0]?.blob ?? '').not.toContain(ACCESS_TOKEN);
  });
});
