// SPDX-License-Identifier: MIT
/**
 * The orchestrator's invariants, against a real Postgres.
 *
 * Every claim in `src/orchestrator.ts`'s header is a claim about a transaction
 * boundary, and a transaction boundary is not a thing a fake can have. These
 * tests therefore run against a scratch database, with a `LedgerWriter` double
 * that writes real rows through the executor it is handed (see `../harness.ts`)
 * so that a rollback rolls *its* rows back too. That is the whole reason the
 * double writes to a table instead of pushing onto an array: "the delta and the
 * cursor commit together" is only observable if both can fail to commit.
 *
 * The sabotage is deliberate and it is the point (see this repo's gate
 * lessons): each test breaks the adapter in one specific, realistic way — a
 * mutation mid-pagination, an expired cursor, a 429 with a `Retry-After`, a
 * failure injected between page two and page three — and asserts what the
 * database looks like afterwards. A test that only ever takes the happy road
 * would pass against an orchestrator with no transaction at all.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listSyncableConnections, requireConnection } from '../../src/connections.ts';
import { MAX_RESTARTS, SYNC_JOB_KIND } from '../../src/orchestrator.ts';
import { ConnectorError, type Connector } from '../../src/port.ts';
import { listSyncRuns } from '../../src/read.ts';
import type { SyncTrigger } from '../../schema/index.ts';
import {
  CORRELATION_ID,
  ManualConnector,
  ManualStore,
  NO_DATABASE,
  SeedConnector,
  connectionsDatabase,
  connectorWith,
  failingAtPage,
  generateDemoData,
  ledgerRowCounts,
  linkFor,
  manualBatch,
  orchestratorFor,
  type OrchestratorFixture,
  type TestDatabase,
} from '../harness.ts';

const ACCOUNTS = [
  {
    providerAccountId: 'acct-checking',
    name: 'Everyday Checking',
    type: 'depository',
    currency: 'USD',
  },
];

/** Ten transactions over four pages, so "page three" is a real place. */
const PAGE_SIZE = 3;
const ROW_COUNT = 10;

describe.skipIf(NO_DATABASE)('sync orchestration', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await connectionsDatabase('orchestrator');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    await database.truncate();
  });

  /**
   * A manual connection with `ROW_COUNT` transactions waiting, linked for real.
   *
   * `ManualConnector` declares `incremental_sync`, so it is a **cursor
   * provider**: the orchestrator accumulates its pages and commits the delta
   * and the cursor in one transaction (invariant 2). That is what most of these
   * tests are about, and the one test about the other branch builds its own
   * window provider below.
   */
  async function linkedManual(
    options: {
      patch?: (honest: ManualConnector) => Partial<Connector>;
      rows?: number;
      overrides?: Parameters<typeof orchestratorFor>[2];
    } = {},
  ): Promise<{
    fixture: OrchestratorFixture;
    connector: Connector;
    honest: ManualConnector;
    store: ManualStore;
    connectionId: string;
  }> {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    const connector =
      options.patch === undefined ? honest : connectorWith(honest, options.patch(honest));

    const fixture = await orchestratorFor(database, connector, options.overrides ?? {});
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Big Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(options.rows ?? ROW_COUNT) });

    return { fixture, connector, honest, store, connectionId };
  }

  function syncOnce(
    fixture: OrchestratorFixture,
    connectionId: string,
    trigger: SyncTrigger = 'scheduled',
  ): ReturnType<OrchestratorFixture['orchestrator']['syncConnection']> {
    return fixture.orchestrator.syncConnection({
      connectionId,
      userId: database.userId,
      trigger,
      correlationId: CORRELATION_ID,
    });
  }

  async function cursorOn(connectionId: string): Promise<string | null> {
    const row = await requireConnection(database.db, database.userId, connectionId);
    return row.transactionsCursor;
  }

  // -------------------------------------------------------------------------
  // Invariant 1 + 2: the delta and the cursor commit together, or not at all
  // -------------------------------------------------------------------------

  it("commits a cursor provider's whole delta and its cursor in one transaction", async () => {
    const { fixture, connectionId } = await linkedManual();

    const summary = await syncOnce(fixture, connectionId, 'initial');

    expect(summary.status).toBe('success');
    expect(summary.addedCount).toBe(ROW_COUNT);
    // Four pages fetched, one commit: `pageCount` counts what the provider sent,
    // not how many transactions we opened.
    expect(summary.pageCount).toBe(Math.ceil(ROW_COUNT / PAGE_SIZE));
    expect(await cursorOn(connectionId)).toBe(String(ROW_COUNT));

    const counts = await ledgerRowCounts(database);
    expect(counts.live).toBe(ROW_COUNT);
  });

  it('leaves no partial delta when a failure is injected mid-pagination', async () => {
    const { fixture, connectionId } = await linkedManual();

    // Page three of four. The rows from pages one and two are already inside the
    // open transaction when this fires, so if they survive, the commit is not
    // atomic and a crash mid-backfill would publish a prefix of a delta stream
    // that the provider may already have retracted.
    fixture.ledger.failOnTransaction('txn-0006', new Error('ledger exploded mid-delta'));

    const summary = await syncOnce(fixture, connectionId, 'initial');

    expect(summary.status).toBe('failed');
    expect(summary.error?.kind).toBe('permanent');
    // Nothing. Not "the first six rows", not "six rows and a cursor pointing at
    // ten" — nothing.
    expect(await ledgerRowCounts(database)).toMatchObject({ total: 0, live: 0 });
    expect(await cursorOn(connectionId)).toBeNull();

    const runs = await listSyncRuns(database.db, database.userId, connectionId);
    expect(runs[0]).toMatchObject({ status: 'failed', pageCount: 0, addedCount: 0 });
    // `cursor_after` is not on the read model — it is opaque to a client — so
    // the audit trail is checked against the column itself.
    const cursors = await database.db.execute<{ before: string | null; after: string | null }>(
      sql`SELECT cursor_before AS before, cursor_after AS after FROM sync_runs`,
    );
    expect(cursors.rows[0]).toEqual({ before: null, after: null });
  });

  it('never advances the cursor past what committed, for a window provider too', async () => {
    // A provider with no cursor model: a 90-day window pull, a file, a
    // statement scrape. Every page is independently true, so the orchestrator
    // commits each one — and the test is that the cursor then matches *exactly*
    // the rows that are in the table, never one page further.
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    const windowed = connectorWith(honest, {
      capabilities: () => ({
        ...honest.capabilities(),
        supports: honest.capabilities().supports.filter((c) => c !== 'incremental_sync'),
      }),
    });

    const fixture = await orchestratorFor(database, windowed);
    const { connectionId } = await linkFor(database, fixture, windowed, {
      displayName: 'Windowed Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(ROW_COUNT) });

    // Fails on the third page, after two pages have committed.
    fixture.ledger.failOnTransaction('txn-0006', new Error('ledger exploded on page three'));
    const summary = await syncOnce(fixture, connectionId, 'initial');

    // `partial`, not `failed`: pages did commit, and saying otherwise would make
    // the history view lie about where the data came from.
    expect(summary.status).toBe('partial');
    expect(summary.pageCount).toBe(2);

    const counts = await ledgerRowCounts(database);
    expect(counts.live).toBe(2 * PAGE_SIZE);
    // Six rows in, cursor at six. The invariant is the equality, not the number.
    expect(await cursorOn(connectionId)).toBe(String(2 * PAGE_SIZE));
  });

  // -------------------------------------------------------------------------
  // Invariant 3: a mutation during pagination restarts the loop from page one
  // -------------------------------------------------------------------------

  it('restarts the loop from the page-one cursor when the stream mutates', async () => {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    const mutation = ConnectorError.fromCondition(
      'MUTATION_DURING_PAGINATION',
      'a transaction posted while we were paging',
    );
    // Fail on the second call of the first attempt only.
    const { connector, log } = failingAtPage(honest, {
      failOnCall: (call) => (call === 2 ? mutation : null),
    });

    const fixture = await orchestratorFor(database, connector);
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Busy Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(ROW_COUNT) });

    const summary = await syncOnce(fixture, connectionId, 'initial');

    expect(summary.status).toBe('success');
    expect(summary.restartCount).toBe(1);
    // 01 §5.1: "the entire pagination request loop must be restarted beginning
    // with the cursor for the first page". Call 3 must therefore ask for the
    // run's starting cursor again — not for the cursor page one handed back,
    // which is what "retry the failed call" would do and what corrupts the
    // stream.
    expect(log.asked[0]).toBeNull();
    expect(log.asked[2]).toBeNull();
    // And the restart cost us nothing: every row arrived exactly once.
    expect(await ledgerRowCounts(database)).toMatchObject({ live: ROW_COUNT });
    expect(await cursorOn(connectionId)).toBe(String(ROW_COUNT));
  });

  it('gives up after MAX_RESTARTS rather than looping on a stream that keeps moving', async () => {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    const mutation = ConnectorError.fromCondition('MUTATION_DURING_PAGINATION', 'still moving');
    // Every second call of every attempt. An institution posting a transaction
    // every few seconds really does look like this.
    const { connector } = failingAtPage(honest, {
      failOnCall: (_call, cursor) => (cursor === '3' ? mutation : null),
    });

    const fixture = await orchestratorFor(database, connector);
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Very Busy Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(ROW_COUNT) });

    const summary = await syncOnce(fixture, connectionId, 'initial');

    expect(summary.status).toBe('failed');
    expect(summary.restartCount).toBe(MAX_RESTARTS);
    expect(summary.error?.condition).toBe('MUTATION_DURING_PAGINATION');
    // Nothing committed, because a cursor provider's delta only commits when the
    // stream ends — and it never did.
    expect(await ledgerRowCounts(database)).toMatchObject({ total: 0 });

    const runs = await listSyncRuns(database.db, database.userId, connectionId);
    // Non-zero `restart_count` in the history is the signal that an institution
    // is busy rather than that we have a bug (OWNERSHIP.md).
    expect(runs[0]).toMatchObject({ restartCount: MAX_RESTARTS, errorKind: 'transient' });
  });

  it('restarts from null on CURSOR_EXPIRED and heals by upsert, not by deleting', async () => {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    let expired = false;
    const connector = connectorWith(honest, {
      syncTransactions: async (handle, cursor, options) => {
        // The second run's first call, with the cursor the first run committed.
        if (!expired && cursor === String(ROW_COUNT)) {
          expired = true;
          throw ConnectorError.fromCondition('CURSOR_EXPIRED', 'that cursor is no longer valid');
        }
        return honest.syncTransactions(handle, cursor, options);
      },
    });

    const fixture = await orchestratorFor(database, connector);
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Forgetful Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(ROW_COUNT) });

    const first = await syncOnce(fixture, connectionId, 'initial');
    expect(first.status).toBe('success');
    expect(await ledgerRowCounts(database)).toMatchObject({ live: ROW_COUNT });

    const second = await syncOnce(fixture, connectionId);

    expect(second.status).toBe('success');
    expect(second.restartCount).toBe(1);
    // 08 §2.3 rule 4: recover by re-pulling into an idempotent upsert, *never*
    // by deleting data. So the whole stream arrived a second time and the table
    // is the same size it was.
    expect(await ledgerRowCounts(database)).toMatchObject({ live: ROW_COUNT, total: ROW_COUNT });

    const seen = await database.db.execute<{ max: string }>(
      sql`SELECT max(seen_count) AS max FROM ledger_double_applied`,
    );
    // ...and every row was genuinely re-offered, so this is the upsert working
    // rather than the re-pull quietly not happening.
    expect(Number(seen.rows[0]?.max)).toBe(2);
    expect(await cursorOn(connectionId)).toBe(String(ROW_COUNT));
  });

  // -------------------------------------------------------------------------
  // Invariant 4: auth_required stops, it does not retry
  // -------------------------------------------------------------------------

  it('moves to reauth_required, announces it, and stops the schedule', async () => {
    let calls = 0;
    const { fixture, connectionId } = await linkedManual({
      patch: () => ({
        syncTransactions: () => {
          calls += 1;
          return Promise.reject(
            ConnectorError.fromCondition('AUTH_REQUIRED', 'the item needs re-authentication', {
              providerCode: 'ITEM_LOGIN_REQUIRED',
            }),
          );
        },
      }),
    });

    const summary = await syncOnce(fixture, connectionId);

    expect(summary.status).toBe('failed');
    expect(summary.error?.kind).toBe('auth_required');
    // 04 §4.5: every further call is guaranteed to fail and burns the rate limit
    // the *reconnect* will need. Exactly one call, and no sleep.
    expect(calls).toBe(1);
    expect(fixture.sleeper.slept).toEqual([]);

    const row = await requireConnection(database.db, database.userId, connectionId);
    expect(row.status).toBe('reauth_required');
    expect(row.lastError).toMatchObject({
      kind: 'auth_required',
      providerCode: 'ITEM_LOGIN_REQUIRED',
      userActionRequired: true,
    });
    expect(row.errorSince).not.toBeNull();

    // The event 08 §1.3 calls `ConnectionReauthRequired`. It is published as a
    // `ConnectionStatusChanged` carrying `to: 'reauth_required'` — see
    // `src/events.ts` for why the three status events are one — so a consumer
    // subscribes once and switches on a field.
    const events = await database.db.execute<{ payload: { to: string; reason: string } }>(sql`
      SELECT payload FROM domain_events
       WHERE event_type = 'connections.ConnectionStatusChanged' ORDER BY seq
    `);
    expect(events.rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({ to: 'reauth_required', reason: 'auth_required' }),
    ]);

    // The nightly fan-out asks this question, and the answer is what actually
    // pauses the schedule.
    expect(await listSyncableConnections(database.db, database.userId)).toHaveLength(0);
    // The cursor and every row it describes are preserved: a reconnect resumes
    // rather than re-pulling 24 months (08 §3.9).
    expect(await cursorOn(connectionId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Rate limiting: honour the provider's own figure, and the daily budget
  // -------------------------------------------------------------------------

  it('waits exactly as long as a 429 asked for, then carries on', async () => {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: PAGE_SIZE });
    const limited = ConnectorError.fromCondition('RATE_LIMITED', '429 from the institution', {
      retryAfterMs: 30_000,
      providerCode: 'RATE_LIMIT',
    });
    const { connector } = failingAtPage(honest, {
      failOnCall: (call) => (call === 1 ? limited : null),
    });

    const fixture = await orchestratorFor(database, connector);
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Strict Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });
    store.append('item-1', { added: manualBatch(ROW_COUNT) });

    const summary = await syncOnce(fixture, connectionId, 'initial');

    expect(summary.status).toBe('success');
    // Not a jittered guess. A 429 that says "in 30 seconds" means 30 seconds:
    // guessing longer wastes the window, guessing shorter earns another 429.
    expect(fixture.sleeper.slept).toEqual([30_000]);
    expect(await ledgerRowCounts(database)).toMatchObject({ live: ROW_COUNT });
  });

  it('refuses to spend a refresh budget it has already used up', async () => {
    // SimpleFIN's is ~24/day and exceeding it disables the token (01 §2.2), so
    // the check is before the call, not after the error.
    const { fixture, connectionId } = await linkedManual({
      patch: (honest) => ({
        capabilities: () => ({ ...honest.capabilities(), refreshBudgetPerDay: 2 }),
      }),
    });

    expect((await syncOnce(fixture, connectionId, 'initial')).status).toBe('success');
    expect((await syncOnce(fixture, connectionId, 'manual')).status).toBe('success');

    const third = await syncOnce(fixture, connectionId, 'manual');

    // A `manual` trigger bypasses the politeness interval because the user is
    // standing there watching — but never the budget, because spending the last
    // request on an impatient click is how the nightly sync fails.
    expect(third.status).toBe('skipped');
    expect(third.skippedBecause).toBe('refresh_budget');
    expect(third.syncRunId).toBeNull();
    // A refusal is not an attempt, so it leaves no row to debit the budget twice.
    expect(await listSyncRuns(database.db, database.userId, connectionId)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Invariant 5: every attempt leaves a row
  // -------------------------------------------------------------------------

  it('writes one sync_runs row per attempt, with counts, timings and the error kind', async () => {
    let fail = false;
    const { fixture, connectionId, store } = await linkedManual({
      patch: (honest) => ({
        syncTransactions: async (handle, cursor, options) => {
          // Time passes inside the provider call, which is where it passes in
          // production too: `duration_ms` measured against a clock nothing ever
          // advances is a column that is always zero.
          fixture.clock.advanceMs(1_500);
          if (fail) throw ConnectorError.fromCondition('PROVIDER_DOWN', '503 from the institution');
          return honest.syncTransactions(handle, cursor, options);
        },
      }),
      overrides: { maxAttempts: 1 },
    });

    const first = await syncOnce(fixture, connectionId, 'initial');
    fail = true;
    const second = await syncOnce(fixture, connectionId, 'manual');
    fail = false;
    store.append('item-1', { added: manualBatch(2, '2026-07-01', 'acct-checking', 'later') });
    const third = await syncOnce(fixture, connectionId);

    const runs = await listSyncRuns(database.db, database.userId, connectionId);
    expect(runs).toHaveLength(3);

    // Newest first, which is the order the history view renders.
    expect(runs.map((run) => run.status)).toEqual(['success', 'failed', 'success']);
    expect(runs.map((run) => run.trigger)).toEqual(['scheduled', 'manual', 'initial']);
    expect(runs.map((run) => run.errorKind)).toEqual([null, 'provider_unavailable', null]);
    expect(runs[1]?.errorCode).toBe('PROVIDER_DOWN');

    for (const run of runs) {
      expect(run.finishedAt).not.toBeNull();
      expect(run.durationMs ?? 0).toBeGreaterThan(0);
    }

    // The cursor on both sides is the audit trail for the invariant that can
    // lose data silently (0005_connections.sql).
    expect(first.cursorBefore).toBeNull();
    expect(first.cursorAfter).toBe(String(ROW_COUNT));
    expect(second.cursorBefore).toBe(String(ROW_COUNT));
    expect(second.cursorAfter).toBe(String(ROW_COUNT));
    expect(third.addedCount).toBe(2);
  });

  it('records a run that failed before the first page, so it is not invisible', async () => {
    const { fixture, connectionId } = await linkedManual({
      patch: () => ({
        // `listAccounts` runs before the page loop. A failure here used to look
        // exactly like "the nightly job never fired".
        listAccounts: () =>
          Promise.reject(ConnectorError.fromCondition('PROVIDER_DOWN', 'down before we started')),
      }),
      overrides: { maxAttempts: 1 },
    });

    const summary = await syncOnce(fixture, connectionId);

    expect(summary.status).toBe('failed');
    expect(summary.pageCount).toBe(0);
    const runs = await listSyncRuns(database.db, database.userId, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', errorKind: 'provider_unavailable' });
  });

  // -------------------------------------------------------------------------
  // One sync per connection
  // -------------------------------------------------------------------------

  it('dedupes so a webhook, the schedule and a refresh click are one sync', async () => {
    const { fixture, connectionId } = await linkedManual();

    const enqueue = (trigger: 'scheduled' | 'manual' | 'webhook'): Promise<{ deduped: boolean }> =>
      database.db.transaction((tx) =>
        fixture.orchestrator.syncNow(tx, {
          connectionId,
          userId: database.userId,
          trigger,
          correlationId: CORRELATION_ID,
        }),
      );

    const first = await enqueue('scheduled');
    const second = await enqueue('webhook');
    const third = await enqueue('manual');

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(third.deduped).toBe(true);

    // 04 §4.4 calls two concurrent cursor loops on one connection "the fastest
    // way to corrupt cursor state". One row, keyed on the connection.
    const jobs = await database.db.execute<{ count: string; dedupe_key: string }>(sql`
      SELECT count(*) AS count, dedupe_key FROM jobs
       WHERE kind = ${SYNC_JOB_KIND} GROUP BY dedupe_key
    `);
    expect(jobs.rows).toHaveLength(1);
    expect(Number(jobs.rows[0]?.count)).toBe(1);
    expect(jobs.rows[0]?.dedupe_key).toBe(`${SYNC_JOB_KIND}:${connectionId}`);
  });

  it('keeps two different connections independent of each other', async () => {
    const { fixture, connector, connectionId } = await linkedManual();
    const other = await linkFor(database, fixture, connector, {
      displayName: 'Other Bank',
      providerConnectionId: 'item-2',
      accounts: [{ ...ACCOUNTS[0], providerAccountId: 'acct-other' }],
    });

    const enqueue = (id: string): Promise<{ deduped: boolean }> =>
      database.db.transaction((tx) =>
        fixture.orchestrator.syncNow(tx, {
          connectionId: id,
          userId: database.userId,
          trigger: 'scheduled',
          correlationId: CORRELATION_ID,
        }),
      );

    expect((await enqueue(connectionId)).deduped).toBe(false);
    // The dedupe key is per connection, not per kind: one slow institution must
    // not be able to stop another one syncing.
    expect((await enqueue(other.connectionId)).deduped).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  it('reconnects without losing a row, a cursor or an account identity', async () => {
    const { fixture, connector, connectionId, store } = await linkedManual();

    expect((await syncOnce(fixture, connectionId, 'initial')).addedCount).toBe(ROW_COUNT);
    const before = await ledgerRowCounts(database);

    // The user re-links after a reauth prompt: same institution, same provider
    // connection id, a fresh credential.
    const again = await linkFor(database, fixture, connector, {
      displayName: 'Big Bank',
      providerConnectionId: 'item-1',
      accounts: ACCOUNTS,
    });

    expect(again.connectionId).toBe(connectionId);
    expect(again.relinked).toBe(true);
    // 08 §3.9: "reconnect never creates duplicate accounts. Losing account
    // identity on reconnect is the classic way a personal finance app silently
    // doubles a user's net worth."
    expect(await ledgerRowCounts(database)).toMatchObject(before);
    // And it resumes rather than re-pulling 24 months.
    expect(await cursorOn(connectionId)).toBe(String(ROW_COUNT));

    store.append('item-1', { added: manualBatch(2, '2026-07-01', 'acct-checking', 'later') });
    const resumed = await syncOnce(fixture, connectionId, 'repair');

    expect(resumed.addedCount).toBe(2);
    expect(await ledgerRowCounts(database)).toMatchObject({
      live: ROW_COUNT + 2,
      accounts: before.accounts,
    });
  });

  // -------------------------------------------------------------------------
  // The seed dataset, end to end through the port
  // -------------------------------------------------------------------------

  it('delivers the demo dataset through the orchestrator, one ledger row per transaction', async () => {
    const dataset = generateDemoData(1);
    const connector = new SeedConnector({ pageSize: 250 });

    const fixture = await orchestratorFor(database, connector);
    // Link first, then stage. `connect` needs an account list and the manual
    // link schema speaks the ledger's six types, not the seed's vocabulary;
    // `load` then overwrites the store's account facts with the properly-mapped
    // ones, which is what `listAccounts` upserts on the first sync. The two
    // agree on `providerAccountId`, which is the key that matters.
    const { connectionId } = await linkFor(database, fixture, connector, {
      displayName: 'Demo data',
      providerConnectionId: 'seed-1',
      accounts: dataset.accounts.map((account) => ({
        providerAccountId: account.id,
        name: account.name,
        type: 'depository',
        currency: account.currency,
      })),
    });
    connector.load('seed-1', dataset, { asOf: new Date('2026-06-01T12:00:00.000Z') });

    const summary = await fixture.orchestrator.syncConnection({
      connectionId,
      userId: database.userId,
      trigger: 'initial',
      correlationId: CORRELATION_ID,
    });

    expect(summary.status).toBe('success');
    expect(summary.pageCount).toBeGreaterThan(1);

    // The dataset delivers a pending row and then retracts it in favour of the
    // posted one (01 §5.2's delete-plus-insert), so the arithmetic is the
    // assertion: every seed transaction ends as exactly **one** live ledger row,
    // whatever lifecycle it went through. That is decision D10, proved through
    // the orchestrator rather than asserted about the adapter.
    const settledFromPending = dataset.transactions.filter(
      (transaction) => transaction.pendingOn !== null && transaction.status === 'posted',
    ).length;

    const counts = await ledgerRowCounts(database);
    expect(counts.live).toBe(dataset.transactions.length);
    expect(counts.retracted).toBe(settledFromPending);
    expect(counts.total).toBe(dataset.transactions.length + settledFromPending);
    expect(counts.accounts).toBe(dataset.accounts.length);
    expect(summary.removedCount).toBe(settledFromPending);

    // Every row carries a currency, and the sign convention survived the trip.
    const money = await database.db.execute<{ no_currency: string; outflows: string }>(sql`
      SELECT count(*) FILTER (WHERE currency IS NULL OR btrim(currency) = '') AS no_currency,
             count(*) FILTER (WHERE amount_minor < 0) AS outflows
        FROM ledger_double_applied
    `);
    expect(Number(money.rows[0]?.no_currency)).toBe(0);
    expect(Number(money.rows[0]?.outflows)).toBeGreaterThan(0);

    // A second run is a no-op: the stream is exhausted and the cursor says so.
    const again = await fixture.orchestrator.syncConnection({
      connectionId,
      userId: database.userId,
      trigger: 'scheduled',
      correlationId: CORRELATION_ID,
    });
    expect(again.addedCount).toBe(0);
    expect(await ledgerRowCounts(database)).toMatchObject({ live: counts.live });
  }, 120_000);
});
