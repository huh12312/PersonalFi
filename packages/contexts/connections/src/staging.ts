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
import { DateOnly, money, newId, type DateOnly as DateOnlyType, type Money } from '@core/kernel';
import type {
  ProviderAccountFact,
  ProviderBalanceFact,
  ProviderHoldingFact,
  ProviderInvestmentTransactionFact,
  ProviderLiabilityFact,
  ProviderTransactionFact,
} from '@connector/port';
import type { StagingStore as CsvStagingStore } from '@connector/csv';
import type { StagingStore as ManualStagingStore } from '@connector/manual';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  connectionAccounts,
  connectionStagedFacts,
  connectionSyncFacts,
  connections,
  syncRuns,
  type ConnectionStagedFactRow,
  type ConnectionSyncFactRow,
} from '../schema/index.ts';
import type { ConnectionsDatabase, ConnectionsExecutor } from './db.ts';

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
      row.availableMinor === null
        ? null
        : money(row.availableMinor, row.availableCurrency as string),
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
    postedAt:
      fact['postedAt'] === null || fact['postedAt'] === undefined
        ? null
        : new Date(fact['postedAt'] as string),
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
        kind: `transaction_${entry.kind}` as const,
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
          and(
            eq(connectionStagedFacts.connectionId, connectionId),
            eq(connectionStagedFacts.kind, 'account'),
          ),
        );
      return rows.map(accountFromRow);
    },

    async balances(connectionId: string): Promise<readonly ProviderBalanceFact[]> {
      const rows = await database
        .select()
        .from(connectionStagedFacts)
        .where(
          and(
            eq(connectionStagedFacts.connectionId, connectionId),
            eq(connectionStagedFacts.kind, 'balance'),
          ),
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
          and(
            eq(connectionStagedFacts.connectionId, connectionId),
            inArray(connectionStagedFacts.kind, TRANSACTION_KINDS),
          ),
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

// ---------------------------------------------------------------------------
// `connection_sync_facts` — the other staging table (migration 0018)
// ---------------------------------------------------------------------------

/**
 * What a *remote* provider leg observed, staged for another context to read.
 *
 * The mirror image of everything above. `connection_staged_facts` is an
 * **inbox**: rows a process-local connector accumulated and has not flushed
 * yet. `connection_sync_facts` is an **outbox**: rows a provider already gave
 * us, written so `@ctx/investments`' lot consumer can read them back through
 * `InvestmentSyncPort.factsForRun` in a different transaction, in a different
 * process, some seconds later. 08 §3.4 is why it cannot be the event payload —
 * "payloads are ids, counts and enums, never rows".
 *
 * ## Every write is an upsert on the provider's natural key
 *
 * Not on the run. 01 §5.5: there is no `/investments/transactions/sync`, so
 * every nightly sync re-fetches the whole 24-month window and restates the
 * same facts. Keyed on `provider_transaction_id`, the second sync of the same
 * window writes **zero** new rows and simply re-points `sync_run_id` at the
 * run that just saw them — which is the row-level half of "two syncs of the
 * same window add no investment transactions", and the reason this table's
 * size is the size of the portfolio rather than the size of the sync history.
 *
 * ## These take an executor, and the leg passes its transaction
 *
 * Unlike `buildStagingStore` above (whose every method is a standalone
 * statement, deliberately outside the orchestrator's commit), a leg's facts
 * and the `sync_runs` row that announces them have to land together: a run
 * that says `added_count = 42` with no facts behind it would send the lot
 * consumer looking for rows that do not exist, and a rolled-back leg that left
 * its facts behind would hand the *next* run's `factsForRun` somebody else's
 * observations.
 */
export interface SyncFactTarget {
  readonly userId: string;
  readonly connectionId: string;
  /** The run being recorded. Becomes `sync_run_id` — "last observed by". */
  readonly syncRunId: string;
}

/** How many rows a fact write touched, and how many of those were new. */
export interface SyncFactWriteResult {
  /** Rows inserted or updated. Equal to `facts.length` unless one was dropped. */
  readonly written: number;
  /** Rows that did not exist before this write. The idempotence measurement. */
  readonly inserted: number;
}

const NO_FACTS: SyncFactWriteResult = Object.freeze({ written: 0, inserted: 0 });

/** Verbatim predicates of migration 0018's three partial unique indexes. */
const HOLDING_WHERE = sql`kind = 'holding'`;
const INVESTMENT_TRANSACTION_WHERE = sql`kind = 'investment_transaction'`;
const LIABILITY_WHERE = sql`kind = 'liability'`;

/**
 * `xmax = 0` is Postgres' own answer to "was this an insert or an update".
 *
 * Counting `RETURNING` rows cannot tell them apart on an `ON CONFLICT DO
 * UPDATE`, and the difference is exactly what the idempotence evidence
 * measures. `recordBalance` in `@ctx/ledger` uses the same trick and so does
 * the test harness's ledger double.
 */
const INSERTED = sql<boolean>`(xmax = 0)`;

function countInserted(rows: readonly { inserted: boolean | null }[]): SyncFactWriteResult {
  return {
    written: rows.length,
    inserted: rows.filter((row) => row.inserted === true).length,
  };
}

/**
 * The holdings leg's facts: one row per (connection, account, security).
 *
 * A position the provider stops reporting is **left behind** rather than
 * deleted. Two reasons, and neither is laziness: the row is keyed on the
 * provider's natural key and carries the run that last saw it, so a stale row
 * is visibly stale (`sync_run_id` points at an old run) and answers no
 * `factsForRun`; and deleting on absence would make one truncated provider
 * response — the failure mode 08 §2.2 says an honest adapter must never
 * produce — permanently destroy the record that the position existed.
 */
export async function recordHoldingFacts(
  executor: ConnectionsExecutor,
  target: SyncFactTarget,
  facts: readonly ProviderHoldingFact[],
): Promise<SyncFactWriteResult> {
  if (facts.length === 0) return NO_FACTS;
  const rows = await executor
    .insert(connectionSyncFacts)
    .values(
      facts.map((fact) => ({
        id: newId(),
        userId: target.userId,
        connectionId: target.connectionId,
        syncRunId: target.syncRunId,
        kind: 'holding' as const,
        providerAccountId: fact.providerAccountId,
        // The provider's opaque id lives on the security fact now (WP 3.7a); it
        // stays a *column* here because it is half of this kind's natural key
        // and an `ON CONFLICT` target cannot be a jsonb path.
        providerSecurityId: fact.security.providerSecurityId,
        quantity: fact.quantity,
        valueMinor: fact.value.minor,
        valueCurrency: fact.value.currency,
        costBasisMinor: fact.costBasis?.minor ?? null,
        costBasisCurrency: fact.costBasis?.currency ?? null,
        asOf: fact.asOf,
        // `security` is the whole `ProviderSecurityFact` — every identifier the
        // provider gave, plus its type and name — rather than the one identifier
        // an adapter had to choose. That is a jsonb *shape* change and not a DDL
        // one: `fact` is `jsonb NOT NULL` in migration 0018 and always was.
        fact: { security: fact.security, raw: fact.raw },
      })),
    )
    .onConflictDoUpdate({
      target: [
        connectionSyncFacts.connectionId,
        connectionSyncFacts.providerAccountId,
        connectionSyncFacts.providerSecurityId,
      ],
      targetWhere: HOLDING_WHERE,
      set: {
        syncRunId: sql`excluded.sync_run_id`,
        quantity: sql`excluded.quantity`,
        valueMinor: sql`excluded.value_minor`,
        valueCurrency: sql`excluded.value_currency`,
        costBasisMinor: sql`excluded.cost_basis_minor`,
        costBasisCurrency: sql`excluded.cost_basis_currency`,
        asOf: sql`excluded.as_of`,
        fact: sql`excluded.fact`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ inserted: INSERTED });
  return countInserted(rows);
}

/**
 * The investment-transactions leg's facts: one row per provider transaction id.
 *
 * `onConflictDoUpdate` rather than `DoNothing` because a provider is allowed to
 * *correct* a transaction inside the window — Plaid restates a settlement price
 * — and a `DO NOTHING` would silently keep the first answer forever. The
 * conflict target is 01 §5.5's idempotency key, so a correction updates the row
 * it corrects and a re-fetch of an unchanged window changes nothing but
 * `sync_run_id`.
 */
export async function recordInvestmentTransactionFacts(
  executor: ConnectionsExecutor,
  target: SyncFactTarget,
  facts: readonly ProviderInvestmentTransactionFact[],
): Promise<SyncFactWriteResult> {
  if (facts.length === 0) return NO_FACTS;
  const rows = await executor
    .insert(connectionSyncFacts)
    .values(
      facts.map((fact) => ({
        id: newId(),
        userId: target.userId,
        connectionId: target.connectionId,
        syncRunId: target.syncRunId,
        kind: 'investment_transaction' as const,
        providerAccountId: fact.providerAccountId,
        providerSecurityId: fact.providerSecurityId,
        providerTransactionId: fact.providerTransactionId,
        fingerprint: fact.fingerprint,
        quantity: fact.quantity,
        price: fact.price,
        amountMinor: fact.amount.minor,
        amountCurrency: fact.amount.currency,
        feesMinor: fact.fees?.minor ?? null,
        feesCurrency: fact.fees?.currency ?? null,
        transactionDate: fact.date,
        fact: {
          security: fact.security,
          name: fact.name,
          type: fact.type,
          subtype: fact.subtype,
          raw: fact.raw,
        },
      })),
    )
    .onConflictDoUpdate({
      target: [connectionSyncFacts.connectionId, connectionSyncFacts.providerTransactionId],
      targetWhere: INVESTMENT_TRANSACTION_WHERE,
      set: {
        syncRunId: sql`excluded.sync_run_id`,
        providerAccountId: sql`excluded.provider_account_id`,
        providerSecurityId: sql`excluded.provider_security_id`,
        fingerprint: sql`excluded.fingerprint`,
        quantity: sql`excluded.quantity`,
        price: sql`excluded.price`,
        amountMinor: sql`excluded.amount_minor`,
        amountCurrency: sql`excluded.amount_currency`,
        feesMinor: sql`excluded.fees_minor`,
        feesCurrency: sql`excluded.fees_currency`,
        transactionDate: sql`excluded.transaction_date`,
        fact: sql`excluded.fact`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ inserted: INSERTED });
  return countInserted(rows);
}

/**
 * The liabilities leg's facts: one terms block per (connection, account).
 *
 * This is the APR / statement-balance / minimum-payment / next-payment-due
 * block WP 2.7's `CATALOGUE_GAPS` called "the highest-value addition to the
 * scope catalogue a later phase could make". It is current state, not history:
 * a card has one APR at a time, and the row is overwritten.
 */
export async function recordLiabilityFacts(
  executor: ConnectionsExecutor,
  target: SyncFactTarget,
  facts: readonly ProviderLiabilityFact[],
): Promise<SyncFactWriteResult> {
  if (facts.length === 0) return NO_FACTS;
  const rows = await executor
    .insert(connectionSyncFacts)
    .values(
      facts.map((fact) => ({
        id: newId(),
        userId: target.userId,
        connectionId: target.connectionId,
        syncRunId: target.syncRunId,
        kind: 'liability' as const,
        providerAccountId: fact.providerAccountId,
        apr: fact.apr,
        statementBalanceMinor: fact.statementBalance?.minor ?? null,
        statementBalanceCurrency: fact.statementBalance?.currency ?? null,
        minimumPaymentMinor: fact.minimumPayment?.minor ?? null,
        minimumPaymentCurrency: fact.minimumPayment?.currency ?? null,
        nextPaymentDue: fact.nextPaymentDue,
        fact: { raw: fact.raw },
      })),
    )
    .onConflictDoUpdate({
      target: [connectionSyncFacts.connectionId, connectionSyncFacts.providerAccountId],
      targetWhere: LIABILITY_WHERE,
      set: {
        syncRunId: sql`excluded.sync_run_id`,
        apr: sql`excluded.apr`,
        statementBalanceMinor: sql`excluded.statement_balance_minor`,
        statementBalanceCurrency: sql`excluded.statement_balance_currency`,
        minimumPaymentMinor: sql`excluded.minimum_payment_minor`,
        minimumPaymentCurrency: sql`excluded.minimum_payment_currency`,
        nextPaymentDue: sql`excluded.next_payment_due`,
        fact: sql`excluded.fact`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ inserted: INSERTED });
  return countInserted(rows);
}

// ---------------------------------------------------------------------------
// …and reading them back
// ---------------------------------------------------------------------------

/**
 * One holding fact, with the ledger account it belongs to already resolved.
 *
 * The join to `connection_accounts` happens here rather than at the caller so
 * the SQL that names this context's tables stays inside this context —
 * `pnpm lint:schema-ownership`'s rule, and the reason
 * `InvestmentSyncPort.factsForRun` in `apps/api/src/domain.ts` can be about
 * securities and sources rather than about a three-table join.
 */
export interface RunHoldingFact {
  /** `@ctx/ledger`'s `accounts.id`. Opaque here, as everywhere in this context. */
  readonly accountId: string;
  readonly fact: ProviderHoldingFact;
}

export interface RunInvestmentTransactionFact {
  readonly accountId: string;
  readonly fact: ProviderInvestmentTransactionFact;
}

/** Everything one run observed, plus the two fields the consumer's port needs. */
export interface RunInvestmentFacts {
  readonly provider: string;
  /** The run's `started_at`. The consumer turns it into the facts' `asOfDate`. */
  readonly startedAt: Date;
  readonly holdings: readonly RunHoldingFact[];
  readonly transactions: readonly RunInvestmentTransactionFact[];
}

/**
 * The `holdings` and `investment_transaction` facts a run last observed.
 *
 * `null` when there is no such run for this user — which is also the answer for
 * another user's run id, because the `user_id` predicate is in the `WHERE` and
 * not in a branch somebody could forget.
 *
 * A fact whose `provider_account_id` this connection has never mapped is
 * **dropped**, not raised. That is the opposite of `groupByAccount`'s rule for
 * transactions, and deliberately so: there, a dropped row is money the user
 * loses sight of, so a contract violation is worth failing the page over. Here
 * the leg has already committed and the only reader is a derivation that runs
 * minutes later; raising would turn a provider's stray account id into a
 * permanently red consumer that no retry can clear. The fact is not lost when
 * that happens — the row is still in `connection_sync_facts`, still keyed by
 * the provider account id nobody could map — so the evidence survives even
 * though the derivation skips it, and the next `listAccounts` that discovers
 * the account makes it readable.
 */
export async function investmentFactsForRun(
  executor: ConnectionsExecutor,
  userId: string,
  syncRunId: string,
): Promise<RunInvestmentFacts | null> {
  const runs = await executor
    .select({
      provider: connections.provider,
      startedAt: syncRuns.startedAt,
    })
    .from(syncRuns)
    .innerJoin(connections, eq(connections.id, syncRuns.connectionId))
    .where(and(eq(syncRuns.id, syncRunId), eq(syncRuns.userId, userId)))
    .limit(1);
  const run = runs[0];
  if (run === undefined) return null;

  const rows = await executor
    .select({
      fact: connectionSyncFacts,
      accountId: connectionAccounts.accountId,
    })
    .from(connectionSyncFacts)
    .innerJoin(
      connectionAccounts,
      and(
        eq(connectionAccounts.connectionId, connectionSyncFacts.connectionId),
        eq(connectionAccounts.providerAccountId, connectionSyncFacts.providerAccountId),
      ),
    )
    .where(
      and(
        eq(connectionSyncFacts.userId, userId),
        eq(connectionSyncFacts.syncRunId, syncRunId),
        inArray(connectionSyncFacts.kind, ['holding', 'investment_transaction']),
      ),
    )
    .orderBy(asc(connectionSyncFacts.seq));

  const holdings: RunHoldingFact[] = [];
  const transactions: RunInvestmentTransactionFact[] = [];
  for (const row of rows) {
    if (row.fact.kind === 'holding') {
      holdings.push({ accountId: row.accountId, fact: holdingFactFromRow(row.fact) });
    } else {
      transactions.push({
        accountId: row.accountId,
        fact: investmentTransactionFactFromRow(row.fact),
      });
    }
  }
  return { provider: run.provider, startedAt: run.startedAt, holdings, transactions };
}

/** One account's loan or card terms, as the provider last stated them. */
export interface LiabilityTerms {
  readonly accountId: string;
  readonly providerAccountId: string;
  readonly provider: string;
  /** A percentage, as a decimal string. `null` when the provider did not say. */
  readonly apr: string | null;
  readonly statementBalance: Money | null;
  readonly minimumPayment: Money | null;
  readonly nextPaymentDue: DateOnlyType | null;
  /** When this block was last re-observed, so a reader can call it stale. */
  readonly observedAt: Date;
}

/**
 * Every liability terms block this user has, newest observation per account.
 *
 * The published reader behind WP 3.10's `liabilities.terms` scope: 08 §4.2's
 * block needs an APR, a statement balance, a minimum payment and a due date,
 * and `@ctx/ledger` has none of them — a liability *account* carries a balance
 * and a credit limit, and the terms are what the `liabilities` product adds.
 * The snapshot builder's `investments.liabilities(...)` port is satisfied at
 * the composition root by joining this to the ledger's liability accounts, and
 * the `liability_ref` tokeniser is what strips `accountId` before anything
 * leaves.
 */
export async function liabilityTermsFor(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<readonly LiabilityTerms[]> {
  const rows = await executor
    .select({
      fact: connectionSyncFacts,
      accountId: connectionAccounts.accountId,
      provider: connections.provider,
    })
    .from(connectionSyncFacts)
    .innerJoin(
      connectionAccounts,
      and(
        eq(connectionAccounts.connectionId, connectionSyncFacts.connectionId),
        eq(connectionAccounts.providerAccountId, connectionSyncFacts.providerAccountId),
      ),
    )
    .innerJoin(connections, eq(connections.id, connectionSyncFacts.connectionId))
    .where(and(eq(connectionSyncFacts.userId, userId), eq(connectionSyncFacts.kind, 'liability')))
    .orderBy(asc(connectionSyncFacts.seq));

  return rows.map((row) => ({
    accountId: row.accountId,
    providerAccountId: row.fact.providerAccountId,
    provider: row.provider,
    apr: row.fact.apr,
    statementBalance: moneyOrNull(
      row.fact.statementBalanceMinor,
      row.fact.statementBalanceCurrency,
    ),
    minimumPayment: moneyOrNull(row.fact.minimumPaymentMinor, row.fact.minimumPaymentCurrency),
    nextPaymentDue:
      row.fact.nextPaymentDue === null ? null : DateOnly.parse(row.fact.nextPaymentDue),
    observedAt: row.fact.updatedAt,
  }));
}

function moneyOrNull(minor: bigint | null, currency: string | null): Money | null {
  return minor === null || currency === null ? null : money(minor, currency);
}

function holdingFactFromRow(row: ConnectionSyncFactRow): ProviderHoldingFact {
  const fact = row.fact as Record<string, unknown>;
  return {
    providerAccountId: row.providerAccountId,
    // Round-trips as JSON: every field of `ProviderSecurityFact` is a string, a
    // boolean, a null or an array of those. `closePriceAsOf` is a `DateOnly`,
    // which is a *branded string*, and `closePrice` is a decimal string rather
    // than a float — so nothing here needs a reviver, and nothing loses
    // precision on the way through Postgres.
    security: fact['security'] as ProviderHoldingFact['security'],
    quantity: row.quantity as string,
    costBasis: moneyOrNull(row.costBasisMinor, row.costBasisCurrency),
    value: money(row.valueMinor as bigint, row.valueCurrency as string),
    asOf: row.asOf as Date,
    raw: fact['raw'] ?? null,
  };
}

function investmentTransactionFactFromRow(
  row: ConnectionSyncFactRow,
): ProviderInvestmentTransactionFact {
  const fact = row.fact as Record<string, unknown>;
  return {
    providerAccountId: row.providerAccountId,
    providerTransactionId: row.providerTransactionId as string,
    security: (fact['security'] as ProviderInvestmentTransactionFact['security']) ?? null,
    providerSecurityId: row.providerSecurityId,
    date: DateOnly.parse(row.transactionDate as string),
    name: (fact['name'] as string | undefined) ?? '',
    type: (fact['type'] as string | undefined) ?? '',
    subtype: (fact['subtype'] as string | undefined) ?? '',
    quantity: row.quantity as string,
    price: row.price as string,
    amount: money(row.amountMinor as bigint, row.amountCurrency as string),
    fees: moneyOrNull(row.feesMinor, row.feesCurrency),
    raw: fact['raw'] ?? null,
    fingerprint: row.fingerprint as string,
  };
}
