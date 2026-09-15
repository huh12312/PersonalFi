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
 * | Module               | Events | Consumers | Jobs                                | Schedule |
 * | -------------------- | ------ | --------- | ----------------------------------- | -------- |
 * | `module.ledger`      | 5      | —         | —                                   | —        |
 * | `module.connections` | 3      | —         | `connections.sync`, `…sync_all`     | nightly  |
 *
 * The Ledger registers **no consumer**, deliberately. It is the writer: it
 * states facts and reacts to none. The empty column is the shape of 08 §1.3's
 * "one event, one owner" and not an omission.
 */
import {
  CONNECTIONS_EVENTS,
  listSyncableConnections,
  syncAllJob,
  type ConnectionsDatabase,
  type ConnectionsExecutor,
  type SyncOrchestrator,
} from '@ctx/connections';
import { LEDGER_EVENTS } from '@ctx/ledger';
import type { ModuleRegistration } from './platform.ts';

export interface ModuleWiringOptions {
  readonly database: ConnectionsDatabase;
  readonly orchestrator: SyncOrchestrator;
  /**
   * The account holder's display timezone.
   *
   * 03:15 **local**, per 08 §3.7 — never the container's `TZ`. A nightly sync
   * that fires at 03:15 UTC for a user in UTC-5 runs at 22:15 their time, which
   * is neither quiet hours nor the start of a banking day.
   */
  readonly timezone: string;
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
  const { database, orchestrator } = options;
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
  ];
}
