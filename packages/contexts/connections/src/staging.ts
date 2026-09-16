// SPDX-License-Identifier: MIT
/**
 * The durable `StagingStore` — decision D-5, migration `0008_connections_staging.sql`.
 *
 * `ManualConnector` and `CsvImportConnector` each declare a `StagingStore`
 * interface structurally (`@connector/manual/src/staging.ts`,
 * `@connector/csv/src/staging.ts` — identical shapes, neither importable by
 * the other: see either file's module comment for why). This is the one
 * implementation of that shape in the whole repo, built against
 * `connection_staged_facts`, and it satisfies both by construction without
 * importing either package's declaration — `apps/api/src/domain.ts` is the
 * one place `@connector/manual`, `@connector/csv` and this function all meet,
 * and it is what actually assigns this object to each connector's
 * `attachStagingStore`.
 *
 * Every method here is a plain query or a single insert; there is no
 * transaction spanning more than one statement, on purpose. This table is not
 * part of the orchestrator's commit -- `transactions_cursor` (migration 0005)
 * still advances only inside `SyncOrchestrator`'s own write transaction
 * (`orchestrator.ts` invariant 1), and nothing here changes that. Staging a
 * fact durably and *applying* it to the ledger are two different writes, the
 * same way `connect()` staging an account and `linkAccounts()` upserting it
 * are two different writes today.
 */
import { money, newId } from '@core/kernel';
import type {
  ProviderAccountFact,
  ProviderBalanceFact,
  ProviderTransactionFact,
} from '@connector/port';
import type { StagingStore as CsvStagingStore } from '@connector/csv';
import type { StagingStore as ManualStagingStore } from '@connector/manual';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { connectionStagedFacts, type ConnectionStagedFactRow } from '../schema/index.ts';
import type { ConnectionsDatabase } from './db.ts';

const TRANSACTION_KINDS = [
  'transaction_added',
  'transaction_modified',
  'transaction_removed',
] as const;

/** Verbatim text of the migration's partial unique indexes -- see that file's header. */
const ADDED_DEDUP_WHERE = sql`kind = 'transaction_added'`;
const STATE_UPSERT_WHERE = sql`kind IN ('account', 'balance')`;

function accountFromRow(row: ConnectionStagedFactRow): ProviderAccountFact {
  const fact = row.fact as Record<string, unknown>;
  return {
    providerAccountId: row.providerAccountId,
    name: fact['name'] as string,
    officialName: (fact['officialName'] as string | null) ?? null,
    type: fact['type'] as ProviderAccountFact['type'],
    subtype: (fact['subtype'] as string | null) ?? null,
    currency: fact['currency'] as string,
    mask: (fact['mask'] as string | null) ?? null,
    closed: Boolean(fact['closed']),
    capabilities: (fact['capabilities'] as ProviderAccountFact['capabilities']) ?? [],
  };
}

function balanceFromRow(row: ConnectionStagedFactRow): ProviderBalanceFact {
  return {
    providerAccountId: row.providerAccountId,
    current: money(row.amountMinor as bigint, row.amountCurrency as string),
    available:
      row.availableMinor === null ? null : money(row.availableMinor, row.availableCurrency as string),
    limit: row.limitMinor === null ? null : money(row.limitMinor, row.limitCurrency as string),
    asOf: row.asOf as Date,
  };
}

function transactionFromRow(row: ConnectionStagedFactRow): ProviderTransactionFact {
  const fact = row.fact as Record<string, unknown>;
  return {
    providerAccountId: row.providerAccountId,
    providerTransactionId: row.providerTransactionId as string,
    pendingTransactionId: (fact['pendingTransactionId'] as string | null) ?? null,
    amount: money(row.amountMinor as bigint, row.amountCurrency as string),
    isoCurrency: (fact['isoCurrency'] as string | null) ?? null,
    postedDate: fact['postedDate'] as ProviderTransactionFact['postedDate'],
    authorizedDate: (fact['authorizedDate'] as ProviderTransactionFact['authorizedDate']) ?? null,
    postedAt: fact['postedAt'] === null || fact['postedAt'] === undefined ? null : new Date(fact['postedAt'] as string),
    authorizedAt:
      fact['authorizedAt'] === null || fact['authorizedAt'] === undefined
        ? null
        : new Date(fact['authorizedAt'] as string),
    name: fact['name'] as string,
    merchantName: (fact['merchantName'] as string | null) ?? null,
    originalDescription: (fact['originalDescription'] as string | null) ?? null,
    paymentChannel: (fact['paymentChannel'] as string | null) ?? null,
    providerCategory: fact['providerCategory'] ?? null,
    pending: Boolean(fact['pending']),
    location: fact['location'] ?? null,
    counterparties: (fact['counterparties'] as ProviderTransactionFact['counterparties']) ?? null,
    raw: fact['raw'] ?? null,
    fingerprint: row.fingerprint as string,
  };
}

function transactionFactColumns(fact: ProviderTransactionFact): Record<string, unknown> {
  return {
    pendingTransactionId: fact.pendingTransactionId,
    isoCurrency: fact.isoCurrency,
    postedDate: fact.postedDate,
    authorizedDate: fact.authorizedDate,
    postedAt: fact.postedAt === null ? null : fact.postedAt.toISOString(),
    authorizedAt: fact.authorizedAt === null ? null : fact.authorizedAt.toISOString(),
    name: fact.name,
    merchantName: fact.merchantName,
    originalDescription: fact.originalDescription,
    paymentChannel: fact.paymentChannel,
    providerCategory: fact.providerCategory,
    pending: fact.pending,
    location: fact.location,
    counterparties: fact.counterparties,
    raw: fact.raw,
  };
}

/** Shared by `createManualStagingStore` and `createCsvStagingStore` — see the module comment. */
function buildStagingStore(database: ConnectionsDatabase): ManualStagingStore & CsvStagingStore {
  return {
    // No row to write: `has()` reads the state/log rows themselves, and both
    // connectors' `connect()` always stages at least one account before the
    // first flush (their input schemas require a non-empty account list), so
    // there is no "open but empty" state this would need to mark.
    async open(): Promise<void> {},

    async has(connectionId: string): Promise<boolean> {
      const rows = await database
        .select({ seq: connectionStagedFacts.seq })
        .from(connectionStagedFacts)
        .where(eq(connectionStagedFacts.connectionId, connectionId))
        .limit(1);
      return rows.length > 0;
    },

    async close(connectionId: string): Promise<void> {
      await database
        .delete(connectionStagedFacts)
        .where(eq(connectionStagedFacts.connectionId, connectionId));
    },

    async putAccounts(connectionId, userId, accounts): Promise<void> {
      if (accounts.length === 0) return;
      await database
        .insert(connectionStagedFacts)
        .values(
          accounts.map((account) => ({
            id: newId(),
            userId,
            connectionId,
            kind: 'account' as const,
            providerAccountId: account.providerAccountId,
            fact: {
              name: account.name,
              officialName: account.officialName,
              type: account.type,
              subtype: account.subtype,
              currency: account.currency,
              mask: account.mask,
              closed: account.closed,
              capabilities: account.capabilities,
            },
          })),
        )
        .onConflictDoUpdate({
          target: [
            connectionStagedFacts.connectionId,
            connectionStagedFacts.kind,
            connectionStagedFacts.providerAccountId,
          ],
          targetWhere: STATE_UPSERT_WHERE,
          set: { fact: sql`excluded.fact` },
        });
    },

    async putBalances(connectionId, userId, balances): Promise<void> {
      if (balances.length === 0) return;
      await database
        .insert(connectionStagedFacts)
        .values(
          balances.map((balance) => ({
            id: newId(),
            userId,
            connectionId,
            kind: 'balance' as const,
            providerAccountId: balance.providerAccountId,
            amountMinor: balance.current.minor,
            amountCurrency: balance.current.currency,
            availableMinor: balance.available?.minor ?? null,
            availableCurrency: balance.available?.currency ?? null,
            limitMinor: balance.limit?.minor ?? null,
            limitCurrency: balance.limit?.currency ?? null,
            asOf: balance.asOf,
          })),
        )
        .onConflictDoUpdate({
          target: [
            connectionStagedFacts.connectionId,
            connectionStagedFacts.kind,
            connectionStagedFacts.providerAccountId,
          ],
          targetWhere: STATE_UPSERT_WHERE,
          set: {
            amountMinor: sql`excluded.amount_minor`,
            amountCurrency: sql`excluded.amount_currency`,
            availableMinor: sql`excluded.available_minor`,
            availableCurrency: sql`excluded.available_currency`,
            limitMinor: sql`excluded.limit_minor`,
            limitCurrency: sql`excluded.limit_currency`,
            asOf: sql`excluded.as_of`,
          },
        });
    },

    async appendTransactions(connectionId, userId, entries) {
      if (entries.length === 0) return { staged: 0, skipped: 0 };
      const rows = entries.map((entry) => ({
        id: newId(),
        userId,
        connectionId,
        kind: (`transaction_${entry.kind}` as const),
        providerAccountId: entry.providerAccountId,
        providerTransactionId: entry.providerTransactionId,
        fingerprint: entry.fact?.fingerprint ?? null,
        amountMinor: entry.fact?.amount.minor ?? null,
        amountCurrency: entry.fact?.amount.currency ?? null,
        fact: entry.fact === null ? {} : transactionFactColumns(entry.fact),
      }));
      const inserted = await database
        .insert(connectionStagedFacts)
        .values(rows)
        .onConflictDoNothing({
          target: [connectionStagedFacts.connectionId, connectionStagedFacts.providerTransactionId],
          where: ADDED_DEDUP_WHERE,
        })
        .returning({ id: connectionStagedFacts.id });
      const staged = inserted.length;
      return { staged, skipped: entries.length - staged };
    },

    async accounts(connectionId: string): Promise<readonly ProviderAccountFact[]> {
      const rows = await database
        .select()
        .from(connectionStagedFacts)
        .where(
          and(eq(connectionStagedFacts.connectionId, connectionId), eq(connectionStagedFacts.kind, 'account')),
        );
      return rows.map(accountFromRow);
    },

    async balances(connectionId: string): Promise<readonly ProviderBalanceFact[]> {
      const rows = await database
        .select()
        .from(connectionStagedFacts)
        .where(
          and(eq(connectionStagedFacts.connectionId, connectionId), eq(connectionStagedFacts.kind, 'balance')),
        );
      return rows.map(balanceFromRow);
    },

    async entriesAfter(connectionId: string, after: number, limit: number) {
      const rows = await database
        .select()
        .from(connectionStagedFacts)
        .where(
          and(
            eq(connectionStagedFacts.connectionId, connectionId),
            gt(connectionStagedFacts.seq, BigInt(after)),
            inArray(connectionStagedFacts.kind, TRANSACTION_KINDS),
          ),
        )
        .orderBy(asc(connectionStagedFacts.seq))
        .limit(limit);
      return rows.map((row) => ({
        seq: Number(row.seq),
        kind: row.kind.slice('transaction_'.length) as 'added' | 'modified' | 'removed',
        providerAccountId: row.providerAccountId,
        providerTransactionId: row.providerTransactionId as string,
        fact: row.kind === 'transaction_removed' ? null : transactionFromRow(row),
      }));
    },

    async highestSeq(connectionId: string): Promise<number> {
      const rows = await database
        .select({ seq: connectionStagedFacts.seq })
        .from(connectionStagedFacts)
        .where(
          and(eq(connectionStagedFacts.connectionId, connectionId), inArray(connectionStagedFacts.kind, TRANSACTION_KINDS)),
        )
        .orderBy(desc(connectionStagedFacts.seq))
        .limit(1);
      return rows.length === 0 ? 0 : Number(rows[0]?.seq ?? 0);
    },
  };
}

/** For `apps/api/src/domain.ts` to attach to the registry's `ManualConnector`. */
export function createManualStagingStore(database: ConnectionsDatabase): ManualStagingStore {
  return buildStagingStore(database);
}

/** For `apps/api/src/domain.ts` to attach to the registry's `CsvImportConnector`. */
export function createCsvStagingStore(database: ConnectionsDatabase): CsvStagingStore {
  return buildStagingStore(database);
}
