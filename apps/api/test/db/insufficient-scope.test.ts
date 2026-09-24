// SPDX-License-Identifier: MIT
/**
 * `INSUFFICIENT_SCOPE` — the one condition that changes what a connection *is*.
 *
 * 08 §2.4's own gloss on it is "disable that dataset for this connection, keep
 * others", and `KIND_OF_CONDITION` classifies it `permanent`: retrying cannot
 * help until the user re-links with wider scope, and asking nightly forever is
 * a request the provider refuses every time while still counting it against the
 * Item's rate limit. So the leg that receives it narrows
 * `connections.capabilities.supports` — the same column `createConnection`
 * narrows from Plaid's `available_products` — and the *other* legs carry on.
 *
 * The scenario is a real one and the fake reproduces it without being asked
 * to pretend: a Plaid Item whose institution does not carry the `liabilities`
 * product answers `/liabilities/get` with `PRODUCTS_NOT_SUPPORTED`, which
 * `errors.ts` maps to `INSUFFICIENT_SCOPE`. `First Platypus Bank` in the
 * fixture *does* carry it; `defaultItemSpec({ withoutLiabilities: true })` is
 * the institution next door that does not.
 *
 * Three things have to be true together for this to be a control rather than a
 * log line, and the test asserts all three:
 *
 *   1. the capability is gone from the stored set, so the *next* sync does not
 *      ask again;
 *   2. the connection is still `active` — a card that does not carry
 *      investments is a healthy card, not a broken connection, and putting it
 *      in `error` would raise a banner the user can do nothing about;
 *   3. every other leg still runs and still writes.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  FakePlaidApi,
  INVESTMENTS,
  PUBLIC_TOKEN,
  defaultItemSpec,
  linkSettings,
  testClock,
} from '@connector/plaid/test';
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface RunRow {
  readonly [column: string]: unknown;
  readonly operation: string;
  readonly status: string;
  readonly error_kind: string | null;
  readonly error_code: string | null;
  readonly added_count: number;
}

describe.skipIf(NO_DATABASE)('INSUFFICIENT_SCOPE narrows one dataset (wp3.7)', () => {
  let h: ApiHarness;
  let api: FakePlaidApi;
  let connectionId: string;

  beforeAll(async () => {
    // An Item with investments but **no** liabilities product.
    api = new FakePlaidApi([defaultItemSpec({ withoutLiabilities: true })]);
    const connector = new PlaidConnector({ api, settings: linkSettings(), clock: testClock() });
    h = await createApiHarness({ suite: 'noscope', plaidConnector: connector });

    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken: PUBLIC_TOKEN, institutionName: 'A bank with no cards' },
    });
    expectStatus(response, 201);
    connectionId = (response.json() as { connectionId: string }).connectionId;
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function runs(): Promise<RunRow[]> {
    const result = await h.database.db.execute<RunRow>(sql`
      SELECT operation, status, error_kind, error_code, added_count
        FROM sync_runs
       WHERE connection_id = ${connectionId}::uuid
       ORDER BY started_at, operation
    `);
    return [...result.rows];
  }

  async function connectionRow(): Promise<{ status: string; supports: string[] }> {
    const result = await h.database.db.execute<{
      status: string;
      capabilities: { supports?: string[] } | string;
    }>(sql`SELECT status, capabilities FROM connections WHERE id = ${connectionId}::uuid`);
    const row = result.rows[0];
    const capabilities =
      typeof row?.capabilities === 'string'
        ? (JSON.parse(row.capabilities) as { supports?: string[] })
        : (row?.capabilities ?? {});
    return { status: row?.status ?? 'missing', supports: capabilities.supports ?? [] };
  }

  function sync(): Promise<unknown> {
    return h.orchestrator.syncConnection({
      connectionId,
      userId: h.userId,
      trigger: 'manual',
      correlationId: newId(),
    });
  }

  it('INSUFFICIENT_SCOPE clears the capability for this connection and leaves the others working', async () => {
    // The Item's `products` list still *names* liabilities — that is how a real
    // Item looks when the institution stopped carrying the product — so the
    // capability is granted at link time and only the call finds out.
    const linked = await connectionRow();
    expect(linked.supports, 'granted at link time').toContain('liabilities');

    await sync();

    // --- 1. the leg failed, on its own row, with the right classification ---
    const first = await runs();
    const liabilities = first.filter((row) => row.operation === 'liabilities').at(-1);
    expect(liabilities?.status).toBe('failed');
    expect(liabilities?.error_code).toBe('INSUFFICIENT_SCOPE');
    // `permanent`, not `transient`: the job runner must not back off and retry
    // a refusal that will be identical next time.
    expect(liabilities?.error_kind).toBe('permanent');

    // --- 2. …and the others worked ------------------------------------------
    expect(first.filter((row) => row.operation === 'transactions').at(-1)?.status).toBe('success');
    expect(first.filter((row) => row.operation === 'balances').at(-1)?.status).toBe('success');
    expect(first.filter((row) => row.operation === 'holdings').at(-1)?.status).toBe('success');
    const investments = first.filter((row) => row.operation === 'investment_txns').at(-1);
    expect(investments?.status).toBe('success');
    expect(investments?.added_count).toBe(INVESTMENTS.investment_transactions.length);

    // --- 3. the capability is gone, and the connection is not "broken" ------
    const after = await connectionRow();
    expect(after.supports, 'cleared for this connection').not.toContain('liabilities');
    expect(after.supports, 'and only that one').toEqual(
      expect.arrayContaining(['transactions', 'balances', 'holdings', 'investment_txns']),
    );
    expect(after.status, 'a bank with no cards is not a broken connection').toBe('active');

    // --- 4. the next sync does not ask again --------------------------------
    const askedBefore = api.countOf('liabilities/get');
    const holdingsBefore = api.countOf('investments/holdings/get');
    await sync();
    expect(
      api.countOf('liabilities/get') - askedBefore,
      'a permanent refusal is not re-requested nightly',
    ).toBe(0);
    expect(
      api.countOf('investments/holdings/get') - holdingsBefore,
      'and the legs that work are unaffected',
    ).toBe(1);

    // No second `liabilities` row either: a skipped leg writes nothing, which
    // is what keeps the history view about things that happened.
    const second = await runs();
    expect(second.filter((row) => row.operation === 'liabilities')).toHaveLength(1);
    expect(second.filter((row) => row.operation === 'holdings')).toHaveLength(2);
  });
});
