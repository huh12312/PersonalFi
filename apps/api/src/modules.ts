// SPDX-License-Identifier: MIT
/**
 * `MODULES` — every bounded context this application runs, and what each brings.
 *
 * One list, built the same way in the API and in the worker, so "which events
 * exist" and "which module is on" cannot differ between the two processes. A
 * module whose flag is off contributes no events, no consumers, no job handlers
 * and no schedules: it costs nothing at runtime and cannot half-fill a read
 * model nobody is reading (08 §6.9).
 *
 * What each module contributes in Phase 1:
 *
 * | Module                  | Events | Consumers                          | Jobs                            | Schedule |
 * | ----------------------- | ------ | ----------------------------------- | -------------------------------- | -------- |
 * | `module.ledger`         | 5      | —                                   | —                                | —        |
 * | `module.connections`    | 3      | —                                   | `connections.sync`, `…sync_all` | nightly  |
 * | `module.categorization` | 3      | `categorization.assignments@v1`    | —                                | —        |
 *
 * The Ledger registers **no consumer**, deliberately. It is the writer: it
 * states facts and reacts to none. Categorization is the first module here that
 * *does* — it reacts to `ledger.TransactionsUpserted` /
 * `ledger.TransactionSupersededByPosted` and writes its own tables plus, for a
 * winning rule decision only, one column back in `@ctx/ledger` through the
 * `LedgerPort` `apps/api/src/domain.ts` implements (wp1.4 evidence §6).
 */
import {
  CATEGORIZATION_EVENTS,
  createCategorizationConsumer,
  type CategorizationDatabase,
} from '@ctx/categorization';
import {
  CONNECTIONS_EVENTS,
  listSyncableConnections,
  syncAllJob,
  type ConnectionsDatabase,
  type ConnectionsExecutor,
  type SyncOrchestrator,
} from '@ctx/connections';
import { LEDGER_EVENTS } from '@ctx/ledger';
import { systemClock, type Clock } from '@core/kernel';
import { createCategorizationLedgerPort } from './domain.ts';
import type { ModuleRegistration } from './platform.ts';

export interface ModuleWiringOptions {
  /**
   * One pool-backed handle, shared across every context's own typed alias
   * (`ConnectionsDatabase`, `LedgerDatabase`, `CategorizationDatabase` are all
   * `@core/db`'s `Database`) — every bounded context lives in one Postgres
   * instance (docs/CONVENTIONS.md's table-ownership model), so this is one
   * connection pool, not three.
   */
  readonly database: ConnectionsDatabase & CategorizationDatabase;
  readonly orchestrator: SyncOrchestrator;
  /**
   * The account holder's display timezone.
   *
   * 03:15 **local**, per 08 §3.7 — never the container's `TZ`. A nightly sync
   * that fires at 03:15 UTC for a user in UTC-5 runs at 22:15 their time, which
   * is neither quiet hours nor the start of a banking day.
   */
  readonly timezone: string;
  /** Defaults to `systemClock`; a caller only overrides it in a test. */
  readonly clock?: Clock;
}

/** Connections the nightly fan-out should touch: `reauth_required` is skipped. */
async function syncableConnectionIds(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<readonly string[]> {
  const rows = await listSyncableConnections(executor, userId);
  return rows.map((row) => row.id);
}

export function appModules(options: ModuleWiringOptions): readonly ModuleRegistration[] {
  const { database, orchestrator, clock = systemClock } = options;
  return [
    { flagKey: 'module.ledger', events: LEDGER_EVENTS },
    {
      flagKey: 'module.connections',
      events: CONNECTIONS_EVENTS,
      jobs: [
        orchestrator.jobHandler(),
        // A schedule enqueues one job; that job enqueues one per connection. The
        // alternative — a schedule row per connection — means the scheduler table
        // grows with the user's institutions and a newly linked bank does not
        // sync until something remembers to add a row.
        syncAllJob(orchestrator, syncableConnectionIds, database),
      ],
      schedules: async (userId: string): Promise<void> => {
        await orchestrator.registerNightlySchedule(database, {
          userId,
          timezone: options.timezone,
        });
      },
    },
    {
      flagKey: 'module.categorization',
      events: CATEGORIZATION_EVENTS,
      // Sync-triggered only, per WP 1.4 §5's decision order: `decide()` is a pure
      // function of current state, so a re-run is safe, and the consumer's own
      // `run_on_sync` filter (`loadRules`) is what keeps a rule that should only
      // apply retroactively from firing on every incoming page.
      consumers: [
        createCategorizationConsumer({
          database,
          port: createCategorizationLedgerPort(database, clock),
        }),
      ],
    },
  ];
}
