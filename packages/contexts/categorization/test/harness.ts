// SPDX-License-Identifier: MIT
/**
 * The `@ctx/categorization` database-test harness.
 *
 * Same shape as `@ctx/ledger`'s: a scratch database per suite, a mutable clock, a
 * write context, and the fixture builders every suite in this directory shares.
 *
 * `@core/testkit` (the scratch database) and `@core/seed` (the demo dataset the
 * golden set is derived from) are **devDependencies** of this package, imported
 * only from here — nothing under `src/` reaches for either. `scripts/eslint-
 * boundaries.js`'s `LAYERS` names a `categorization` entry allowing both, the
 * same arrangement `@ctx/ledger` and `@ctx/connections` use, so the looseness is
 * visible in the policy instead of hidden behind an `eslint-disable` here.
 */
import { mutableClock, newId, type MutableClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { ADMIN_URL, createTestDatabase, recordingLogger, waitFor } from '@core/testkit';
import type { TestDatabase } from '@core/testkit';
import { DateOnly } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type {
  CategorizableTransaction,
  CategorizationContext,
  CategorizationDatabase,
  LedgerPort,
  WriteRuleCategoryInput,
} from '../src/index.ts';

export { ADMIN_URL, generateDemoData, recordingLogger, waitFor, type TestDatabase };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** The instant every suite starts at, so a failure message reads the same twice. */
export const EPOCH = '2026-06-01T12:00:00.000Z';

export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c4';

export function testClock(): MutableClock {
  return mutableClock(EPOCH);
}

export function writeContext(
  database: TestDatabase,
  clock: MutableClock,
  overrides: Partial<CategorizationContext> = {},
): CategorizationContext {
  return {
    userId: database.userId,
    clock,
    correlationId: CORRELATION_ID,
    causationId: null,
    ...overrides,
  };
}

/**
 * A scratch database with a unique name per run.
 *
 * Unique rather than named after the suite alone, because two runs of the same
 * suite (a watch rerun, two agents on one machine) would otherwise race each
 * other's `DROP DATABASE`.
 */
export async function categorizationDatabase(suite: string): Promise<TestDatabase> {
  const unique = newId().replaceAll('-', '').slice(-12);
  return createTestDatabase(`personalfi_catg_${suite}_${unique}`);
}

/** `database.db` under the type the service layer asks for. */
export function asDatabase(database: TestDatabase): CategorizationDatabase {
  return database.db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

/** A deterministic-looking UUIDv7 that is still unique within a run. */
export function testId(prefix = 'a'): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${prefix}${String(sequence).padStart(11, '0')}`;
}

/**
 * One `CategorizableTransaction`, the shape the `LedgerPort` adapter yields.
 *
 * Defaults to a coffee purchase on a credit card with a noisy Square descriptor,
 * because that is the row every tier has an opinion about: the descriptor needs
 * cleaning, the amount is small, and the provider category is absent unless a
 * test supplies one.
 */
export function transactionFixture(
  overrides: Partial<CategorizableTransaction> = {},
): CategorizableTransaction {
  return {
    id: testId('a'),
    accountId: '00000000-0000-7000-8000-b00000000001',
    accountType: 'credit',
    payee: 'SQ *BLUE BOTTLE COFFEE',
    rawDescriptor: 'SQ *BLUE BOTTLE COFFEE OAKLAND CA',
    providerMerchantName: null,
    merchantId: '00000000-0000-7000-8000-c00000000001',
    amountMinor: -650n,
    currency: 'USD',
    date: DateOnly.parse('2026-05-20'),
    providerCategory: null,
    mcc: null,
    isTransfer: false,
    userCategoryId: null,
    ...overrides,
  };
}

/**
 * An in-memory `LedgerPort`, recording, over a fixed list.
 *
 * The port is the seam this context reads the ledger through (`src/ledger-port.ts`),
 * and a fake is the *right* double here rather than a compromise: the real
 * adapter belongs to `apps/api`, and a database-backed stand-in would test
 * `@ctx/ledger`'s query rather than this context's write path. What these suites
 * assert — one current assignment per transaction, an event and its rows
 * committing together — is entirely about tables this package owns.
 *
 * `ruleCategoryWrites` records every `writeRuleCategory` call so a test can
 * assert both halves of the rule tier's write path: that a winning `rule`
 * decision reaches `@ctx/ledger`'s seam, and that every other tier
 * (`merchant_default`, `provider`, `classifier`, `none`) never touches it.
 */
export interface RecordingLedgerPort extends LedgerPort {
  readonly ruleCategoryWrites: WriteRuleCategoryInput[];
}

export function inMemoryPort(
  transactions: readonly CategorizableTransaction[],
): RecordingLedgerPort {
  const ruleCategoryWrites: WriteRuleCategoryInput[] = [];
  return {
    listForCategorization: (input) => {
      const wanted = input.transactionIds;
      const accounts = input.accountIds;
      const items = transactions.filter(
        (transaction) =>
          (wanted === undefined || wanted.includes(transaction.id)) &&
          (accounts === undefined || accounts.includes(transaction.accountId)),
      );
      return Promise.resolve({ items, nextCursor: null });
    },
    writeRuleCategory: (input) => {
      ruleCategoryWrites.push(input);
      return Promise.resolve();
    },
    ruleCategoryWrites,
  };
}

// ---------------------------------------------------------------------------
// Reading back what the write path wrote
// ---------------------------------------------------------------------------

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  transaction_id: string;
  category_key: string;
  source: string;
  confidence: string;
  rule_id: string | null;
  version: number;
  is_current: boolean;
  confirmed_at: string | Date | null;
}

/** Every assignment for one transaction, newest version first. */
export async function assignmentsOf(
  database: TestDatabase,
  transactionId: string,
): Promise<AssignmentRow[]> {
  const result = await database.db.execute<AssignmentRow>(sql`
    SELECT a.id, a.transaction_id, c.key AS category_key, a.source, a.confidence,
           a.rule_id, a.version, a.is_current, a.confirmed_at
      FROM category_assignments a
      JOIN categories c ON c.id = a.category_id
     WHERE a.transaction_id = ${transactionId}
     ORDER BY a.version DESC
  `);
  return [...result.rows];
}

/** The one current assignment, or null. */
export async function currentAssignmentOf(
  database: TestDatabase,
  transactionId: string,
): Promise<AssignmentRow | null> {
  const rows = await assignmentsOf(database, transactionId);
  return rows.find((row) => row.is_current) ?? null;
}

/** Payloads of every event of a type, oldest first. Outbox tables are platform's. */
export async function eventPayloads<TPayload = Record<string, unknown>>(
  database: TestDatabase,
  eventType: string,
): Promise<TPayload[]> {
  const result = await database.db.execute<{ payload: TPayload }>(sql`
    SELECT payload FROM domain_events WHERE event_type = ${eventType} ORDER BY seq
  `);
  return result.rows.map((row) => row.payload);
}

export async function countRows(database: TestDatabase, table: string): Promise<number> {
  const result = await database.db.execute<{ count: string }>(
    sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
