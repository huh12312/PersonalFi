// SPDX-License-Identifier: MIT
/**
 * The `@ctx/connections` test harness.
 *
 * `@core/testkit`, `@core/seed`, `@connector/manual` and `@connector/csv` are
 * dev-only dependencies of this context, declared as `devDependencies` and
 * allowed by the `connections` entry in `scripts/eslint-boundaries.js` rather
 * than by an `eslint-disable` here — so the looseness is visible in the policy
 * instead of hidden in a comment at the top of a test file. No file under
 * `src/` imports any of them.
 *
 * ## The `LedgerWriter` double, and what it can and cannot prove
 *
 * The boundary lint denies `@ctx/connections` → `@ctx/ledger` unconditionally
 * (see `src/ledger-writer.ts`), so these tests cannot call the real
 * `applyProviderTransactions`. `recordingLedgerWriter` is the stand-in, and it
 * is built to make that limitation as small as possible:
 *
 *   * It **writes to a real table** (`ledger_double_applied`, created by the
 *     harness in the scratch database) using the executor it is handed. So it
 *     participates in the orchestrator's per-page transaction for real — a
 *     rollback rolls its rows back too, which is precisely what the atomicity
 *     test needs to observe.
 *   * It is **idempotent on the natural key** `(account_id, provider,
 *     provider_transaction_id)`, exactly as `transactions_provider`'s unique
 *     index is. So "replaying a page changes nothing" is testable here.
 *
 * What it cannot prove is that the real ledger's signatures still match the
 * port. That check lives at the composition root and is WP 1.5's; it is written
 * up as deferred in the evidence note.
 */
import { CSV_MANIFEST, CsvImportConnector, type CsvFileInput } from '@connector/csv';
import {
  MANUAL_MANIFEST,
  ManualConnector,
  ManualStore,
  SEED_MANIFEST,
  SeedConnector,
  manualTransaction,
  type ManualTransactionInput,
} from '@connector/manual';
import type {
  ConnectionHandle,
  Connector,
  ConnectorManifest,
  ProviderAccountFact,
  ProviderTransactionFact,
  SyncOptions,
} from '@connector/port';
import { DateOnly, money, mutableClock, newId, type MutableClock } from '@core/kernel';
import type { Sleeper } from '@core/platform';
import { generateDemoData } from '@core/seed';
import { SecretBox } from '@core/secretbox';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { createConnection } from '../src/connections.ts';
import { ConnectorRegistry } from '../src/registry.ts';
import { SyncOrchestrator, type SyncOrchestratorOptions } from '../src/orchestrator.ts';
import type { ConnectionsExecutor } from '../src/db.ts';
import type {
  LedgerApplyInput,
  LedgerApplyResult,
  LedgerRecordBalanceInput,
  LedgerUpsertAccountInput,
  LedgerUpsertAccountResult,
  LedgerWriteContext,
  LedgerWriter,
} from '../src/ledger-writer.ts';

export { ADMIN_URL, generateDemoData, manualTransaction, type TestDatabase };
export { CsvImportConnector, ManualConnector, ManualStore, SeedConnector };
export { CSV_MANIFEST, MANUAL_MANIFEST, SEED_MANIFEST };
export type { CsvFileInput, ManualTransactionInput };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** The instant every suite starts at, so a failure message reads the same twice. */
export const EPOCH = '2026-06-01T12:00:00.000Z';
export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c2';
/** Long enough that Argon2id is not the slowest thing in the suite. */
const TEST_KDF = { memoryKiB: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

export function testClock(): MutableClock {
  return mutableClock(EPOCH);
}

/** A scratch database with a unique name per run, so two runs never collide. */
export async function connectionsDatabase(suite: string): Promise<TestDatabase> {
  const unique = newId().replaceAll('-', '').slice(-12);
  const database = await createTestDatabase(`personalfi_conn_${suite}_${unique}`);
  await database.db.execute(sql`
    CREATE TABLE ledger_double_applied (
      id                      UUID PRIMARY KEY,
      user_id                 UUID NOT NULL,
      account_id              UUID NOT NULL,
      provider                TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL,
      amount_minor            BIGINT NOT NULL,
      currency                CHAR(3) NOT NULL,
      pending                 BOOLEAN NOT NULL,
      pending_transaction_id  TEXT,
      removed_at              TIMESTAMPTZ,
      seen_count              INTEGER NOT NULL DEFAULT 1,
      UNIQUE (account_id, provider, provider_transaction_id)
    );
    CREATE TABLE ledger_double_accounts (
      id                  UUID PRIMARY KEY,
      user_id             UUID NOT NULL,
      provider            TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      name                TEXT NOT NULL,
      currency            CHAR(3) NOT NULL,
      UNIQUE (user_id, provider, provider_account_id)
    );
    CREATE TABLE ledger_double_balances (
      id         UUID PRIMARY KEY,
      user_id    UUID NOT NULL,
      account_id UUID NOT NULL,
      minor      BIGINT NOT NULL,
      currency   CHAR(3) NOT NULL,
      as_of      TIMESTAMPTZ NOT NULL,
      source     TEXT NOT NULL,
      UNIQUE (account_id, as_of, source)
    );
  `);
  return database;
}

export async function unlockedSecretBox(database: TestDatabase): Promise<SecretBox> {
  const box = new SecretBox({
    db: database.pool,
    userId: database.userId,
    clock: testClock(),
    kdfParams: TEST_KDF,
    kdfFloor: TEST_KDF,
  });
  await box.unlock('a passphrase that exists only in this test');
  return box;
}

/** Counts what the double was asked to do, for assertions that need no SQL. */
export interface LedgerCalls {
  applies: LedgerApplyInput[];
  upserts: LedgerUpsertAccountInput[];
  balances: LedgerRecordBalanceInput[];
}

export interface RecordingLedgerWriter extends LedgerWriter {
  readonly calls: LedgerCalls;
  /** Make the next `applyProviderTransactions` throw. One shot. */
  failNextApply(error: unknown): void;
  /** Throw whenever a page contains this provider transaction id. One shot. */
  failOnTransaction(providerTransactionId: string, error: unknown): void;
}

export function recordingLedgerWriter(): RecordingLedgerWriter {
  const calls: LedgerCalls = { applies: [], upserts: [], balances: [] };
  let nextFailure: unknown = null;
  let failOn: { id: string; error: unknown } | null = null;

  return {
    calls,
    failNextApply(error) {
      nextFailure = error;
    },
    failOnTransaction(providerTransactionId, error) {
      failOn = { id: providerTransactionId, error };
    },

    async applyProviderTransactions(
      executor: ConnectionsExecutor,
      input: LedgerApplyInput,
    ): Promise<LedgerApplyResult> {
      calls.applies.push(input);

      const incoming = [...(input.added ?? []), ...(input.modified ?? [])];
      if (failOn !== null && incoming.some((f) => f.providerTransactionId === failOn?.id)) {
        const error = failOn.error;
        failOn = null;
        throw error;
      }
      if (nextFailure !== null) {
        const error = nextFailure;
        nextFailure = null;
        throw error;
      }

      const added: string[] = [];
      const updated: string[] = [];
      let unchanged = 0;

      for (const fact of incoming) {
        const result = await executor.execute<{ id: string; seen_count: number }>(sql`
          INSERT INTO ledger_double_applied (
            id, user_id, account_id, provider, provider_transaction_id,
            amount_minor, currency, pending, pending_transaction_id, removed_at
          ) VALUES (
            ${newId()}::uuid, ${input.userId}::uuid, ${input.accountId}::uuid, ${input.provider},
            ${fact.providerTransactionId}, ${fact.amount.minor.toString()}::bigint,
            ${fact.amount.currency}, ${fact.pending}, ${fact.pendingTransactionId}, NULL
          )
          ON CONFLICT (account_id, provider, provider_transaction_id) DO UPDATE
            SET seen_count = ledger_double_applied.seen_count + 1,
                amount_minor = excluded.amount_minor,
                pending = excluded.pending,
                removed_at = NULL
          RETURNING id, seen_count
        `);
        const seen = Number(result.rows[0]?.seen_count ?? 1);
        if (seen === 1) added.push(fact.providerTransactionId);
        else if (
          // The natural key already existed: an update if anything moved, and a
          // no-op otherwise. This mirrors the ledger's content-hash layer
          // closely enough for "replaying a page changes nothing" to mean
          // something here.
          incoming.some(
            (candidate) => candidate.providerTransactionId === fact.providerTransactionId,
          )
        ) {
          updated.push(fact.providerTransactionId);
          unchanged += 1;
        }
      }

      const removed: string[] = [];
      for (const providerTransactionId of input.removed ?? []) {
        const result = await executor.execute<{ id: string }>(sql`
          UPDATE ledger_double_applied
             SET removed_at = now()
           WHERE account_id = ${input.accountId}::uuid
             AND provider = ${input.provider}
             AND provider_transaction_id = ${providerTransactionId}
             AND removed_at IS NULL
          RETURNING id
        `);
        if (result.rows.length > 0) removed.push(providerTransactionId);
      }

      return {
        addedTransactionIds: added,
        updatedTransactionIds: updated,
        removedTransactionIds: removed,
        unchangedFactCount: unchanged,
      };
    },

    async upsertAccount(
      executor: ConnectionsExecutor,
      input: LedgerUpsertAccountInput,
      _context: LedgerWriteContext,
    ): Promise<LedgerUpsertAccountResult> {
      calls.upserts.push(input);
      const id = newId();
      const result = await executor.execute<{ id: string; inserted: boolean }>(sql`
        INSERT INTO ledger_double_accounts (id, user_id, provider, provider_account_id, name, currency)
        VALUES (${id}::uuid, ${input.userId}::uuid, ${input.provider}, ${input.providerAccountId},
                ${input.name}, ${input.currency})
        ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE SET name = excluded.name
        RETURNING id, (xmax = 0) AS inserted
      `);
      const row = result.rows[0];
      return {
        accountId: row?.id ?? id,
        created: row?.inserted === true,
        changedFields: [],
      };
    },

    async recordBalance(
      executor: ConnectionsExecutor,
      input: LedgerRecordBalanceInput,
      _context: LedgerWriteContext,
    ): Promise<{ balanceId: string | null; recorded: boolean }> {
      calls.balances.push(input);
      const id = newId();
      // `RETURNING id` is what makes this double honest about idempotency: the
      // real `recordBalance` reports `recorded: false` on a natural-key
      // collision, and the orchestrator's balances count (`sync_runs.added_
      // count`) depends on being able to tell a genuine insert from a replay.
      const result = await executor.execute<{ id: string }>(sql`
        INSERT INTO ledger_double_balances (id, user_id, account_id, minor, currency, as_of, source)
        VALUES (${id}::uuid, ${input.userId}::uuid, ${input.accountId}::uuid,
                ${input.current.minor.toString()}::bigint, ${input.current.currency},
                ${input.asOf.toISOString()}::timestamptz, ${input.source})
        ON CONFLICT (account_id, as_of, source) DO NOTHING
        RETURNING id
      `);
      const recorded = result.rows.length > 0;
      return { balanceId: recorded ? id : null, recorded };
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter fixtures
// ---------------------------------------------------------------------------

export const TEST_ACCOUNT: ProviderAccountFact = Object.freeze({
  providerAccountId: 'acct-checking',
  name: 'Everyday Checking',
  officialName: null,
  type: 'depository',
  subtype: 'checking',
  currency: 'USD',
  mask: '4471',
  closed: false,
  capabilities: ['accounts', 'balances', 'transactions'] as const,
});

export function syncOptions(clock: MutableClock): SyncOptions {
  return {
    reason: 'scheduled',
    historyDays: 730,
    pageSize: 500,
    deadline: new Date(clock.nowMs() + 60_000),
    signal: new AbortController().signal,
    clock,
  };
}

/** A handle for an adapter used outside a database, as the conformance suite does. */
export function bareHandle(providerConnectionId: string, provider: string): ConnectionHandle {
  return {
    connectionId: newId(),
    userId: '01920000-0000-7000-8000-0000000000aa',
    provider,
    providerConnectionId,
    secret: () => null,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator fixtures
// ---------------------------------------------------------------------------

/**
 * A sleeper that records what it was asked to wait and never actually waits.
 *
 * The recording is the assertion: "RATE_LIMITED honours `retryAfterMs`" is a
 * claim about a number this function was called with, and a test that really
 * slept thirty seconds to prove it would be a test nobody runs.
 */
export interface RecordingSleeper extends Sleeper {
  readonly slept: number[];
}

export function recordingSleeper(): RecordingSleeper {
  const slept: number[] = [];
  return {
    slept,
    sleep(ms) {
      slept.push(ms);
      return Promise.resolve();
    },
    wake() {
      /* nothing is ever pending */
    },
  };
}

/** A manifest for a connector the tests built. The registry insists on one. */
export function manifestFor(connector: Connector): ConnectorManifest {
  return {
    provider: connector.provider,
    displayName: connector.displayName,
    description: 'A connector that exists only inside this suite.',
    iconKey: 'beaker',
    linkKind: 'manual_entry',
    docsUrl: null,
  };
}

/**
 * Wrap an adapter so a test can break it in one specific way.
 *
 * A forwarding `Proxy`, not `Object.assign` onto a fresh prototype-sharing
 * object. The difference matters and it is not stylistic: `ManualConnector`
 * keeps its store in a `#private` field, and a private field belongs to the
 * instance it was installed on. A copy therefore inherits the *methods* and
 * none of the state, and every un-patched call dies with "cannot read private
 * member #store from an object whose class did not declare it" — a failure
 * about the double rather than about the orchestrator. Binding each forwarded
 * method back to the real instance keeps the double a real adapter with one
 * thing wrong with it, which is the only kind of sabotage worth asserting on.
 */
export function connectorWith<TConnector extends Connector>(
  honest: TConnector,
  patch: Partial<Connector>,
): TConnector {
  return new Proxy(honest, {
    get(target, property, _receiver) {
      if (Object.hasOwn(patch, property)) {
        return (patch as Record<string | symbol, unknown>)[property];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

/** The cursors an adapter was asked for, in order. The restart tests read this. */
export interface CursorLog {
  readonly asked: (string | null)[];
}

/**
 * An adapter that fails on the `failOnPage`-th call of each attempt.
 *
 * `plan` is consumed one failure per call, so `[error, error, null]` means "fail
 * the first two attempts and then behave". Every call is recorded, which is what
 * makes "the loop restarted from the page-one cursor" an assertion about the
 * argument the adapter received rather than about a counter we incremented.
 */
export function failingAtPage<TConnector extends Connector>(
  honest: TConnector,
  options: { readonly failOnCall: (call: number, cursor: string | null) => unknown | null },
): { connector: TConnector; log: CursorLog } {
  const asked: (string | null)[] = [];
  let call = 0;
  const connector = connectorWith(honest, {
    syncTransactions: async (handle, cursor, syncOptions) => {
      call += 1;
      asked.push(cursor);
      const failure = options.failOnCall(call, cursor);
      if (failure !== null) throw failure;
      return honest.syncTransactions(handle, cursor, syncOptions);
    },
  });
  return { connector, log: { asked } };
}

/** Everything `syncConnection` needs, wired against the scratch database. */
export interface OrchestratorFixture {
  readonly orchestrator: SyncOrchestrator;
  readonly ledger: RecordingLedgerWriter;
  readonly sleeper: RecordingSleeper;
  readonly clock: MutableClock;
  readonly registry: ConnectorRegistry;
  readonly secretBox: SecretBox;
}

export async function orchestratorFor(
  database: TestDatabase,
  connector: Connector,
  overrides: Partial<SyncOrchestratorOptions> = {},
): Promise<OrchestratorFixture> {
  const clock = testClock();
  const ledger = recordingLedgerWriter();
  const sleeper = recordingSleeper();
  const secretBox = await unlockedSecretBox(database);
  const registry = new ConnectorRegistry([{ connector, manifest: manifestFor(connector) }]);

  const orchestrator = new SyncOrchestrator({
    database: database.db,
    registry,
    secretBox,
    ledgerWriter: ledger,
    clock,
    sleeper,
    // Backoff is `@core/platform`'s and already property-tested there. Pinning
    // the draw to zero here keeps an unrelated regression in the jitter from
    // failing an orchestrator test.
    random: () => 0,
    ...overrides,
  });

  return { orchestrator, ledger, sleeper, clock, registry, secretBox };
}

/**
 * Link `connector` and return the connection the orchestrator will sync.
 *
 * The real `createConnection`, not an `INSERT`: the tests that matter here are
 * about what a *linked* connection does, and a row assembled by hand would not
 * have the sealed credential, the account mapping or the `ConnectionCreated`
 * event that the reconnect test asserts on.
 */
export async function linkFor(
  database: TestDatabase,
  fixture: OrchestratorFixture,
  connector: Connector,
  input: unknown,
): Promise<{ connectionId: string; relinked: boolean; accountIds: readonly string[] }> {
  return database.db.transaction((tx) =>
    createConnection(
      tx,
      { connector, secretBox: fixture.secretBox, ledgerWriter: fixture.ledger, input },
      { userId: database.userId, clock: fixture.clock, correlationId: CORRELATION_ID },
    ),
  );
}

/** Rows the ledger double holds, live and retracted. */
export async function ledgerRowCounts(
  database: TestDatabase,
): Promise<{ total: number; live: number; retracted: number; accounts: number }> {
  const applied = await database.db.execute<{ total: string; live: string }>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE removed_at IS NULL) AS live
      FROM ledger_double_applied
  `);
  const accounts = await database.db.execute<{ count: string }>(
    sql`SELECT count(*) AS count FROM ledger_double_accounts`,
  );
  const total = Number(applied.rows[0]?.total ?? 0);
  const live = Number(applied.rows[0]?.live ?? 0);
  return { total, live, retracted: total - live, accounts: Number(accounts.rows[0]?.count ?? 0) };
}

/** How many balance observations the double actually holds, for the balances tests. */
export async function ledgerBalanceCount(database: TestDatabase): Promise<number> {
  const result = await database.db.execute<{ count: string }>(
    sql`SELECT count(*) AS count FROM ledger_double_balances`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * A batch of manual transactions, `count` of them, one per day from `from`.
 *
 * `idPrefix` exists because a test that appends a *second* batch is testing
 * resumption, and reusing `txn-0000` would make those rows upserts of the first
 * batch rather than new ones — which is a silently passing test for the wrong
 * reason, not a failure.
 */
export function manualBatch(
  count: number,
  from = '2026-05-01',
  providerAccountId = TEST_ACCOUNT.providerAccountId,
  idPrefix = 'txn',
): ProviderTransactionFact[] {
  return Array.from({ length: count }, (_unused, index) =>
    manualTransaction({
      providerAccountId,
      providerTransactionId: `${idPrefix}-${String(index).padStart(4, '0')}`,
      amount: money(BigInt(-100 * (index + 1)), 'USD'),
      postedDate: DateOnly.addDays(DateOnly.parse(from), index),
      name: `MERCHANT ${index}`,
    }),
  );
}
