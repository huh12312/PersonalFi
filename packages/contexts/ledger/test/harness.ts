// SPDX-License-Identifier: MIT
/**
 * The `@ctx/ledger` database-test harness.
 *
 * `@core/testkit` and `@core/seed` are dev-only dependencies of this context and
 * are declared as `devDependencies`; the `ledger` entry in
 * `scripts/eslint-boundaries.js` allows them here rather than this file carrying
 * an `eslint-disable`, so the looseness is visible in the policy instead of
 * hidden in a comment at the top of a test file. No file under `src/` imports
 * either one — `loadSeedDataset` declares the dataset shape structurally for
 * exactly that reason.
 */
import { DateOnly, mutableClock, money, newId, type MutableClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import type { LedgerWriteContext } from '../src/accounts.ts';
import { classificationOf, upsertAccount } from '../src/accounts.ts';
import type { ProviderTransactionInput } from '../src/types.ts';

export { ADMIN_URL, type TestDatabase };

/**
 * Re-exported so the boundary directive at the top of this file is the only one
 * in the package: a suite that wants the demo dataset imports it from here.
 */
export { generateDemoData };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** The instant every suite starts at, so a failure message reads the same twice. */
export const EPOCH = '2026-06-01T12:00:00.000Z';

export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c1';

export function testClock(): MutableClock {
  return mutableClock(EPOCH);
}

export function writeContext(clock: MutableClock): LedgerWriteContext {
  return { clock, correlationId: CORRELATION_ID };
}

/** A scratch database with a unique name per run, so two runs never collide. */
export async function ledgerDatabase(suite: string): Promise<TestDatabase> {
  const unique = newId().replaceAll('-', '').slice(-12);
  return createTestDatabase(`personalfi_ledger_${suite}_${unique}`);
}

export async function seedAccount(
  database: TestDatabase,
  clock: MutableClock,
  overrides: {
    provider?: string;
    providerAccountId?: string;
    name?: string;
    type?: 'depository' | 'credit' | 'loan' | 'investment' | 'crypto' | 'manual';
    classification?: 'asset' | 'liability';
    currency?: string;
    userId?: string;
  } = {},
): Promise<string> {
  const type = overrides.type ?? 'depository';
  const result = await database.db.transaction(async (tx) =>
    upsertAccount(
      tx,
      {
        userId: overrides.userId ?? database.userId,
        provider: overrides.provider ?? 'plaid',
        providerAccountId: overrides.providerAccountId ?? `pa-${newId().slice(-8)}`,
        name: overrides.name ?? 'Everyday Checking',
        type,
        classification: overrides.classification ?? classificationOf(type),
        currency: overrides.currency ?? 'USD',
        mask: '4471',
      },
      writeContext(clock),
    ),
  );
  return result.accountId;
}

/**
 * One provider transaction, already normalised to the house sign convention —
 * exactly what a connector hands `applyProviderTransactions`.
 */
export function providerTransaction(
  overrides: Partial<ProviderTransactionInput> & { providerTransactionId: string },
): ProviderTransactionInput {
  return {
    pendingTransactionId: null,
    amount: money(-1_234n, 'USD'),
    isoCurrency: 'USD',
    postedDate: DateOnly.parse('2026-05-20'),
    authorizedDate: null,
    postedAt: null,
    authorizedAt: null,
    name: 'SQ *BLUE BOTTLE 4471',
    merchantName: null,
    originalDescription: null,
    paymentChannel: 'in store',
    providerCategory: null,
    pending: false,
    location: null,
    counterparties: null,
    raw: { source: 'test' },
    ...overrides,
  };
}

/** How many events of a type the outbox holds. Ledger owns none of those tables. */
export async function countEvents(database: TestDatabase, eventType?: string): Promise<number> {
  const result = await database.db.execute<{ count: string }>(
    eventType === undefined
      ? sql`SELECT count(*) AS count FROM domain_events`
      : sql`SELECT count(*) AS count FROM domain_events WHERE event_type = ${eventType}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function eventPayloads<T>(database: TestDatabase, eventType: string): Promise<T[]> {
  const result = await database.db.execute<{ payload: T }>(
    sql`SELECT payload FROM domain_events WHERE event_type = ${eventType} ORDER BY seq`,
  );
  return result.rows.map((row) => row.payload);
}
