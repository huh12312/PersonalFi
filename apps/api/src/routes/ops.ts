// SPDX-License-Identifier: MIT
/**
 * `/ops/backup-status` — CF-17, D24, 09 §5.7
 * (docs/plan/09-phase-9-dispatch.md §3 "WP 9.1").
 *
 * D24 asked for "the restore drill result shows on the in-app dashboard" and
 * 09 §5.7 for "the app reports last successful backup age". Both have lived,
 * since Phase 0, only in the `backup` container's own `/tmp/backup-status`
 * file and a committed markdown drill report — unreadable by the api, and
 * gone the moment the container restarts (`docker/backup/backup.sh`:60; no
 * reference anywhere in `apps/web/src`). This route is the fix: it reads
 * `ops_backup_runs`/`ops_restore_drills` (migration `0036_ops_status.sql`,
 * `@core/platform/schema`) and answers with the newest successful backup's
 * age and the newest restore drill's verdict and age.
 *
 * ## Session, not step-up, and no `userId` anywhere in the answer
 *
 * A backup or a restore drill is a fact about the *deployment*, not about
 * any one account holder — the same install-wide footing `ops_backup_runs`
 * and `ops_restore_drills` already stand on in `@core/platform`'s
 * OWNERSHIP.md. `requireSession` keeps an unauthenticated prober from
 * learning anything about the install's backup posture at all, but the
 * query itself carries no `WHERE user_id = …` and the response has no field
 * that could be another holder's — there is nothing here for a cross-user
 * scoping bug to leak, and the exit test proves exactly that: a second
 * holder's session reads the identical, install-wide answer.
 *
 * ## Why this file imports only `@core/platform`
 *
 * `backupStatus` (the query) lives in `@core/platform` precisely so this
 * route never needs to: it imports no context, and the only other imports
 * here are this app's own route plumbing (`RouteDeps`, `problems`) and
 * `zod`/Fastify's types — 09 §4 wiring batch 2's own note on this file.
 */
import { backupStatus, platformExecutor } from '@core/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './deps.ts';
import { problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';

const backupStatusResponse = z
  .object({
    lastAttemptStatus: z.enum(['ok', 'fail']).nullable(),
    lastAttemptAt: isoInstant.nullable(),
    lastSuccessfulBackupAt: isoInstant.nullable(),
    lastSuccessfulBackupAgeSeconds: z.int().nullable(),
    backupOverdue: z.boolean(),
    lastDrillVerdict: z.enum(['pass', 'fail']).nullable(),
    lastDrillAt: isoInstant.nullable(),
    lastDrillAgeDays: z.int().nullable(),
    drillOverdue: z.boolean(),
  })
  .meta({ id: 'OpsBackupStatus' });

export const opsRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const executor = platformExecutor(database);

  return async (app) => {
    app.get(
      '/ops/backup-status',
      {
        schema: {
          operationId: 'getOpsBackupStatus',
          summary: 'Backup and restore-drill status (D24, CF-17)',
          description:
            'Install-wide, not account-holder data: the newest successful backup’s age and ' +
            'the newest restore drill’s verdict and age. `backupOverdue` turns true past the ' +
            'nightly cadence’s staleness window (or with no successful backup at all); ' +
            '`drillOverdue` turns true past 35 days since the last drill (or with no drill at all).',
          tags: ['system'],
          response: { 200: backupStatusResponse, ...problems(401) },
        },
      },
      async (request) => {
        await guards.requireSession(request);
        return backupStatus(executor, clock);
      },
    );
  };
};
