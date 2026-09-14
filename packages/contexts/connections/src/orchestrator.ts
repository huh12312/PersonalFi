// SPDX-License-Identifier: MIT
/**
 * `SyncOrchestrator` — the page loop, and the five invariants it exists to hold.
 *
 * ## 1. The cursor never advances outside the write transaction
 *
 * Every page is `BEGIN; apply to ledger; UPDATE connections SET
 * transactions_cursor; UPDATE sync_runs; COMMIT`. This is the one bug in a sync
 * engine that loses data *silently and permanently*: a cursor that commits while
 * its rows do not means the provider has moved on and will never resend them
 * (01 §5.1, 04 §4.2). `applyPage` below is the only place the cursor is written,
 * and it takes the transaction handle, so there is no signature that could
 * write it anywhere else.
 *
 * ## 2. Commit granularity follows the cursor, not the page
 *
 * 08 §2.3 rule 2 reads "per page"; 01 §5.1 and 04 §4.2 read "accumulate every
 * page and commit once", because that is Plaid's documented instruction. They
 * are not in conflict once you notice that they are talking about two different
 * kinds of provider, and this implementation branches on exactly that — the
 * `incremental_sync` capability, which is the adapter's own declaration that it
 * has a cursor:
 *
 *   * **Cursor providers accumulate.** `/transactions/sync` is a *delta stream*:
 *     page 3 may retract a row page 1 added, so no prefix of the stream is a
 *     consistent statement of anything. Committing page 1 alone publishes a
 *     transaction the provider has already withdrawn. So the run holds every
 *     page, and one transaction writes the whole delta **and** the final cursor.
 *     That is Plaid's rule and it is also the only granularity at which
 *     "mutation during pagination" (invariant 3) is recoverable without having
 *     published rows from a stream we then decide to discard.
 *   * **Window providers commit per page.** A file import, a manual log, a
 *     90-day window pull: every page is independently true, `nextCursor` is a
 *     position rather than a delta token, and a 730-day backfill (D16) is
 *     thousands of rows. Holding one transaction open across sixty round trips
 *     to a provider locks `transactions` for the whole of it, against a
 *     five-minute budget for the nightly sync (plan §3.4). 04 §4.7 says as much:
 *     "chunk the writes (~500/transaction) to avoid long-running locks."
 *
 * Neither ever advances a cursor outside the write transaction. `#commitPages`
 * below is the only place `transactions_cursor` is written, and it takes the
 * pages and the cursor together, so there is no signature that could commit one
 * without the other.
 *
 * ## 3. A mutation during pagination restarts the whole loop
 *
 * Not the failed call — the loop, from the cursor the run started with
 * (01 §5.1: "the entire pagination request loop must be restarted beginning with
 * the cursor for the first page"). For a cursor provider nothing has been
 * committed yet, so the restart is free: the accumulated pages are dropped and
 * the loop begins again. For a window provider the connection's stored cursor is
 * rewound to that value **in its own transaction** before the retry, so a crash
 * during the restart resumes from page one rather than from the middle of a
 * stream we have already decided to discard.
 *
 * Bounded by `MAX_RESTARTS` (04 §4.2). An institution posting a transaction
 * every few seconds can invalidate a page sequence indefinitely; three attempts
 * and then a `partial`/`failed` run in the history is an answer, and an
 * unbounded loop is not.
 *
 * ## 4. `auth_required` stops, it does not retry
 *
 * Every further call is guaranteed to fail and burns the rate limit the
 * *reconnect* will need (04 §4.5). The connection goes to `reauth_required`, the
 * cursor and every row are preserved, and the job returns normally so the queue
 * does not retry it either.
 *
 * ## 5. Every attempt leaves a row
 *
 * Success, failure, and the failures that happen before the first page. 08 §6.3:
 * "`sync_runs` is the observability surface that matters… This single feature
 * eliminates most 'why is my balance wrong' debugging." A run that never started
 * and a run that failed look identical from the outside otherwise.
 */
import { newId, type Clock } from '@core/kernel';
import {
  DEFAULT_JOB_BACKOFF,
  appendEvent,
  backoffDelayMs,
  createSleeper,
  defineJob,
  enqueueJob,
  silentLogger,
  upsertSchedule,
  type BackoffOptions,
  type JobHandlerRegistration,
  type PlatformLogger,
  type Sleeper,
} from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import { and, eq, gte, sql } from 'drizzle-orm';
import { connections, syncRuns, type SyncRunStatus, type SyncTrigger } from '../schema/index.ts';
import {
  accountMap,
  linkAccounts,
  openHandle,
  requireConnection,
  setConnectionStatus,
} from './connections.ts';
import {
  platformOf,
  type ConnectionsContext,
  type ConnectionsDatabase,
  type ConnectionsExecutor,
} from './db.ts';
import { ConnectionsError } from './errors.ts';
import { SyncRunCompleted } from './events.ts';
import type { LedgerWriter } from './ledger-writer.ts';
import {
  ConnectorError,
  asConnectorError,
  cursorOf,
  supports,
  type ConnectionHandle,
  type Connector,
  type ProviderTransactionFact,
  type SyncOptions,
  type TransactionPage,
} from './port.ts';
import type { ConnectorRegistry } from './registry.ts';

/** The job kind. Lower-snake, dotted, as `enqueueJob` requires. */
export const SYNC_JOB_KIND = 'connections.sync';
/** The nightly schedule's name. `schedule:<name>:<fire time>` dedupes the job. */
export const NIGHTLY_SCHEDULE_NAME = 'connections.nightly_sync';
/** 03:15 local, per 08 §3.7. The scheduler adds jitter. */
export const NIGHTLY_CRON = '15 3 * * *';

/** D16/01 §5.1: 730 explicitly, or the next sync silently loses ~21 months. */
export const DEFAULT_HISTORY_DAYS = 730;
/** Plaid's ceiling, adopted so every adapter sees one shape. */
export const DEFAULT_PAGE_SIZE = 500;
/**
 * 08 §6.2's `max_attempts: 5` for the sync job, applied inside the run too.
 *
 * The job queue's own `max_attempts` governs whole re-runs; this governs
 * in-process retries of the page loop. Both are five so a provider that is down
 * is given the same patience wherever the retry happens to be counted.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * 04 §4.2's `MAX_RESTARTS`. Counted separately from `maxAttempts`.
 *
 * A rate limit is worth five waits; a stream that keeps mutating under us is
 * worth three restarts and then an honest `partial` in the history. Sharing one
 * counter would let a busy institution consume the budget a genuinely transient
 * failure needs.
 */
export const MAX_RESTARTS = 3;
/** 08 §3.7's per-connection budget. */
export const DEFAULT_DEADLINE_MS = 10 * 60 * 1_000;
/**
 * A page that returns `hasMore` forever is a broken adapter, and a loop that
 * trusts it is an unbounded write. 2,000 pages at 500 rows is a million
 * transactions — comfortably past any real backfill.
 */
export const MAX_PAGES = 2_000;

export interface SyncOrchestratorOptions {
  readonly database: ConnectionsDatabase;
  readonly registry: ConnectorRegistry;
  readonly secretBox: SecretBox;
  readonly ledgerWriter: LedgerWriter;
  readonly clock: Clock;
  readonly logger?: PlatformLogger;
  readonly sleeper?: Sleeper;
  /** Injected so a backoff test is deterministic and an incident reproducible. */
  readonly random?: () => number;
  readonly backoff?: BackoffOptions;
  readonly maxAttempts?: number;
  readonly historyDays?: number;
  readonly pageSize?: number;
  readonly deadlineMs?: number;
}

export interface SyncConnectionInput {
  readonly connectionId: string;
  readonly userId: string;
  readonly trigger: SyncTrigger;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface SyncRunSummary {
  readonly syncRunId: string | null;
  readonly connectionId: string;
  readonly status: SyncRunStatus | 'skipped';
  readonly pageCount: number;
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly removedCount: number;
  readonly restartCount: number;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly durationMs: number;
  readonly error: ConnectorError | null;
  /** Set when the pre-flight refused to start: a budget or an interval floor. */
  readonly skippedBecause: 'min_interval' | 'refresh_budget' | null;
}

interface Counters {
  pages: number;
  added: number;
  modified: number;
  removed: number;
  restarts: number;
}

export class SyncOrchestrator {
  readonly #options: SyncOrchestratorOptions;
  readonly #logger: PlatformLogger;
  readonly #sleeper: Sleeper;

  constructor(options: SyncOrchestratorOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#sleeper = options.sleeper ?? createSleeper();
  }

  /**
   * Enqueue a sync. The "refresh" button, and what the schedule fires.
   *
   * Takes an executor so it can be called inside the transaction that created
   * the connection: a link that committed without its backfill queued is a
   * connection that looks linked and never syncs. The dedupe key is what stops
   * a webhook, the nightly schedule and a user clicking refresh from starting
   * three concurrent cursor loops on one connection — which 04 §4.4 calls "the
   * fastest way to corrupt cursor state".
   */
  async syncNow(
    executor: ConnectionsExecutor,
    input: { connectionId: string; userId: string; trigger: SyncTrigger; correlationId: string },
  ): Promise<{ jobId: string; deduped: boolean }> {
    const result = await enqueueJob(
      platformOf(executor),
      {
        userId: input.userId,
        kind: SYNC_JOB_KIND,
        payload: { connectionId: input.connectionId, trigger: input.trigger },
        dedupeKey: `${SYNC_JOB_KIND}:${input.connectionId}`,
        // ...and a singleton on the same key, so two syncs of one connection
        // cannot run concurrently even if the dedupe window has closed between
        // them. Two cursor loops on one connection is the failure this prevents.
        singletonKey: `${SYNC_JOB_KIND}:${input.connectionId}`,
        priority: input.trigger === 'manual' ? 10 : 100,
        correlationId: input.correlationId,
      },
      { clock: this.#options.clock },
    );
    return { jobId: result.id, deduped: result.deduped };
  }

  /** The handler `apps/api`'s worker registers. Registered by `defineJob`. */
  jobHandler(): JobHandlerRegistration {
    return defineJob<{ connectionId?: string; trigger?: SyncTrigger }>(
      SYNC_JOB_KIND,
      async (payload, context) => {
        if (typeof payload.connectionId !== 'string') {
          throw new ConnectionsError('connections.not_found', 'sync job has no connectionId');
        }
        const summary = await this.syncConnection({
          connectionId: payload.connectionId,
          userId: context.userId,
          trigger: payload.trigger ?? 'scheduled',
          correlationId: context.correlationId,
          signal: context.signal,
        });

        // The division of labour with the job runner: *this* throws only when a
        // retry could help, because a throw is what makes the runner back off
        // and try again. A non-retryable failure — auth_required, a bad file,
        // a permanent provider refusal — is already recorded in `sync_runs` and
        // on the connection's status, and retrying it five times would burn rate
        // limit to reach the same answer.
        if (summary.error !== null && summary.error.policy().retryable) throw summary.error;
      },
      // One per connection is enforced by the singleton key; this caps the
      // process. 08 §6.2: sync <= 2 global.
      { concurrency: 2, backoff: this.#options.backoff ?? DEFAULT_JOB_BACKOFF },
    );
  }

  /**
   * Declare the nightly schedule.
   *
   * Called at boot by whichever module owns the work, and *not* called when
   * `module.connections` is off — that is what "a disabled module registers no
   * consumers and no schedules" means in practice.
   */
  registerNightlySchedule(
    executor: ConnectionsExecutor,
    input: { userId: string; timezone: string; cron?: string; enabled?: boolean },
  ): Promise<string> {
    return upsertSchedule(
      platformOf(executor),
      {
        userId: input.userId,
        name: NIGHTLY_SCHEDULE_NAME,
        cron: input.cron ?? NIGHTLY_CRON,
        timezone: input.timezone,
        jobKind: SYNC_FANOUT_JOB_KIND,
        jobPayload: {},
        enabled: input.enabled ?? true,
        // 08 §3.7: "03:15 local, jittered +/-20m". Ten institutions all polled at
        // the same second look like a scraper; spread out they look like a user.
        jitterSeconds: 20 * 60,
      },
      this.#options.clock,
    );
  }

  /**
   * Run one connection's transaction sync, end to end.
   *
   * Never throws for a provider failure: the failure is the return value, in
   * `summary.error`, because every caller needs the counts and the run id
   * whether it succeeded or not. It *does* throw for a domain failure — no such
   * connection, no such provider — which is a bug or a misconfiguration and not
   * something to write a sync-run row about.
   */
  async syncConnection(input: SyncConnectionInput): Promise<SyncRunSummary> {
    const { clock, database, registry, secretBox } = this.#options;
    const startedAt = clock.now();
    const context: ConnectionsContext = {
      userId: input.userId,
      clock,
      correlationId: input.correlationId,
    };

    const row = await requireConnection(database, input.userId, input.connectionId);
    if (row.status === 'disconnected') {
      throw new ConnectionsError(
        'connections.already_disconnected',
        `connection ${input.connectionId} is disconnected`,
      );
    }
    const connector = registry.get(row.provider);
    const capabilities = connector.capabilities();

    const refusal = await this.#preflight(row.id, row.lastSyncedAt, capabilities, input.trigger);
    if (refusal !== null) {
      this.#logger.info(
        { connectionId: row.id, reason: refusal, correlationId: input.correlationId },
        'sync skipped',
      );
      return blank(input.connectionId, row.transactionsCursor, refusal);
    }

    const syncRunId = newId();
    await database.insert(syncRuns).values({
      id: syncRunId,
      userId: input.userId,
      connectionId: row.id,
      trigger: input.trigger,
      operation: 'transactions',
      status: 'running',
      cursorBefore: row.transactionsCursor,
      correlationId: input.correlationId,
      startedAt,
    });

    const counters: Counters = { pages: 0, added: 0, modified: 0, removed: 0, restarts: 0 };
    let failure: ConnectorError | null = null;
    let cursorAfter = row.transactionsCursor;

    try {
      const handle = await openHandle(row, secretBox, input.userId);
      cursorAfter = await this.#runPages(handle, connector, {
        connectionId: row.id,
        syncRunId,
        startCursor: row.transactionsCursor,
        counters,
        context,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      failure = asConnectorError(cause);
    }

    const finishedAt = clock.now();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const status: SyncRunStatus =
      failure === null ? 'success' : counters.pages > 0 ? 'partial' : 'failed';

    await database.transaction(async (tx) => {
      await tx
        .update(syncRuns)
        .set({
          status,
          cursorAfter,
          restartCount: counters.restarts,
          errorKind: failure?.kind ?? null,
          errorCode: failure?.condition ?? failure?.providerCode ?? null,
          errorDetail: failure === null ? null : errorDetailOf(failure),
          finishedAt,
          durationMs,
        })
        .where(eq(syncRuns.id, syncRunId));

      await this.#settleStatus(tx, row.id, row.status, failure, context);

      await appendEvent(
        platformOf(tx),
        SyncRunCompleted.create(
          {
            connectionId: row.id,
            syncRunId,
            trigger: input.trigger,
            status,
            pageCount: counters.pages,
            addedCount: counters.added,
            modifiedCount: counters.modified,
            removedCount: counters.removed,
            restartCount: counters.restarts,
            durationMs,
            errorKind: failure?.kind ?? null,
          },
          { userId: input.userId, correlationId: input.correlationId, aggregateId: row.id },
          clock,
        ),
      );
    });

    if (failure !== null) {
      this.#logger.warn(
        {
          connectionId: row.id,
          syncRunId,
          kind: failure.kind,
          condition: failure.condition,
          correlationId: input.correlationId,
        },
        'sync failed',
      );
    }

    return {
      syncRunId,
      connectionId: row.id,
      status,
      pageCount: counters.pages,
      addedCount: counters.added,
      modifiedCount: counters.modified,
      removedCount: counters.removed,
      restartCount: counters.restarts,
      cursorBefore: row.transactionsCursor,
      cursorAfter,
      durationMs,
      error: failure,
      skippedBecause: null,
    };
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Page until `hasMore` is false, restarting as the error's policy directs.
   *
   * The two cursors are the point. `startCursor` is where the *run* began and is
   * what a `page_one` restart returns to; `lastCommitted` is where the last
   * *committed* transaction left off. Confusing them is how "restart the loop"
   * becomes "retry the failed call", which 01 §5.1 says corrupts the stream.
   *
   * `accumulate` is invariant 2: a cursor provider's pages are held until the
   * stream ends and then committed as one delta, a window provider's are
   * committed as they arrive.
   */
  async #runPages(
    handle: ConnectionHandle,
    connector: Connector,
    run: {
      connectionId: string;
      syncRunId: string;
      startCursor: string | null;
      counters: Counters;
      context: ConnectionsContext;
      signal?: AbortSignal;
    },
  ): Promise<string | null> {
    const maxAttempts = this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const capabilities = connector.capabilities();
    // The adapter's own declaration that it hands out a delta stream rather than
    // a window. Not a provider name, and not an inference from "did it return a
    // cursor" — a window adapter may well return a position token.
    const accumulate = supports(capabilities, 'incremental_sync');
    let startCursor = run.startCursor;
    let lastCommitted = run.startCursor;
    let lastFailure: ConnectorError | null = null;

    // Accounts first, every run: an institution can add one at any time, and a
    // page that mentions an account we have never mapped has nowhere to go.
    //
    // The provider call is made *before* the transaction opens, not inside it.
    // A remote call inside a transaction holds a pooled connection for the
    // duration of someone else's network, which turns one slow institution into
    // a pool exhaustion for the whole process.
    const discovered = await connector.listAccounts(handle);
    await this.#options.database.transaction(async (tx) => {
      await linkAccounts(tx, {
        connectionId: run.connectionId,
        provider: connector.provider,
        accounts: discovered,
        ledgerWriter: this.#options.ledgerWriter,
        context: run.context,
      });
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let cursor = startCursor;
      // Held only while `accumulate` is true. Dropped wholesale on a restart,
      // which is the reason nothing has been published that would need undoing.
      const pending: TransactionPage[] = [];
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          run.signal?.throwIfAborted();
          const options = this.#syncOptions(capabilities, run.context.clock, run.signal);
          const fetched = await connector.syncTransactions(
            handle,
            cursor === null ? null : cursorOf(cursor),
            options,
          );

          if (accumulate) {
            pending.push(fetched);
            cursor = fetched.nextCursor;
            if (fetched.hasMore) continue;
            // The stream ended. Everything it said, and the cursor that says we
            // have it, in one transaction.
            lastCommitted = await this.#commitPages(pending, cursor, {
              connectionId: run.connectionId,
              syncRunId: run.syncRunId,
              provider: connector.provider,
              counters: run.counters,
              context: run.context,
            });
            return lastCommitted;
          }

          cursor = await this.#commitPages([fetched], fetched.nextCursor, {
            connectionId: run.connectionId,
            syncRunId: run.syncRunId,
            provider: connector.provider,
            counters: run.counters,
            context: run.context,
          });
          lastCommitted = cursor;
          if (!fetched.hasMore) return cursor;
        }
        throw ConnectorError.fromCondition(
          'MALFORMED_RESPONSE',
          `${connector.provider} returned hasMore after ${MAX_PAGES} pages`,
          { redactedContext: { connectionId: run.connectionId, pages: MAX_PAGES } },
        );
      } catch (cause) {
        const error = asConnectorError(cause);
        lastFailure = error;
        const policy = error.policy();
        if (!policy.retryable || attempt === maxAttempts) throw error;

        if (policy.restart === 'page_one' || policy.restart === 'from_null') {
          // 04 §4.2's MAX_RESTARTS. A stream that keeps mutating under us is a
          // real condition with a real end: report it rather than loop.
          if (run.counters.restarts >= MAX_RESTARTS) throw error;
          // Rewind the *stored* cursor too, not just the loop variable: a crash
          // between here and the first re-applied page must resume from where
          // the restart decided to resume, not from a page in a stream we have
          // already thrown away. A no-op for an accumulating run, which has not
          // moved the stored cursor at all — and cheap enough to do
          // unconditionally rather than to branch on and get wrong.
          startCursor = policy.restart === 'from_null' ? null : run.startCursor;
          lastCommitted = startCursor;
          run.counters.restarts += 1;
          await this.#rewind(run.connectionId, startCursor, run.context.clock);
        } else {
          // A retryable failure that is not a restart: resume where the last
          // committed transaction left off. For an accumulating run that is the
          // cursor the run began with, because nothing has committed yet.
          startCursor = lastCommitted;
        }
        await this.#sleep(attempt, error);
      }
    }

    // Unreachable: the loop either returns, or throws on the last attempt.
    throw lastFailure ?? new ConnectionsError('connections.sync_exhausted', 'sync loop exhausted');
  }

  /**
   * One delta, one transaction. The correctness core.
   *
   * Inside a single `BEGIN`/`COMMIT`: every page's accounts are mapped, its
   * transactions are applied to the ledger per account, the running counts are
   * updated, and the cursor advances to `cursor`. Nothing between those is a
   * place where a crash can separate the data from the cursor that says we have
   * it, which is what makes "inject a failure mid-pagination" observable as
   * *nothing changed* rather than as a partial delta.
   *
   * The pages are applied **in order** rather than merged first. A page that
   * retracts a row an earlier page added has to be applied after it, and a
   * merged `{added, removed}` would leave the outcome to whatever order the
   * ledger happens to process the two lists in.
   *
   * The counters are mutated only after the callback's last `await`, so a
   * rollback cannot leave the in-memory count claiming rows that no longer
   * exist.
   */
  async #commitPages(
    pages: readonly TransactionPage[],
    // A `string`, not a `Cursor`: this is the value that goes into the column,
    // and the brand exists to stop a `providerTransactionId` being passed to an
    // *adapter* where a cursor belongs. Re-branding it here would be ceremony.
    cursor: string | null,
    run: {
      connectionId: string;
      syncRunId: string;
      provider: string;
      counters: Counters;
      context: ConnectionsContext;
    },
  ): Promise<string | null> {
    const { ledgerWriter, clock } = this.#options;
    const { context } = run;

    const committed = await this.#options.database.transaction(async (tx) => {
      let added = 0;
      let modified = 0;
      let removed = 0;

      for (const page of pages) {
        if (page.accounts.length > 0) {
          await linkAccounts(tx, {
            connectionId: run.connectionId,
            provider: run.provider,
            accounts: page.accounts,
            ledgerWriter,
            context,
          });
        }

        // Re-read per page: a later page may have introduced an account the
        // earlier map did not have.
        const accounts = await accountMap(tx, run.connectionId);
        for (const [accountId, slice] of groupByAccount(page, accounts, run.provider)) {
          const result = await ledgerWriter.applyProviderTransactions(tx, {
            userId: context.userId,
            accountId,
            provider: run.provider,
            added: slice.added,
            modified: slice.modified,
            removed: slice.removed,
            clock,
            correlationId: context.correlationId,
            causationId: context.causationId ?? null,
          });
          added += result.addedTransactionIds.length;
          modified += result.updatedTransactionIds.length;
          removed += result.removedTransactionIds.length;
        }
      }

      const now = clock.now();
      await tx
        .update(connections)
        .set({ transactionsCursor: cursor, lastSyncedAt: now, updatedAt: now })
        .where(eq(connections.id, run.connectionId));

      // `sql` increments rather than a read-modify-write: the row is ours, but
      // an increment is honest about what it means, and it keeps a window
      // provider's per-page commits additive.
      await tx
        .update(syncRuns)
        .set({
          pageCount: sql`${syncRuns.pageCount} + ${pages.length}`,
          addedCount: sql`${syncRuns.addedCount} + ${added}`,
          modifiedCount: sql`${syncRuns.modifiedCount} + ${modified}`,
          removedCount: sql`${syncRuns.removedCount} + ${removed}`,
          cursorAfter: cursor,
        })
        .where(eq(syncRuns.id, run.syncRunId));

      return { added, modified, removed };
    });

    run.counters.pages += pages.length;
    run.counters.added += committed.added;
    run.counters.modified += committed.modified;
    run.counters.removed += committed.removed;
    return cursor;
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  /**
   * Would this call be rude, or wasted?
   *
   * 08 §3.7 puts both checks before `sync` is called: `minSyncIntervalSeconds`
   * is the politeness floor, `refreshBudgetPerDay` is the provider's own cap
   * (SimpleFIN's is ~24, and exceeding it disables the token — 01 §2.2). A
   * `manual` trigger bypasses the interval floor because the user is standing
   * there watching, but never the budget, because spending the last request on
   * an impatient click is how the nightly sync fails.
   */
  async #preflight(
    connectionId: string,
    lastSyncedAt: Date | null,
    capabilities: { minSyncIntervalSeconds: number; refreshBudgetPerDay: number | null },
    trigger: SyncTrigger,
  ): Promise<SyncRunSummary['skippedBecause']> {
    const now = this.#options.clock.now();

    if (
      trigger === 'scheduled' &&
      lastSyncedAt !== null &&
      capabilities.minSyncIntervalSeconds > 0 &&
      now.getTime() - lastSyncedAt.getTime() < capabilities.minSyncIntervalSeconds * 1_000
    ) {
      return 'min_interval';
    }

    if (capabilities.refreshBudgetPerDay !== null) {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
      const spent = await this.#options.database
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(and(eq(syncRuns.connectionId, connectionId), gte(syncRuns.startedAt, since)));
      if (spent.length >= capabilities.refreshBudgetPerDay) return 'refresh_budget';
    }

    return null;
  }

  /** What the connection's status becomes once the run is over. */
  async #settleStatus(
    executor: ConnectionsExecutor,
    connectionId: string,
    current: string,
    failure: ConnectorError | null,
    context: ConnectionsContext,
  ): Promise<void> {
    if (failure === null) {
      if (current === 'active') return;
      await setConnectionStatus(executor, { connectionId, to: 'active' }, context);
      return;
    }

    const policy = failure.policy();
    await setConnectionStatus(
      executor,
      {
        connectionId,
        // `auth_required` is the one the user can act on, and the one that must
        // stop the schedule. Everything else is `error`: still scheduled, still
        // backing off, visible in the history.
        to: failure.kind === 'auth_required' ? 'reauth_required' : 'error',
        reason: failure.kind,
        providerCode: failure.providerCode,
        lastError: { ...errorDetailOf(failure), userActionRequired: policy.userActionRequired },
      },
      context,
    );
  }

  /** Put the stored cursor back, in its own transaction. See `#runPages`. */
  async #rewind(connectionId: string, cursor: string | null, clock: Clock): Promise<void> {
    await this.#options.database
      .update(connections)
      .set({ transactionsCursor: cursor, updatedAt: clock.now() })
      .where(eq(connections.id, connectionId));
  }

  /**
   * How long to wait before the next attempt.
   *
   * The provider's own `retryAfterMs` wins when it gave one — a 429 that says
   * "in 30 seconds" means 30 seconds, and guessing longer wastes the window
   * while guessing shorter earns another 429. Otherwise full jitter, capped at
   * six hours, from `@core/platform` rather than a second implementation here.
   */
  async #sleep(attempt: number, error: ConnectorError): Promise<void> {
    const options = this.#options.backoff ?? DEFAULT_JOB_BACKOFF;
    const delay =
      error.retryAfterMs ?? backoffDelayMs(attempt, options, this.#options.random ?? Math.random);
    await this.#sleeper.sleep(Math.min(delay, options.maxMs));
  }

  #syncOptions(
    capabilities: { historyWindowDays: number | 'unbounded' },
    clock: Clock,
    signal: AbortSignal | undefined,
  ): SyncOptions {
    const requested = this.#options.historyDays ?? DEFAULT_HISTORY_DAYS;
    return {
      reason: 'scheduled',
      historyDays:
        capabilities.historyWindowDays === 'unbounded'
          ? requested
          : Math.min(requested, capabilities.historyWindowDays),
      pageSize: this.#options.pageSize ?? DEFAULT_PAGE_SIZE,
      deadline: new Date(clock.nowMs() + (this.#options.deadlineMs ?? DEFAULT_DEADLINE_MS)),
      signal: signal ?? neverAborts(),
      clock,
    };
  }
}

/**
 * The fan-out job the nightly schedule fires.
 *
 * A schedule enqueues one job; that job enqueues one per connection. The
 * alternative — a schedule per connection — means the scheduler table grows with
 * the user's institutions and a newly linked bank does not sync until something
 * remembers to add a row.
 */
export const SYNC_FANOUT_JOB_KIND = 'connections.sync_all';

export function syncAllJob(
  orchestrator: SyncOrchestrator,
  listConnectionIds: (executor: ConnectionsExecutor, userId: string) => Promise<readonly string[]>,
  database: ConnectionsDatabase,
): JobHandlerRegistration {
  return defineJob(SYNC_FANOUT_JOB_KIND, async (_payload, context) => {
    await database.transaction(async (tx) => {
      for (const connectionId of await listConnectionIds(tx, context.userId)) {
        await orchestrator.syncNow(tx, {
          connectionId,
          userId: context.userId,
          trigger: 'scheduled',
          correlationId: context.correlationId,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AccountSlice {
  added: ProviderTransactionFact[];
  modified: ProviderTransactionFact[];
  removed: string[];
}

/**
 * Split a page by account, because `applyProviderTransactions` takes one.
 *
 * An id the connection has never mapped is a contract violation, not a row to
 * drop: the adapter is required to volunteer its accounts (`page.accounts`, or
 * `listAccounts`, both of which have already run by the time this is called), so
 * a transaction pointing at an unknown account means the page does not describe
 * the connection we think it does. Dropping it silently would lose real money.
 */
function groupByAccount(
  page: TransactionPage,
  accounts: ReadonlyMap<string, string>,
  provider: string,
): Map<string, AccountSlice> {
  const byAccount = new Map<string, AccountSlice>();
  const unknown = new Set<string>();

  const slice = (providerAccountId: string): AccountSlice | null => {
    const accountId = accounts.get(providerAccountId);
    if (accountId === undefined) {
      unknown.add(providerAccountId);
      return null;
    }
    const existing = byAccount.get(accountId);
    if (existing !== undefined) return existing;
    const fresh: AccountSlice = { added: [], modified: [], removed: [] };
    byAccount.set(accountId, fresh);
    return fresh;
  };

  for (const fact of page.added) slice(fact.providerAccountId)?.added.push(fact);
  for (const fact of page.modified) slice(fact.providerAccountId)?.modified.push(fact);
  for (const ref of page.removed)
    slice(ref.providerAccountId)?.removed.push(ref.providerTransactionId);

  if (unknown.size > 0) {
    throw ConnectorError.fromCondition(
      'MALFORMED_RESPONSE',
      `${provider} returned transactions for ${unknown.size} account(s) it never listed`,
      // Count only. A provider account id is an identifier for one of the user's
      // bank accounts and does not belong in a column the UI renders.
      { redactedContext: { provider, unknownAccountCount: unknown.size } },
    );
  }
  return byAccount;
}

function errorDetailOf(error: ConnectorError): Record<string, unknown> {
  return {
    kind: error.kind,
    condition: error.condition,
    providerCode: error.providerCode,
    message: error.message,
    context: error.redactedContext,
  };
}

function blank(
  connectionId: string,
  cursor: string | null,
  skippedBecause: SyncRunSummary['skippedBecause'],
): SyncRunSummary {
  return {
    syncRunId: null,
    connectionId,
    status: 'skipped',
    pageCount: 0,
    addedCount: 0,
    modifiedCount: 0,
    removedCount: 0,
    restartCount: 0,
    cursorBefore: cursor,
    cursorAfter: cursor,
    durationMs: 0,
    error: null,
    skippedBecause,
  };
}

/** A signal that never fires, for a caller that supplied none. */
function neverAborts(): AbortSignal {
  return new AbortController().signal;
}
